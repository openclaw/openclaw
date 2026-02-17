import crypto from "node:crypto";
import {
  browserAct,
  browserArmDialog,
  browserArmFileChooser,
  browserConsoleMessages,
  browserNavigate,
  browserPdfSave,
  browserScreenshotAction,
} from "../../browser/client-actions.js";
import {
  browserCloseTab,
  browserFocusTab,
  browserOpenTab,
  browserProfiles,
  browserSnapshot,
  browserStart,
  browserStatus,
  browserStop,
  browserTabs,
} from "../../browser/client.js";
import { resolveBrowserConfig } from "../../browser/config.js";
import { DEFAULT_AI_SNAPSHOT_MAX_CHARS } from "../../browser/constants.js";
import { loadConfig } from "../../config/config.js";
import { saveMediaBuffer } from "../../media/store.js";
import { BrowserToolSchema } from "./browser-tool.schema.js";
import { type AnyAgentTool, imageResultFromFile, jsonResult, readStringParam } from "./common.js";
import { callGatewayTool } from "./gateway.js";
import { listNodes, resolveNodeIdFromList, type NodeListNode } from "./nodes-utils.js";

type BrowserProxyFile = {
  path: string;
  base64: string;
  mimeType?: string;
};

type BrowserProxyResult = {
  result: unknown;
  files?: BrowserProxyFile[];
};

const DEFAULT_BROWSER_PROXY_TIMEOUT_MS = 20_000;

type BrowserNodeTarget = {
  nodeId: string;
  label?: string;
};

function isBrowserNode(node: NodeListNode) {
  const caps = Array.isArray(node.caps) ? node.caps : [];
  const commands = Array.isArray(node.commands) ? node.commands : [];
  return caps.includes("browser") || commands.includes("browser.proxy");
}

async function resolveBrowserNodeTarget(params: {
  requestedNode?: string;
  target?: "sandbox" | "host" | "node";
  sandboxBridgeUrl?: string;
}): Promise<BrowserNodeTarget | null> {
  const cfg = loadConfig();
  const policy = cfg.gateway?.nodes?.browser;
  const mode = policy?.mode ?? "auto";
  if (mode === "off") {
    if (params.target === "node" || params.requestedNode) {
      throw new Error("Node browser proxy is disabled (gateway.nodes.browser.mode=off).");
    }
    return null;
  }
  if (params.sandboxBridgeUrl?.trim() && params.target !== "node" && !params.requestedNode) {
    return null;
  }
  if (params.target && params.target !== "node") {
    return null;
  }
  if (mode === "manual" && params.target !== "node" && !params.requestedNode) {
    return null;
  }

  const nodes = await listNodes({});
  const browserNodes = nodes.filter((node) => node.connected && isBrowserNode(node));
  if (browserNodes.length === 0) {
    if (params.target === "node" || params.requestedNode) {
      throw new Error("No connected browser-capable nodes.");
    }
    return null;
  }

  const requested = params.requestedNode?.trim() || policy?.node?.trim();
  if (requested) {
    const nodeId = resolveNodeIdFromList(browserNodes, requested, false);
    const node = browserNodes.find((entry) => entry.nodeId === nodeId);
    return { nodeId, label: node?.displayName ?? node?.remoteIp ?? nodeId };
  }

  if (params.target === "node") {
    if (browserNodes.length === 1) {
      const node = browserNodes[0];
      return { nodeId: node.nodeId, label: node.displayName ?? node.remoteIp ?? node.nodeId };
    }
    throw new Error(
      `Multiple browser-capable nodes connected (${browserNodes.length}). Set gateway.nodes.browser.node or pass node=<id>.`,
    );
  }

  if (mode === "manual") {
    return null;
  }

  if (browserNodes.length === 1) {
    const node = browserNodes[0];
    return { nodeId: node.nodeId, label: node.displayName ?? node.remoteIp ?? node.nodeId };
  }
  return null;
}

async function callBrowserProxy(params: {
  nodeId: string;
  method: string;
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  timeoutMs?: number;
  profile?: string;
}): Promise<BrowserProxyResult> {
  const gatewayTimeoutMs =
    typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)
      ? Math.max(1, Math.floor(params.timeoutMs))
      : DEFAULT_BROWSER_PROXY_TIMEOUT_MS;
  const payload = await callGatewayTool<{ payloadJSON?: string; payload?: string }>(
    "node.invoke",
    { timeoutMs: gatewayTimeoutMs },
    {
      nodeId: params.nodeId,
      command: "browser.proxy",
      params: {
        method: params.method,
        path: params.path,
        query: params.query,
        body: params.body,
        timeoutMs: params.timeoutMs,
        profile: params.profile,
      },
      idempotencyKey: crypto.randomUUID(),
    },
  );
  const parsed =
    payload?.payload ??
    (typeof payload?.payloadJSON === "string" && payload.payloadJSON
      ? (JSON.parse(payload.payloadJSON) as BrowserProxyResult)
      : null);
  if (!parsed || typeof parsed !== "object" || !("result" in parsed)) {
    throw new Error("browser proxy failed");
  }
  return parsed;
}

async function persistProxyFiles(files: BrowserProxyFile[] | undefined) {
  if (!files || files.length === 0) {
    return new Map<string, string>();
  }
  const mapping = new Map<string, string>();
  for (const file of files) {
    const buffer = Buffer.from(file.base64, "base64");
    const saved = await saveMediaBuffer(buffer, file.mimeType, "browser", buffer.byteLength);
    mapping.set(file.path, saved.path);
  }
  return mapping;
}

function applyProxyPaths(result: unknown, mapping: Map<string, string>) {
  if (!result || typeof result !== "object") {
    return;
  }
  const obj = result as Record<string, unknown>;
  if (typeof obj.path === "string" && mapping.has(obj.path)) {
    obj.path = mapping.get(obj.path);
  }
  if (typeof obj.imagePath === "string" && mapping.has(obj.imagePath)) {
    obj.imagePath = mapping.get(obj.imagePath);
  }
  const download = obj.download;
  if (download && typeof download === "object") {
    const d = download as Record<string, unknown>;
    if (typeof d.path === "string" && mapping.has(d.path)) {
      d.path = mapping.get(d.path);
    }
  }
}

function resolveBrowserBaseUrl(params: {
  target?: "sandbox" | "host";
  sandboxBridgeUrl?: string;
  allowHostControl?: boolean;
}): string | undefined {
  const cfg = loadConfig();
  const resolved = resolveBrowserConfig(cfg.browser, cfg);
  const normalizedSandbox = params.sandboxBridgeUrl?.trim() ?? "";
  const target = params.target ?? (normalizedSandbox ? "sandbox" : "host");

  if (target === "sandbox") {
    if (!normalizedSandbox) {
      throw new Error(
        'Sandbox browser is unavailable. Enable agents.defaults.sandbox.browser.enabled or use target="host" if allowed.',
      );
    }
    return normalizedSandbox.replace(/\/$/, "");
  }

  if (params.allowHostControl === false) {
    throw new Error("Host browser control is disabled by sandbox policy.");
  }
  if (!resolved.enabled) {
    throw new Error(
      "Browser control is disabled. Set browser.enabled=true in ~/.openclaw/openclaw.json.",
    );
  }
  return undefined;
}

export function createBrowserTool(opts?: {
  sandboxBridgeUrl?: string;
  allowHostControl?: boolean;
}): AnyAgentTool {
  const cfg = loadConfig();
  const resolvedBrowser = resolveBrowserConfig(cfg.browser, cfg);
  const defaultBrowserProfile = resolvedBrowser.defaultProfile;
  const targetDefault = opts?.sandboxBridgeUrl ? "sandbox" : "host";
  const hostHint =
    opts?.allowHostControl === false ? "Host target blocked by policy." : "Host target allowed.";
  return {
    label: "Browser",
    name: "browser",
    description: [
      "Control the browser via OpenClaw's browser control server (status/start/stop/profiles/tabs/open/snapshot/screenshot/actions).",
      `Profiles: omit profile to use browser.defaultProfile (currently "${defaultBrowserProfile}") for direct CDP control. Use profile="chrome" only when the user explicitly asks for Browser Relay extension flow. Use profile="openclaw" for the isolated openclaw-managed browser.`,
      'Only use profile="chrome" when the user explicitly asks for Browser Relay extension flow; otherwise use browser.defaultProfile.',
      'When a node-hosted browser proxy is available, the tool may auto-route to it. Pin a node with node=<id|name> or target="node".',
      'For Browser Relay (profile="chrome"), user must attach a tab via toolbar badge ON. For normal workflows prefer browser.defaultProfile direct CDP first.',
      "When using refs from snapshot (e.g. e12), keep the same tab: prefer passing targetId from the snapshot response into subsequent actions (act/click/type/etc).",
      'For stable, self-resolving refs across calls, use snapshot with refs="aria" (Playwright aria-ref ids). Default refs="role" are role+name-based.',
      "Use snapshot+act for UI automation. Avoid act:wait by default; use only in exceptional cases when no reliable UI state exists.",
      `target selects browser location (sandbox|host|node). Default: ${targetDefault}.`,
      hostHint,
    ].join(" "),
    parameters: BrowserToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      const profile = readStringParam(params, "profile");
      const requestedNode = readStringParam(params, "node");
      let target = readStringParam(params, "target") as "sandbox" | "host" | "node" | undefined;

      if (requestedNode && target && target !== "node") {
        throw new Error('node is only supported with target="node".');
      }

      if (!target && !requestedNode && profile === "chrome") {
        // Chrome extension relay takeover is a host Chrome feature; prefer host unless explicitly targeting a node.
        target = "host";
      }

      const nodeTarget = await resolveBrowserNodeTarget({
        requestedNode: requestedNode ?? undefined,
        target,
        sandboxBridgeUrl: opts?.sandboxBridgeUrl,
      });

      const resolvedTarget = target === "node" ? undefined : target;
      const baseUrl = nodeTarget
        ? undefined
        : resolveBrowserBaseUrl({
            target: resolvedTarget,
            sandboxBridgeUrl: opts?.sandboxBridgeUrl,
            allowHostControl: opts?.allowHostControl,
          });

      const proxyRequest = nodeTarget
        ? async (opts: {
            method: string;
            path: string;
            query?: Record<string, string | number | boolean | undefined>;
            body?: unknown;
            timeoutMs?: number;
            profile?: string;
          }) => {
            const proxy = await callBrowserProxy({
              nodeId: nodeTarget.nodeId,
              method: opts.method,
              path: opts.path,
              query: opts.query,
              body: opts.body,
              timeoutMs: opts.timeoutMs,
              profile: opts.profile,
            });
            const mapping = await persistProxyFiles(proxy.files);
            applyProxyPaths(proxy.result, mapping);
            return proxy.result;
          }
        : null;
      const normalizeProfile = (raw?: string) => {
        const value = typeof raw === "string" ? raw.trim() : "";
        return value.length > 0 ? value : undefined;
      };
      const normalizedDefaultProfile = normalizeProfile(defaultBrowserProfile);
      const isLikelyCdpUnavailableError = (err: unknown): boolean => {
        const msg = String(err).toLowerCase();
        if (!msg) {
          return false;
        }
        return (
          (msg.includes("cdp") &&
            (msg.includes("not reachable") ||
              msg.includes("is unreachable") ||
              msg.includes("unavailable") ||
              msg.includes("connect") ||
              msg.includes("refused") ||
              msg.includes("timeout") ||
              msg.includes("timed out"))) ||
          msg.includes("browser is unavailable") ||
          msg.includes("connection timeout") ||
          msg.includes("econnrefused")
        );
      };
      const buildCdpFallbackProfiles = (currentProfile: string | undefined): string[] => {
        const seen = new Set<string>();
        const out: string[] = [];
        for (const candidate of [normalizedDefaultProfile, "main", "openclaw"]) {
          const normalized = normalizeProfile(candidate);
          if (!normalized || normalized === currentProfile || seen.has(normalized)) {
            continue;
          }
          seen.add(normalized);
          out.push(normalized);
        }
        return out;
      };
      const withCdpFallback = async <T>(
        initialProfile: string | undefined,
        runForProfile: (effectiveProfile: string | undefined) => Promise<T>,
      ): Promise<T> => {
        const normalizedInitial = normalizeProfile(initialProfile);
        try {
          return await runForProfile(normalizedInitial);
        } catch (err) {
          if (requestedNode || target === "node") {
            throw err;
          }
          if (!isLikelyCdpUnavailableError(err)) {
            throw err;
          }
          const shouldTryFallback =
            !normalizedInitial ||
            normalizedInitial === "main" ||
            normalizedInitial === normalizedDefaultProfile;
          if (!shouldTryFallback) {
            throw err;
          }
          const fallbackProfiles = buildCdpFallbackProfiles(normalizedInitial);
          let lastError: unknown = err;
          for (const fallbackProfile of fallbackProfiles) {
            try {
              return await runForProfile(fallbackProfile);
            } catch (fallbackErr) {
              if (!isLikelyCdpUnavailableError(fallbackErr)) {
                throw fallbackErr;
              }
              lastError = fallbackErr;
            }
          }
          const triedProfiles = [normalizedInitial ?? "(default)", ...fallbackProfiles].join(", ");
          throw new Error(
            `Browser CDP is currently unreachable. Tried profiles: ${triedProfiles}. If this persists, use Chrome DevTools MCP or browser-use as fallback.`,
            { cause: err },
          );
        }
      };

      switch (action) {
        case "status":
          if (proxyRequest) {
            return jsonResult(
              await withCdpFallback(
                profile,
                async (effectiveProfile) =>
                  await proxyRequest({
                    method: "GET",
                    path: "/",
                    profile: effectiveProfile,
                  }),
              ),
            );
          }
          return jsonResult(
            await withCdpFallback(
              profile,
              async (effectiveProfile) =>
                await browserStatus(baseUrl, { profile: effectiveProfile }),
            ),
          );
        case "start":
          if (proxyRequest) {
            await proxyRequest({
              method: "POST",
              path: "/start",
              profile,
            });
            return jsonResult(
              await proxyRequest({
                method: "GET",
                path: "/",
                profile,
              }),
            );
          }
          await browserStart(baseUrl, { profile });
          return jsonResult(await browserStatus(baseUrl, { profile }));
        case "stop":
          if (proxyRequest) {
            await proxyRequest({
              method: "POST",
              path: "/stop",
              profile,
            });
            return jsonResult(
              await proxyRequest({
                method: "GET",
                path: "/",
                profile,
              }),
            );
          }
          await browserStop(baseUrl, { profile });
          return jsonResult(await browserStatus(baseUrl, { profile }));
        case "profiles":
          if (proxyRequest) {
            const result = await proxyRequest({
              method: "GET",
              path: "/profiles",
            });
            return jsonResult(result);
          }
          return jsonResult({ profiles: await browserProfiles(baseUrl) });
        case "tabs":
          if (proxyRequest) {
            const result = await withCdpFallback(
              profile,
              async (effectiveProfile) =>
                await proxyRequest({
                  method: "GET",
                  path: "/tabs",
                  profile: effectiveProfile,
                }),
            );
            const tabs = (result as { tabs?: unknown[] }).tabs ?? [];
            return jsonResult({ tabs });
          }
          return jsonResult({
            tabs: await withCdpFallback(
              profile,
              async (effectiveProfile) => await browserTabs(baseUrl, { profile: effectiveProfile }),
            ),
          });
        case "open": {
          const targetUrl = readStringParam(params, "targetUrl", {
            required: true,
          });
          if (proxyRequest) {
            const result = await withCdpFallback(
              profile,
              async (effectiveProfile) =>
                await proxyRequest({
                  method: "POST",
                  path: "/tabs/open",
                  profile: effectiveProfile,
                  body: { url: targetUrl },
                }),
            );
            return jsonResult(result);
          }
          return jsonResult(
            await withCdpFallback(
              profile,
              async (effectiveProfile) =>
                await browserOpenTab(baseUrl, targetUrl, { profile: effectiveProfile }),
            ),
          );
        }
        case "focus": {
          const targetId = readStringParam(params, "targetId", {
            required: true,
          });
          if (proxyRequest) {
            const result = await proxyRequest({
              method: "POST",
              path: "/tabs/focus",
              profile,
              body: { targetId },
            });
            return jsonResult(result);
          }
          await browserFocusTab(baseUrl, targetId, { profile });
          return jsonResult({ ok: true });
        }
        case "close": {
          const targetId = readStringParam(params, "targetId");
          if (proxyRequest) {
            const result = targetId
              ? await proxyRequest({
                  method: "DELETE",
                  path: `/tabs/${encodeURIComponent(targetId)}`,
                  profile,
                })
              : await proxyRequest({
                  method: "POST",
                  path: "/act",
                  profile,
                  body: { kind: "close" },
                });
            return jsonResult(result);
          }
          if (targetId) {
            await browserCloseTab(baseUrl, targetId, { profile });
          } else {
            await browserAct(baseUrl, { kind: "close" }, { profile });
          }
          return jsonResult({ ok: true });
        }
        case "snapshot": {
          const snapshotDefaults = loadConfig().browser?.snapshotDefaults;
          const format =
            params.snapshotFormat === "ai" || params.snapshotFormat === "aria"
              ? params.snapshotFormat
              : "ai";
          const mode =
            params.mode === "efficient"
              ? "efficient"
              : format === "ai" && snapshotDefaults?.mode === "efficient"
                ? "efficient"
                : undefined;
          const labels = typeof params.labels === "boolean" ? params.labels : undefined;
          const refs = params.refs === "aria" || params.refs === "role" ? params.refs : undefined;
          const hasMaxChars = Object.hasOwn(params, "maxChars");
          const targetId = typeof params.targetId === "string" ? params.targetId.trim() : undefined;
          const limit =
            typeof params.limit === "number" && Number.isFinite(params.limit)
              ? params.limit
              : undefined;
          const maxChars =
            typeof params.maxChars === "number" &&
            Number.isFinite(params.maxChars) &&
            params.maxChars > 0
              ? Math.floor(params.maxChars)
              : undefined;
          const resolvedMaxChars =
            format === "ai"
              ? hasMaxChars
                ? maxChars
                : mode === "efficient"
                  ? undefined
                  : DEFAULT_AI_SNAPSHOT_MAX_CHARS
              : undefined;
          const interactive =
            typeof params.interactive === "boolean" ? params.interactive : undefined;
          const compact = typeof params.compact === "boolean" ? params.compact : undefined;
          const depth =
            typeof params.depth === "number" && Number.isFinite(params.depth)
              ? params.depth
              : undefined;
          const selector = typeof params.selector === "string" ? params.selector.trim() : undefined;
          const frame = typeof params.frame === "string" ? params.frame.trim() : undefined;
          const snapshot = await withCdpFallback(profile, async (effectiveProfile) =>
            proxyRequest
              ? ((await proxyRequest({
                  method: "GET",
                  path: "/snapshot",
                  profile: effectiveProfile,
                  query: {
                    format,
                    targetId,
                    limit,
                    ...(typeof resolvedMaxChars === "number" ? { maxChars: resolvedMaxChars } : {}),
                    refs,
                    interactive,
                    compact,
                    depth,
                    selector,
                    frame,
                    labels,
                    mode,
                  },
                })) as Awaited<ReturnType<typeof browserSnapshot>>)
              : await browserSnapshot(baseUrl, {
                  format,
                  targetId,
                  limit,
                  ...(typeof resolvedMaxChars === "number" ? { maxChars: resolvedMaxChars } : {}),
                  refs,
                  interactive,
                  compact,
                  depth,
                  selector,
                  frame,
                  labels,
                  mode,
                  profile: effectiveProfile,
                }),
          );
          if (snapshot.format === "ai") {
            if (labels && snapshot.imagePath) {
              return await imageResultFromFile({
                label: "browser:snapshot",
                path: snapshot.imagePath,
                extraText: snapshot.snapshot,
                details: snapshot,
              });
            }
            return {
              content: [{ type: "text", text: snapshot.snapshot }],
              details: snapshot,
            };
          }
          return jsonResult(snapshot);
        }
        case "screenshot": {
          const targetId = readStringParam(params, "targetId");
          const fullPage = Boolean(params.fullPage);
          const ref = readStringParam(params, "ref");
          const element = readStringParam(params, "element");
          const type = params.type === "jpeg" ? "jpeg" : "png";
          const result = proxyRequest
            ? ((await proxyRequest({
                method: "POST",
                path: "/screenshot",
                profile,
                body: {
                  targetId,
                  fullPage,
                  ref,
                  element,
                  type,
                },
              })) as Awaited<ReturnType<typeof browserScreenshotAction>>)
            : await browserScreenshotAction(baseUrl, {
                targetId,
                fullPage,
                ref,
                element,
                type,
                profile,
              });
          return await imageResultFromFile({
            label: "browser:screenshot",
            path: result.path,
            details: result,
          });
        }
        case "navigate": {
          const targetUrl = readStringParam(params, "targetUrl", {
            required: true,
          });
          const targetId = readStringParam(params, "targetId");
          if (proxyRequest) {
            const result = await withCdpFallback(
              profile,
              async (effectiveProfile) =>
                await proxyRequest({
                  method: "POST",
                  path: "/navigate",
                  profile: effectiveProfile,
                  body: {
                    url: targetUrl,
                    targetId,
                  },
                }),
            );
            return jsonResult(result);
          }
          return jsonResult(
            await withCdpFallback(
              profile,
              async (effectiveProfile) =>
                await browserNavigate(baseUrl, {
                  url: targetUrl,
                  targetId,
                  profile: effectiveProfile,
                }),
            ),
          );
        }
        case "console": {
          const level = typeof params.level === "string" ? params.level.trim() : undefined;
          const targetId = typeof params.targetId === "string" ? params.targetId.trim() : undefined;
          if (proxyRequest) {
            const result = await withCdpFallback(
              profile,
              async (effectiveProfile) =>
                await proxyRequest({
                  method: "GET",
                  path: "/console",
                  profile: effectiveProfile,
                  query: {
                    level,
                    targetId,
                  },
                }),
            );
            return jsonResult(result);
          }
          return jsonResult(
            await withCdpFallback(
              profile,
              async (effectiveProfile) =>
                await browserConsoleMessages(baseUrl, {
                  level,
                  targetId,
                  profile: effectiveProfile,
                }),
            ),
          );
        }
        case "pdf": {
          const targetId = typeof params.targetId === "string" ? params.targetId.trim() : undefined;
          const result = await withCdpFallback(profile, async (effectiveProfile) =>
            proxyRequest
              ? ((await proxyRequest({
                  method: "POST",
                  path: "/pdf",
                  profile: effectiveProfile,
                  body: { targetId },
                })) as Awaited<ReturnType<typeof browserPdfSave>>)
              : await browserPdfSave(baseUrl, { targetId, profile: effectiveProfile }),
          );
          return {
            content: [{ type: "text", text: `FILE:${result.path}` }],
            details: result,
          };
        }
        case "upload": {
          const paths = Array.isArray(params.paths) ? params.paths.map((p) => String(p)) : [];
          if (paths.length === 0) {
            throw new Error("paths required");
          }
          const ref = readStringParam(params, "ref");
          const inputRef = readStringParam(params, "inputRef");
          const element = readStringParam(params, "element");
          const targetId = typeof params.targetId === "string" ? params.targetId.trim() : undefined;
          const timeoutMs =
            typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)
              ? params.timeoutMs
              : undefined;
          if (proxyRequest) {
            const result = await proxyRequest({
              method: "POST",
              path: "/hooks/file-chooser",
              profile,
              body: {
                paths,
                ref,
                inputRef,
                element,
                targetId,
                timeoutMs,
              },
            });
            return jsonResult(result);
          }
          return jsonResult(
            await browserArmFileChooser(baseUrl, {
              paths,
              ref,
              inputRef,
              element,
              targetId,
              timeoutMs,
              profile,
            }),
          );
        }
        case "dialog": {
          const accept = Boolean(params.accept);
          const promptText = typeof params.promptText === "string" ? params.promptText : undefined;
          const targetId = typeof params.targetId === "string" ? params.targetId.trim() : undefined;
          const timeoutMs =
            typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)
              ? params.timeoutMs
              : undefined;
          if (proxyRequest) {
            const result = await proxyRequest({
              method: "POST",
              path: "/hooks/dialog",
              profile,
              body: {
                accept,
                promptText,
                targetId,
                timeoutMs,
              },
            });
            return jsonResult(result);
          }
          return jsonResult(
            await browserArmDialog(baseUrl, {
              accept,
              promptText,
              targetId,
              timeoutMs,
              profile,
            }),
          );
        }
        case "act": {
          const request = params.request as Record<string, unknown> | undefined;
          if (!request || typeof request !== "object") {
            throw new Error("request required");
          }
          const result = await withCdpFallback(profile, async (effectiveProfile) => {
            try {
              return proxyRequest
                ? await proxyRequest({
                    method: "POST",
                    path: "/act",
                    profile: effectiveProfile,
                    body: request,
                  })
                : await browserAct(baseUrl, request as Parameters<typeof browserAct>[1], {
                    profile: effectiveProfile,
                  });
            } catch (err) {
              const msg = String(err);
              if (
                msg.includes("404:") &&
                msg.includes("tab not found") &&
                effectiveProfile === "chrome"
              ) {
                const requestTargetId =
                  typeof (request as { targetId?: unknown }).targetId === "string"
                    ? ((request as { targetId?: string }).targetId?.trim() ?? "")
                    : "";
                const tabs = proxyRequest
                  ? ((
                      (await proxyRequest({
                        method: "GET",
                        path: "/tabs",
                        profile: effectiveProfile,
                      })) as { tabs?: unknown[] }
                    ).tabs ?? [])
                  : await browserTabs(baseUrl, { profile: effectiveProfile }).catch(() => []);
                if (!tabs.length) {
                  const canTryDefaultProfile =
                    !requestTargetId &&
                    Boolean(normalizedDefaultProfile) &&
                    normalizedDefaultProfile !== "chrome" &&
                    normalizedDefaultProfile !== effectiveProfile;
                  if (canTryDefaultProfile && normalizedDefaultProfile) {
                    const fallbackTabs = proxyRequest
                      ? ((
                          (await proxyRequest({
                            method: "GET",
                            path: "/tabs",
                            profile: normalizedDefaultProfile,
                          })) as { tabs?: unknown[] }
                        ).tabs ?? [])
                      : await browserTabs(baseUrl, { profile: normalizedDefaultProfile }).catch(
                          () => [],
                        );
                    if (fallbackTabs.length > 0) {
                      return proxyRequest
                        ? await proxyRequest({
                            method: "POST",
                            path: "/act",
                            profile: normalizedDefaultProfile,
                            body: request,
                          })
                        : await browserAct(baseUrl, request as Parameters<typeof browserAct>[1], {
                            profile: normalizedDefaultProfile,
                          });
                    }
                  }
                  const fallbackHint =
                    normalizedDefaultProfile && normalizedDefaultProfile !== "chrome"
                      ? ` Try profile="${normalizedDefaultProfile}" (or omit profile to use browser.defaultProfile).`
                      : "";
                  throw new Error(
                    "No attached tabs found on relay profile (chrome). Prefer browser.defaultProfile direct CDP first; use relay attach only when explicitly needed." +
                      fallbackHint,
                    { cause: err },
                  );
                }
                throw new Error(
                  'Chrome relay tab not found (stale targetId?). Run action=tabs profile="chrome" for relay tabs, or omit profile to use browser.defaultProfile tabs.',
                  { cause: err },
                );
              }
              throw err;
            }
          });
          return jsonResult(result);
        }
        default:
          throw new Error(`Unknown action: ${action}`);
      }
    },
  };
}
