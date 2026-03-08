import { randomUUID } from "node:crypto";
import type { loadConfig } from "../config/config.js";
import { loadOpenClawPlugins } from "../plugins/loader.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import { GATEWAY_CLIENT_IDS, GATEWAY_CLIENT_MODES } from "./protocol/client-info.js";
import type { ErrorShape } from "./protocol/index.js";
import { PROTOCOL_VERSION } from "./protocol/index.js";
import { handleGatewayRequest } from "./server-methods.js";
import type {
  GatewayRequestContext,
  GatewayRequestHandler,
  GatewayRequestOptions,
} from "./server-methods/types.js";

// ── Fallback gateway context for non-WS paths (Telegram, WhatsApp, etc.) ──
// The WS path sets a per-request scope via AsyncLocalStorage, but channel
// adapters (Telegram polling, etc.) invoke the agent directly without going
// through handleGatewayRequest. We store the gateway context at startup so
// dispatchGatewayMethod can use it as a fallback.

const FALLBACK_GATEWAY_CONTEXT_STATE_KEY: unique symbol = Symbol.for(
  "openclaw.fallbackGatewayContextState",
);

type FallbackGatewayContextState = {
  context: GatewayRequestContext | undefined;
};

const fallbackGatewayContextState = (() => {
  const globalState = globalThis as typeof globalThis & {
    [FALLBACK_GATEWAY_CONTEXT_STATE_KEY]?: FallbackGatewayContextState;
  };
  const existing = globalState[FALLBACK_GATEWAY_CONTEXT_STATE_KEY];
  if (existing) {
    return existing;
  }
  const created: FallbackGatewayContextState = { context: undefined };
  globalState[FALLBACK_GATEWAY_CONTEXT_STATE_KEY] = created;
  return created;
})();

export function setFallbackGatewayContext(ctx: GatewayRequestContext): void {
  // TODO: This startup snapshot can become stale if runtime config/context changes.
  fallbackGatewayContextState.context = ctx;
}

// ── Internal gateway dispatch for plugin runtime ────────────────────

function createSyntheticOperatorClient(): GatewayRequestOptions["client"] {
  return {
    connect: {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: {
        id: GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
        version: "internal",
        platform: "node",
        mode: GATEWAY_CLIENT_MODES.BACKEND,
      },
      role: "operator",
      scopes: ["operator.admin", "operator.approvals", "operator.pairing"],
    },
  };
}

async function dispatchGatewayMethod<T>(
  method: string,
  params: Record<string, unknown>,
): Promise<T> {
  const scope = getPluginRuntimeGatewayRequestScope();
  const context = scope?.context ?? fallbackGatewayContextState.context;
  const isWebchatConnect = scope?.isWebchatConnect ?? (() => false);
  if (!context) {
    throw new Error(
      `Plugin subagent dispatch requires a gateway request scope (method: ${method}). No scope set and no fallback context available.`,
    );
  }

  let result: { ok: boolean; payload?: unknown; error?: ErrorShape } | undefined;
  await handleGatewayRequest({
    req: {
      type: "req",
      id: `plugin-subagent-${randomUUID()}`,
      method,
      params,
    },
    client: createSyntheticOperatorClient(),
    isWebchatConnect,
    respond: (ok, payload, error) => {
      if (!result) {
        result = { ok, payload, error };
      }
    },
    context,
  });

  if (!result) {
    throw new Error(`Gateway method "${method}" completed without a response.`);
  }
  if (!result.ok) {
    throw new Error(result.error?.message ?? `Gateway method "${method}" failed.`);
  }
  return result.payload as T;
}

function createGatewaySubagentRuntime(): PluginRuntime["subagent"] {
  const getSessionMessages: PluginRuntime["subagent"]["getSessionMessages"] = async (params) => {
    const payload = await dispatchGatewayMethod<{ messages?: unknown[] }>("sessions.get", {
      key: params.sessionKey,
      ...(params.limit != null && { limit: params.limit }),
    });
    return { messages: Array.isArray(payload?.messages) ? payload.messages : [] };
  };

  return {
    async run(params) {
      const payload = await dispatchGatewayMethod<{ runId?: string }>("agent", {
        sessionKey: params.sessionKey,
        message: params.message,
        deliver: params.deliver ?? false,
        ...(params.extraSystemPrompt && { extraSystemPrompt: params.extraSystemPrompt }),
        ...(params.lane && { lane: params.lane }),
        ...(params.idempotencyKey && { idempotencyKey: params.idempotencyKey }),
      });
      const runId = payload?.runId;
      if (typeof runId !== "string" || !runId) {
        throw new Error("Gateway agent method returned an invalid runId.");
      }
      return { runId };
    },
    async waitForRun(params) {
      const payload = await dispatchGatewayMethod<{ status?: string; error?: string }>(
        "agent.wait",
        {
          runId: params.runId,
          ...(params.timeoutMs != null && { timeoutMs: params.timeoutMs }),
        },
      );
      const status = payload?.status;
      if (status !== "ok" && status !== "error" && status !== "timeout") {
        throw new Error(`Gateway agent.wait returned unexpected status: ${status}`);
      }
      return {
        status,
        ...(typeof payload?.error === "string" && payload.error && { error: payload.error }),
      };
    },
    getSessionMessages,
    async getSession(params) {
      return getSessionMessages(params);
    },
    async deleteSession(params) {
      await dispatchGatewayMethod("sessions.delete", {
        key: params.sessionKey,
        deleteTranscript: params.deleteTranscript ?? true,
      });
    },
  };
}

// ── Plugin loading ──────────────────────────────────────────────────

export function loadGatewayPlugins(params: {
  cfg: ReturnType<typeof loadConfig>;
  workspaceDir: string;
  log: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
    debug: (msg: string) => void;
  };
  coreGatewayHandlers: Record<string, GatewayRequestHandler>;
  baseMethods: string[];
}) {
  const pluginRegistry = loadOpenClawPlugins({
    config: params.cfg,
    workspaceDir: params.workspaceDir,
    logger: {
      info: (msg) => params.log.info(msg),
      warn: (msg) => params.log.warn(msg),
      error: (msg) => params.log.error(msg),
      debug: (msg) => params.log.debug(msg),
    },
    coreGatewayHandlers: params.coreGatewayHandlers,
    runtimeOptions: {
      subagent: createGatewaySubagentRuntime(),
    },
  });
  const pluginMethods = Object.keys(pluginRegistry.gatewayHandlers);
  const gatewayMethods = Array.from(new Set([...params.baseMethods, ...pluginMethods]));
  if (pluginRegistry.diagnostics.length > 0) {
    for (const diag of pluginRegistry.diagnostics) {
      const details = [
        diag.pluginId ? `plugin=${diag.pluginId}` : null,
        diag.source ? `source=${diag.source}` : null,
      ]
        .filter((entry): entry is string => Boolean(entry))
        .join(", ");
      const message = details
        ? `[plugins] ${diag.message} (${details})`
        : `[plugins] ${diag.message}`;
      if (diag.level === "error") {
        params.log.error(message);
      } else {
        params.log.info(message);
      }
    }
  }
  return { pluginRegistry, gatewayMethods };
}
