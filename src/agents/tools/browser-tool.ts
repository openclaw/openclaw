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
import {
  DEFAULT_AI_SNAPSHOT_MAX_CHARS,
  DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME,
} from "../../browser/constants.js";
import { DEFAULT_UPLOAD_DIR, resolvePathsWithinRoot } from "../../browser/paths.js";
import { applyBrowserProxyPaths, persistBrowserProxyFiles } from "../../browser/proxy-files.js";
import { loadConfig } from "../../config/config.js";
import { wrapExternalContent } from "../../security/external-content.js";
import { BrowserToolSchema } from "./browser-tool.schema.js";
import { type AnyAgentTool, imageResultFromFile, jsonResult, readStringParam } from "./common.js";
import { callGatewayTool } from "./gateway.js";
import { listNodes, resolveNodeIdFromList, type NodeListNode } from "./nodes-utils.js";

function wrapBrowserExternalJson(params: {
  kind: "snapshot" | "console" | "tabs";
  payload: unknown;
  includeWarning?: boolean;
}): { wrappedText: string; safeDetails: Record<string, unknown> } {
  const extractedText = JSON.stringify(params.payload, null, 2);
  const wrappedText = wrapExternalContent(extractedText, {
    source: "browser",
    includeWarning: params.includeWarning ?? true,
  });
  return {
    wrappedText,
    safeDetails: {
      ok: true,
      externalContent: {
        untrusted: true,
        source: "browser",
        kind: params.kind,
        wrapped: true,
      },
    },
  };
}

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
const LOW_TIMEOUT_RETRY_THRESHOLD_MS = 5_000;
const READ_RETRY_MIN_TIMEOUT_MS = 10_000;
const READ_RETRY_TIMEOUT_MULTIPLIER = 3;
const PREFERRED_HEADLESS_PROFILE_NAME = "work";

function normalizeTimeoutMs(timeoutMs: number): number {
  return Math.max(1000, Math.min(120_000, Math.floor(timeoutMs)));
}

function parseTimeoutMsFromError(error: unknown): number | null {
  const match = String(error).match(/timed out after\s+(\d+)\s*ms/i);
  if (!match) {
    return null;
  }
  const parsed = Number.parseInt(match[1] ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return normalizeTimeoutMs(parsed);
}

function resolveReadRetryTimeoutMs(
  initialTimeoutMs: number | undefined,
  error: unknown,
): number | null {
  const timeoutMs = initialTimeoutMs ?? parseTimeoutMsFromError(error);
  if (timeoutMs === undefined || timeoutMs > LOW_TIMEOUT_RETRY_THRESHOLD_MS) {
    return null;
  }
  return normalizeTimeoutMs(
    Math.max(READ_RETRY_MIN_TIMEOUT_MS, timeoutMs * READ_RETRY_TIMEOUT_MULTIPLIER),
  );
}

async function runWithReadTimeoutRetry<T>(params: {
  timeoutMs?: number;
  run: (timeoutMs?: number) => Promise<T>;
}): Promise<T> {
  try {
    return await params.run(params.timeoutMs);
  } catch (error) {
    const retryTimeoutMs = resolveReadRetryTimeoutMs(params.timeoutMs, error);
    if (retryTimeoutMs === null) {
      throw error;
    }
    return await params.run(retryTimeoutMs);
  }
}

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
  return await persistBrowserProxyFiles(files);
}

function applyProxyPaths(result: unknown, mapping: Map<string, string>) {
  applyBrowserProxyPaths(result, mapping);
}

async function resolveBrowserProfileForToolCall(params: {
  requestedProfile?: string;
  requestedHeadless?: boolean;
  baseUrl?: string;
  proxyRequest:
    | ((opts: {
        method: string;
        path: string;
        query?: Record<string, string | number | boolean | undefined>;
        body?: unknown;
        timeoutMs?: number;
        profile?: string;
      }) => Promise<unknown>)
    | null;
}): Promise<string> {
  if (params.requestedProfile?.trim()) {
    return params.requestedProfile.trim();
  }
  if (params.requestedHeadless !== true) {
    return DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME;
  }

  const candidateNames = new Set<string>([
    PREFERRED_HEADLESS_PROFILE_NAME,
    DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME,
  ]);
  try {
    const profiles = params.proxyRequest
      ? ((
          (await params.proxyRequest({
            method: "GET",
            path: "/profiles",
          })) as { profiles?: Array<{ name?: unknown }> }
        ).profiles ?? [])
      : await browserProfiles(params.baseUrl);
    for (const entry of profiles) {
      const nameRaw = typeof entry?.name === "string" ? entry.name : "";
      const name = nameRaw.trim();
      if (name) {
        candidateNames.add(name);
      }
    }
  } catch {
    // Keep fallback candidates only.
  }

  const orderedCandidates = [
    PREFERRED_HEADLESS_PROFILE_NAME,
    ...Array.from(candidateNames).filter((name) => name !== PREFERRED_HEADLESS_PROFILE_NAME),
  ];

  for (const name of orderedCandidates) {
    try {
      const status = params.proxyRequest
        ? ((await params.proxyRequest({
            method: "GET",
            path: "/",
            query: { profile: name },
          })) as { headless?: unknown })
        : await browserStatus(params.baseUrl, { profile: name });
      if (status.headless === true) {
        return name;
      }
    } catch {
      // Ignore unavailable profiles while probing.
    }
  }

  throw new Error(
    'No headless browser profile is available. Pass profile="<name>" or configure browser.profiles.<name>.headless=true.',
  );
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
  const targetDefault = opts?.sandboxBridgeUrl ? "sandbox" : "host";
  const hostHint =
    opts?.allowHostControl === false ? "Host target blocked by policy." : "Host target allowed.";
  return {
    label: "Browser",
    name: "browser",
    description: [
      "Control the browser via OpenClaw's browser control server (status/start/stop/profiles/tabs/open/snapshot/screenshot/actions).",
      'Profiles: use profile="chrome" for Chrome extension relay takeover (your existing Chrome tabs). Use profile="openclaw" for the isolated openclaw-managed browser.',
      'Default profile is headful profile="openclaw". If headless behavior is requested, pass headless=true (or explicitly set profile).',
      'If the user mentions the Chrome extension / Browser Relay / toolbar button / “attach tab”, ALWAYS use profile="chrome" (do not ask which profile).',
      'When a node-hosted browser proxy is available, the tool may auto-route to it. Pin a node with node=<id|name> or target="node".',
      "Chrome extension relay needs an attached tab: user must click the OpenClaw Browser Relay toolbar icon on the tab (badge ON). If no tab is connected, ask them to attach it.",
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
      const requestedProfile = readStringParam(params, "profile");
      const requestedHeadless = typeof params.headless === "boolean" ? params.headless : undefined;
      const requestedNode = readStringParam(params, "node");
      let target = readStringParam(params, "target") as "sandbox" | "host" | "node" | undefined;

      if (requestedNode && target && target !== "node") {
        throw new Error('node is only supported with target="node".');
      }

      if (!target && !requestedNode && requestedProfile === "chrome") {
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
      const profile = await resolveBrowserProfileForToolCall({
        requestedProfile: requestedProfile ?? undefined,
        requestedHeadless,
        baseUrl,
        proxyRequest,
      });

      switch (action) {
        case "status":
          if (proxyRequest) {
            return jsonResult(
              await proxyRequest({
                method: "GET",
                path: "/",
                profile,
              }),
            );
          }
          return jsonResult(await browserStatus(baseUrl, { profile }));
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
        case "tabs": {
          const tabs = await runWithReadTimeoutRetry({
            run: async (timeoutMs) => {
              if (proxyRequest) {
                const result = await proxyRequest({
                  method: "GET",
                  path: "/tabs",
                  profile,
                  timeoutMs,
                });
                return (result as { tabs?: unknown[] }).tabs ?? [];
              }
              return await browserTabs(baseUrl, { profile, timeoutMs });
            },
          });
          const wrapped = wrapBrowserExternalJson({
            kind: "tabs",
            payload: { tabs },
            includeWarning: false,
          });
          return {
            content: [{ type: "text", text: wrapped.wrappedText }],
            details: { ...wrapped.safeDetails, tabCount: tabs.length },
          };
        }
        case "open": {
          const targetUrl = readStringParam(params, "targetUrl", {
            required: true,
          });
          if (proxyRequest) {
            const result = await proxyRequest({
              method: "POST",
              path: "/tabs/open",
              profile,
              body: { url: targetUrl },
            });
            return jsonResult(result);
          }
          return jsonResult(await browserOpenTab(baseUrl, targetUrl, { profile }));
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
          const timeoutMs =
            typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)
              ? normalizeTimeoutMs(params.timeoutMs)
              : undefined;
          const snapshot = await runWithReadTimeoutRetry({
            timeoutMs,
            run: async (effectiveTimeoutMs) => {
              if (proxyRequest) {
                return (await proxyRequest({
                  method: "GET",
                  path: "/snapshot",
                  profile,
                  timeoutMs: effectiveTimeoutMs,
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
                })) as Awaited<ReturnType<typeof browserSnapshot>>;
              }
              return await browserSnapshot(baseUrl, {
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
                profile,
                timeoutMs: effectiveTimeoutMs,
              });
            },
          });
          if (snapshot.format === "ai") {
            const extractedText = snapshot.snapshot ?? "";
            const wrappedSnapshot = wrapExternalContent(extractedText, {
              source: "browser",
              includeWarning: true,
            });
            const safeDetails = {
              ok: true,
              format: snapshot.format,
              targetId: snapshot.targetId,
              url: snapshot.url,
              truncated: snapshot.truncated,
              stats: snapshot.stats,
              refs: snapshot.refs ? Object.keys(snapshot.refs).length : undefined,
              labels: snapshot.labels,
              labelsCount: snapshot.labelsCount,
              labelsSkipped: snapshot.labelsSkipped,
              imagePath: snapshot.imagePath,
              imageType: snapshot.imageType,
              externalContent: {
                untrusted: true,
                source: "browser",
                kind: "snapshot",
                format: "ai",
                wrapped: true,
              },
            };
            if (labels && snapshot.imagePath) {
              return await imageResultFromFile({
                label: "browser:snapshot",
                path: snapshot.imagePath,
                extraText: wrappedSnapshot,
                details: safeDetails,
              });
            }
            return {
              content: [{ type: "text", text: wrappedSnapshot }],
              details: safeDetails,
            };
          }
          {
            const wrapped = wrapBrowserExternalJson({
              kind: "snapshot",
              payload: snapshot,
            });
            return {
              content: [{ type: "text", text: wrapped.wrappedText }],
              details: {
                ...wrapped.safeDetails,
                format: "aria",
                targetId: snapshot.targetId,
                url: snapshot.url,
                nodeCount: snapshot.nodes.length,
                externalContent: {
                  untrusted: true,
                  source: "browser",
                  kind: "snapshot",
                  format: "aria",
                  wrapped: true,
                },
              },
            };
          }
        }
        case "screenshot": {
          const targetId = readStringParam(params, "targetId");
          const fullPage = Boolean(params.fullPage);
          const ref = readStringParam(params, "ref");
          const element = readStringParam(params, "element");
          const type = params.type === "jpeg" ? "jpeg" : "png";
          const timeoutMs =
            typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)
              ? Math.max(1000, Math.min(120_000, Math.floor(params.timeoutMs)))
              : undefined;
          const result = proxyRequest
            ? ((await proxyRequest({
                method: "POST",
                path: "/screenshot",
                profile,
                timeoutMs,
                body: {
                  targetId,
                  fullPage,
                  ref,
                  element,
                  type,
                  timeoutMs,
                },
              })) as Awaited<ReturnType<typeof browserScreenshotAction>>)
            : await browserScreenshotAction(baseUrl, {
                targetId,
                fullPage,
                ref,
                element,
                type,
                profile,
                timeoutMs,
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
          const timeoutMs =
            typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)
              ? Math.max(1000, Math.min(120_000, Math.floor(params.timeoutMs)))
              : undefined;
          if (proxyRequest) {
            const result = await proxyRequest({
              method: "POST",
              path: "/navigate",
              profile,
              timeoutMs,
              body: {
                url: targetUrl,
                targetId,
                timeoutMs,
              },
            });
            return jsonResult(result);
          }
          return jsonResult(
            await browserNavigate(baseUrl, {
              url: targetUrl,
              targetId,
              timeoutMs,
              profile,
            }),
          );
        }
        case "console": {
          const level = typeof params.level === "string" ? params.level.trim() : undefined;
          const targetId = typeof params.targetId === "string" ? params.targetId.trim() : undefined;
          {
            const result = await runWithReadTimeoutRetry({
              run: async (timeoutMs) => {
                if (proxyRequest) {
                  return (await proxyRequest({
                    method: "GET",
                    path: "/console",
                    profile,
                    timeoutMs,
                    query: {
                      level,
                      targetId,
                    },
                  })) as { ok?: boolean; targetId?: string; messages?: unknown[] };
                }
                return await browserConsoleMessages(baseUrl, {
                  level,
                  targetId,
                  profile,
                  timeoutMs,
                });
              },
            });
            const wrapped = wrapBrowserExternalJson({
              kind: "console",
              payload: result,
              includeWarning: false,
            });
            return {
              content: [{ type: "text", text: wrapped.wrappedText }],
              details: {
                ...wrapped.safeDetails,
                targetId: typeof result.targetId === "string" ? result.targetId : undefined,
                messageCount: Array.isArray(result.messages) ? result.messages.length : undefined,
              },
            };
          }
        }
        case "pdf": {
          const targetId = typeof params.targetId === "string" ? params.targetId.trim() : undefined;
          const result = proxyRequest
            ? ((await proxyRequest({
                method: "POST",
                path: "/pdf",
                profile,
                body: { targetId },
              })) as Awaited<ReturnType<typeof browserPdfSave>>)
            : await browserPdfSave(baseUrl, { targetId, profile });
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
          const uploadPathsResult = resolvePathsWithinRoot({
            rootDir: DEFAULT_UPLOAD_DIR,
            requestedPaths: paths,
            scopeLabel: `uploads directory (${DEFAULT_UPLOAD_DIR})`,
          });
          if (!uploadPathsResult.ok) {
            throw new Error(uploadPathsResult.error);
          }
          const normalizedPaths = uploadPathsResult.paths;
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
                paths: normalizedPaths,
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
              paths: normalizedPaths,
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
          const timeoutMs =
            typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)
              ? Math.max(1000, Math.min(120_000, Math.floor(params.timeoutMs)))
              : undefined;
          const requestWithTimeout =
            typeof timeoutMs === "number" && timeoutMs > 0 && !Object.hasOwn(request, "timeoutMs")
              ? { ...request, timeoutMs }
              : request;
          try {
            const result = proxyRequest
              ? await proxyRequest({
                  method: "POST",
                  path: "/act",
                  profile,
                  timeoutMs,
                  body: requestWithTimeout,
                })
              : await browserAct(baseUrl, requestWithTimeout as Parameters<typeof browserAct>[1], {
                  profile,
                  timeoutMs,
                });
            return jsonResult(result);
          } catch (err) {
            const msg = String(err);
            const msgLower = msg.toLowerCase();
            const looksLikeStaleElement =
              msgLower.includes("element") &&
              (msgLower.includes("not found") || msgLower.includes("not visible"));
            if (looksLikeStaleElement) {
              throw new Error(
                'Browser element reference is stale. Run action="snapshot" again on the same tab, then retry using a fresh ref/element id.',
                { cause: err },
              );
            }
            if (msg.includes("404:") && msg.includes("tab not found") && profile === "chrome") {
              const tabs = proxyRequest
                ? ((
                    (await proxyRequest({
                      method: "GET",
                      path: "/tabs",
                      profile,
                    })) as { tabs?: unknown[] }
                  ).tabs ?? [])
                : await browserTabs(baseUrl, { profile }).catch(() => []);
              if (!tabs.length) {
                throw new Error(
                  "No Chrome tabs are attached via the OpenClaw Browser Relay extension. Click the toolbar icon on the tab you want to control (badge ON), then retry.",
                  { cause: err },
                );
              }
              throw new Error(
                `Chrome tab not found (stale targetId?). Run action=tabs profile="chrome" and use one of the returned targetIds.`,
                { cause: err },
              );
            }
            throw err;
          }
        }
        default:
          throw new Error(`Unknown action: ${action}`);
      }
    },
  };
}
