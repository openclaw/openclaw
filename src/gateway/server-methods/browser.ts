import crypto from "node:crypto";
import { resolveBrowserConfig } from "../../browser/config.js";
import {
  createBrowserControlContext,
  startBrowserControlServiceFromConfig,
} from "../../browser/control-service.js";
import { applyBrowserProxyPaths, persistBrowserProxyFiles } from "../../browser/proxy-files.js";
import { createBrowserRouteDispatcher } from "../../browser/routes/dispatcher.js";
import { loadConfig } from "../../config/config.js";
import { withTimeout } from "../../node-host/with-timeout.js";
import { isNodeCommandAllowed, resolveNodeCommandAllowlist } from "../node-command-policy.js";
import type { NodeSession } from "../node-registry.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import { respondUnavailableOnNodeInvokeError, safeParseJson } from "./nodes.helpers.js";
import type { GatewayRequestHandlers } from "./types.js";

type BrowserRequestParams = {
  method?: string;
  path?: string;
  query?: Record<string, unknown>;
  body?: unknown;
  timeoutMs?: number;
};

function normalizeBrowserRequestPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return trimmed;
  }
  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  if (withLeadingSlash.length <= 1) {
    return withLeadingSlash;
  }
  return withLeadingSlash.replace(/\/+$/, "");
}

function isPersistentBrowserProfileMutation(method: string, path: string): boolean {
  const normalizedPath = normalizeBrowserRequestPath(path);
  if (method === "POST" && normalizedPath === "/profiles/create") {
    return true;
  }
  return method === "DELETE" && /^\/profiles\/[^/]+$/.test(normalizedPath);
}

const ABORT_AWARE_LOCAL_ACT_KINDS = new Set([
  "click",
  "type",
  "press",
  "hover",
  "scrollIntoView",
  "drag",
  "select",
  "fill",
  "resize",
  "wait",
  "evaluate",
  "close",
]);

function resolveRequestedProfileDriver(params: {
  cfg: ReturnType<typeof loadConfig>;
  query?: Record<string, unknown>;
  body?: unknown;
}): string | undefined {
  const resolvedBrowser = resolveBrowserConfig(params.cfg.browser, params.cfg);
  const profileName =
    resolveRequestedProfile({ query: params.query, body: params.body }) ??
    resolvedBrowser.defaultProfile;
  if (!profileName) {
    return undefined;
  }
  const profile = resolvedBrowser.profiles[profileName];
  return typeof profile?.driver === "string" ? profile.driver : undefined;
}

function shouldWrapLocalBrowserRequestWithTimeout(params: {
  cfg: ReturnType<typeof loadConfig>;
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
}) {
  if (resolveRequestedProfileDriver(params) === "existing-session") {
    return false;
  }
  const path = normalizeBrowserRequestPath(params.path);
  if (path === "/navigate" || path === "/pdf") {
    return true;
  }
  if (path !== "/act" || !params.body || typeof params.body !== "object") {
    return false;
  }
  const kind =
    "kind" in params.body && typeof params.body.kind === "string" ? params.body.kind.trim() : "";
  return ABORT_AWARE_LOCAL_ACT_KINDS.has(kind);
}

function resolveRequestedProfile(params: {
  query?: Record<string, unknown>;
  body?: unknown;
}): string | undefined {
  const queryProfile =
    typeof params.query?.profile === "string" ? params.query.profile.trim() : undefined;
  if (queryProfile) {
    return queryProfile;
  }
  if (!params.body || typeof params.body !== "object") {
    return undefined;
  }
  const bodyProfile =
    "profile" in params.body && typeof params.body.profile === "string"
      ? params.body.profile.trim()
      : undefined;
  return bodyProfile || undefined;
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

function isBrowserNode(node: NodeSession) {
  const caps = Array.isArray(node.caps) ? node.caps : [];
  const commands = Array.isArray(node.commands) ? node.commands : [];
  return caps.includes("browser") || commands.includes("browser.proxy");
}

function normalizeNodeKey(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function resolveBrowserNode(nodes: NodeSession[], query: string): NodeSession | null {
  const q = query.trim();
  if (!q) {
    return null;
  }
  const qNorm = normalizeNodeKey(q);
  const matches = nodes.filter((node) => {
    if (node.nodeId === q) {
      return true;
    }
    if (typeof node.remoteIp === "string" && node.remoteIp === q) {
      return true;
    }
    const name = typeof node.displayName === "string" ? node.displayName : "";
    if (name && normalizeNodeKey(name) === qNorm) {
      return true;
    }
    if (q.length >= 6 && node.nodeId.startsWith(q)) {
      return true;
    }
    return false;
  });
  if (matches.length === 1) {
    return matches[0] ?? null;
  }
  if (matches.length === 0) {
    return null;
  }
  throw new Error(
    `ambiguous node: ${q} (matches: ${matches
      .map((node) => node.displayName || node.remoteIp || node.nodeId)
      .join(", ")})`,
  );
}

function resolveBrowserNodeTarget(params: {
  cfg: ReturnType<typeof loadConfig>;
  nodes: NodeSession[];
}): NodeSession | null {
  const policy = params.cfg.gateway?.nodes?.browser;
  const mode = policy?.mode ?? "auto";
  if (mode === "off") {
    return null;
  }
  const browserNodes = params.nodes.filter((node) => isBrowserNode(node));
  if (browserNodes.length === 0) {
    if (policy?.node?.trim()) {
      throw new Error("No connected browser-capable nodes.");
    }
    return null;
  }
  const requested = policy?.node?.trim() || "";
  if (requested) {
    const resolved = resolveBrowserNode(browserNodes, requested);
    if (!resolved) {
      throw new Error(`Configured browser node not connected: ${requested}`);
    }
    return resolved;
  }
  if (mode === "manual") {
    return null;
  }
  if (browserNodes.length === 1) {
    return browserNodes[0] ?? null;
  }
  return null;
}

async function persistProxyFiles(files: BrowserProxyFile[] | undefined) {
  return await persistBrowserProxyFiles(files);
}

function applyProxyPaths(result: unknown, mapping: Map<string, string>) {
  applyBrowserProxyPaths(result, mapping);
}

export const browserHandlers: GatewayRequestHandlers = {
  "browser.request": async ({ params, respond, context }) => {
    const typed = params as BrowserRequestParams;
    const methodRaw = typeof typed.method === "string" ? typed.method.trim().toUpperCase() : "";
    const path = typeof typed.path === "string" ? typed.path.trim() : "";
    const query = typed.query && typeof typed.query === "object" ? typed.query : undefined;
    const body = typed.body;
    const timeoutMs =
      typeof typed.timeoutMs === "number" && Number.isFinite(typed.timeoutMs)
        ? Math.max(1, Math.floor(typed.timeoutMs))
        : undefined;

    if (!methodRaw || !path) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "method and path are required"),
      );
      return;
    }
    if (methodRaw !== "GET" && methodRaw !== "POST" && methodRaw !== "DELETE") {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "method must be GET, POST, or DELETE"),
      );
      return;
    }
    if (isPersistentBrowserProfileMutation(methodRaw, path)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "browser.request cannot create or delete persistent browser profiles",
        ),
      );
      return;
    }

    const cfg = loadConfig();
    let nodeTarget: NodeSession | null = null;
    try {
      nodeTarget = resolveBrowserNodeTarget({
        cfg,
        nodes: context.nodeRegistry.listConnected(),
      });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
      return;
    }

    if (nodeTarget) {
      const allowlist = resolveNodeCommandAllowlist(cfg, nodeTarget);
      const allowed = isNodeCommandAllowed({
        command: "browser.proxy",
        declaredCommands: nodeTarget.commands,
        allowlist,
      });
      if (!allowed.ok) {
        const platform = nodeTarget.platform ?? "unknown";
        const hint = `node command not allowed: ${allowed.reason} (platform: ${platform}, command: browser.proxy)`;
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, hint, {
            details: { reason: allowed.reason, command: "browser.proxy" },
          }),
        );
        return;
      }

      const proxyParams = {
        method: methodRaw,
        path,
        query,
        body,
        timeoutMs,
        profile: resolveRequestedProfile({ query, body }),
      };
      const res = await context.nodeRegistry.invoke({
        nodeId: nodeTarget.nodeId,
        command: "browser.proxy",
        params: proxyParams,
        timeoutMs,
        idempotencyKey: crypto.randomUUID(),
      });
      if (!respondUnavailableOnNodeInvokeError(respond, res)) {
        return;
      }
      const payload = res.payloadJSON ? safeParseJson(res.payloadJSON) : res.payload;
      const proxy = payload && typeof payload === "object" ? (payload as BrowserProxyResult) : null;
      if (!proxy || !("result" in proxy)) {
        respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "browser proxy failed"));
        return;
      }
      const mapping = await persistProxyFiles(proxy.files);
      applyProxyPaths(proxy.result, mapping);
      respond(true, proxy.result);
      return;
    }

    const ready = await startBrowserControlServiceFromConfig();
    if (!ready) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "browser control is disabled"));
      return;
    }

    let dispatcher;
    try {
      dispatcher = createBrowserRouteDispatcher(createBrowserControlContext());
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
      return;
    }

    const shouldApplyLocalTimeout =
      timeoutMs !== undefined &&
      shouldWrapLocalBrowserRequestWithTimeout({ cfg, path, query, body });

    let result;
    try {
      result = shouldApplyLocalTimeout
        ? await withTimeout(
            async (signal) =>
              await dispatcher.dispatch({
                method: methodRaw,
                path,
                query,
                body,
                signal,
              }),
            timeoutMs,
            "browser request",
          )
        : await dispatcher.dispatch({
            method: methodRaw,
            path,
            query,
            body,
          });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
      return;
    }

    if (result.status >= 400) {
      const message =
        result.body && typeof result.body === "object" && "error" in result.body
          ? String((result.body as { error?: unknown }).error)
          : `browser request failed (${result.status})`;
      const code = result.status >= 500 ? ErrorCodes.UNAVAILABLE : ErrorCodes.INVALID_REQUEST;
      respond(false, undefined, errorShape(code, message, { details: result.body }));
      return;
    }

    respond(true, result.body);
  },
};
