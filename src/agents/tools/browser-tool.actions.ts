import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { browserAct, browserConsoleMessages } from "../../browser/client-actions.js";
import { browserSnapshot, browserTabs } from "../../browser/client.js";
import { DEFAULT_AI_SNAPSHOT_MAX_CHARS } from "../../browser/constants.js";
import { loadConfig } from "../../config/config.js";
import { wrapExternalContent } from "../../security/external-content.js";
import { imageResultFromFile, jsonResult } from "./common.js";

type BrowserProxyRequest = (opts: {
  method: string;
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  timeoutMs?: number;
  profile?: string;
}) => Promise<unknown>;

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

function formatTabsToolResult(tabs: unknown[]): AgentToolResult<unknown> {
  const wrapped = wrapBrowserExternalJson({
    kind: "tabs",
    payload: { tabs },
    includeWarning: false,
  });
  const content: AgentToolResult<unknown>["content"] = [
    { type: "text", text: wrapped.wrappedText },
  ];
  return {
    content,
    details: { ...wrapped.safeDetails, tabCount: tabs.length },
  };
}

export function isChromeStaleTargetError(profile: string | undefined, err: unknown): boolean {
  if (profile !== "chrome") {
    return false;
  }
  const msg = String(err).toLowerCase();
  // "no attached" means the relay has no tabs at all — dropping targetId won't help.
  if (msg.includes("no attached")) {
    return false;
  }
  // Match 404 stale-target responses or an explicit stale-targetId signal.
  return (msg.includes("404:") && msg.includes("tab not found")) || msg.includes("stale targetid");
}

async function throwWithTabContext(
  cause: unknown,
  profile: string | undefined,
  baseUrl: string | undefined,
  proxyRequest: BrowserProxyRequest | null,
): Promise<never> {
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
      { cause },
    );
  }
  throw new Error(
    `Chrome tab not found (stale targetId?). Run action=tabs profile="chrome" and use one of the returned targetIds.`,
    { cause },
  );
}

function stripTargetIdFromActRequest(
  request: Parameters<typeof browserAct>[1],
): Parameters<typeof browserAct>[1] | null {
  const targetId = typeof request.targetId === "string" ? request.targetId.trim() : undefined;
  if (!targetId) {
    return null;
  }
  const retryRequest = { ...request };
  delete retryRequest.targetId;
  return retryRequest as Parameters<typeof browserAct>[1];
}

export async function executeTabsAction(params: {
  baseUrl?: string;
  profile?: string;
  proxyRequest: BrowserProxyRequest | null;
}): Promise<AgentToolResult<unknown>> {
  const { baseUrl, profile, proxyRequest } = params;
  if (proxyRequest) {
    const result = await proxyRequest({
      method: "GET",
      path: "/tabs",
      profile,
    });
    const tabs = (result as { tabs?: unknown[] }).tabs ?? [];
    return formatTabsToolResult(tabs);
  }
  const tabs = await browserTabs(baseUrl, { profile });
  return formatTabsToolResult(tabs);
}

export async function executeSnapshotAction(params: {
  input: Record<string, unknown>;
  baseUrl?: string;
  profile?: string;
  proxyRequest: BrowserProxyRequest | null;
}): Promise<AgentToolResult<unknown>> {
  const { input, baseUrl, profile, proxyRequest } = params;
  const snapshotDefaults = loadConfig().browser?.snapshotDefaults;
  const format =
    input.snapshotFormat === "ai" || input.snapshotFormat === "aria" ? input.snapshotFormat : "ai";
  const mode =
    input.mode === "efficient"
      ? "efficient"
      : format === "ai" && snapshotDefaults?.mode === "efficient"
        ? "efficient"
        : undefined;
  const labels = typeof input.labels === "boolean" ? input.labels : undefined;
  const refs = input.refs === "aria" || input.refs === "role" ? input.refs : undefined;
  const hasMaxChars = Object.hasOwn(input, "maxChars");
  const targetId = typeof input.targetId === "string" ? input.targetId.trim() : undefined;
  const limit =
    typeof input.limit === "number" && Number.isFinite(input.limit) ? input.limit : undefined;
  const maxChars =
    typeof input.maxChars === "number" && Number.isFinite(input.maxChars) && input.maxChars > 0
      ? Math.floor(input.maxChars)
      : undefined;
  const resolvedMaxChars =
    format === "ai"
      ? hasMaxChars
        ? maxChars
        : mode === "efficient"
          ? undefined
          : DEFAULT_AI_SNAPSHOT_MAX_CHARS
      : undefined;
  const interactive = typeof input.interactive === "boolean" ? input.interactive : undefined;
  const compact = typeof input.compact === "boolean" ? input.compact : undefined;
  const depth =
    typeof input.depth === "number" && Number.isFinite(input.depth) ? input.depth : undefined;
  const selector = typeof input.selector === "string" ? input.selector.trim() : undefined;
  const frame = typeof input.frame === "string" ? input.frame.trim() : undefined;
  let snapshot: Awaited<ReturnType<typeof browserSnapshot>>;
  try {
    snapshot = proxyRequest
      ? ((await proxyRequest({
          method: "GET",
          path: "/snapshot",
          profile,
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
          profile,
        });
  } catch (err) {
    if (!isChromeStaleTargetError(profile, err) || !targetId) {
      throw err;
    }
    // Retry once without targetId — relay will fall back to the currently attached tab.
    try {
      snapshot = proxyRequest
        ? ((await proxyRequest({
            method: "GET",
            path: "/snapshot",
            profile,
            query: {
              format,
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
          });
    } catch {
      // Retry failed — surface actionable relay guidance.
      await throwWithTabContext(err, profile, baseUrl, proxyRequest);
    }
  }
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
      content: [{ type: "text" as const, text: wrappedSnapshot }],
      details: safeDetails,
    };
  }
  {
    const wrapped = wrapBrowserExternalJson({
      kind: "snapshot",
      payload: snapshot,
    });
    return {
      content: [{ type: "text" as const, text: wrapped.wrappedText }],
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

export async function executeConsoleAction(params: {
  input: Record<string, unknown>;
  baseUrl?: string;
  profile?: string;
  proxyRequest: BrowserProxyRequest | null;
}): Promise<AgentToolResult<unknown>> {
  const { input, baseUrl, profile, proxyRequest } = params;
  const level = typeof input.level === "string" ? input.level.trim() : undefined;
  const targetId = typeof input.targetId === "string" ? input.targetId.trim() : undefined;
  if (proxyRequest) {
    const result = (await proxyRequest({
      method: "GET",
      path: "/console",
      profile,
      query: {
        level,
        targetId,
      },
    })) as { ok?: boolean; targetId?: string; messages?: unknown[] };
    const wrapped = wrapBrowserExternalJson({
      kind: "console",
      payload: result,
      includeWarning: false,
    });
    return {
      content: [{ type: "text" as const, text: wrapped.wrappedText }],
      details: {
        ...wrapped.safeDetails,
        targetId: typeof result.targetId === "string" ? result.targetId : undefined,
        messageCount: Array.isArray(result.messages) ? result.messages.length : undefined,
      },
    };
  }
  const result = await browserConsoleMessages(baseUrl, { level, targetId, profile });
  const wrapped = wrapBrowserExternalJson({
    kind: "console",
    payload: result,
    includeWarning: false,
  });
  return {
    content: [{ type: "text" as const, text: wrapped.wrappedText }],
    details: {
      ...wrapped.safeDetails,
      targetId: result.targetId,
      messageCount: result.messages.length,
    },
  };
}

export async function executeActAction(params: {
  request: Parameters<typeof browserAct>[1];
  baseUrl?: string;
  profile?: string;
  proxyRequest: BrowserProxyRequest | null;
}): Promise<AgentToolResult<unknown>> {
  const { request, baseUrl, profile, proxyRequest } = params;
  try {
    const result = proxyRequest
      ? await proxyRequest({
          method: "POST",
          path: "/act",
          profile,
          body: request,
        })
      : await browserAct(baseUrl, request, {
          profile,
        });
    return jsonResult(result);
  } catch (err) {
    if (isChromeStaleTargetError(profile, err)) {
      const retryRequest = stripTargetIdFromActRequest(request);
      // Some Chrome relay targetIds can go stale between snapshots and actions.
      // Retry once without targetId to let relay use the currently attached tab.
      if (retryRequest) {
        try {
          const retryResult = proxyRequest
            ? await proxyRequest({
                method: "POST",
                path: "/act",
                profile,
                body: retryRequest,
              })
            : await browserAct(baseUrl, retryRequest, {
                profile,
              });
          return jsonResult(retryResult);
        } catch {
          // Fall through to explicit stale-target guidance.
        }
      }
      await throwWithTabContext(err, profile, baseUrl, proxyRequest);
    }
    throw err;
  }
}
