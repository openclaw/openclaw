import { randomUUID } from "node:crypto";
import type { PluginOrigin } from "../plugins/plugin-origin.types.js";
import type { RuntimePluginToolGrant } from "../plugins/runtime/tool-grant.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import type { GatewayRequestOptions } from "./server-methods/types.js";

type PluginRuntimeGatewayRequestScope = {
  client?: GatewayRequestOptions["client"];
  pluginId?: string;
  pluginOrigin?: PluginOrigin;
  pluginTrustedOfficialInstall?: boolean;
};

type ServerPluginsSubagentRuntimeDeps = {
  adminScope: string;
  canClientUseModelOverride: (client: GatewayRequestOptions["client"]) => boolean;
  canTrustedOfficialPluginRequestScopes: (params: {
    pluginId?: string;
    pluginOrigin?: PluginOrigin;
    pluginTrustedOfficialInstall?: boolean;
  }) => boolean;
  authorizeFallbackModelOverride: (params: {
    pluginId?: string;
    provider?: string;
    model?: string;
  }) => { allowed: true } | { allowed: false; reason: string };
  dispatchGatewayMethod: <T>(
    method: string,
    params: unknown,
    options?: {
      allowSyntheticModelOverride?: boolean;
      agentRunTracking?: "plugin_subagent";
      expectFinal?: boolean;
      forceSyntheticClient?: boolean;
      pluginRuntimeOwnerId?: string;
      runtimePluginToolGrant?: RuntimePluginToolGrant;
      syntheticScopes?: string[];
    },
  ) => Promise<T>;
  getPluginRuntimeGatewayRequestScope: () => PluginRuntimeGatewayRequestScope | undefined;
  hasAdminScope: (client: GatewayRequestOptions["client"] | undefined) => boolean;
  resolvePluginSubagentToolsAlsoAllow: (params: {
    pluginId?: string;
    toolsAlsoAllow?: string[];
  }) => RuntimePluginToolGrant | undefined;
};

const PLUGIN_SUBAGENT_SESSION_MESSAGES_MAX_LIMIT = 1_000;

function normalizeSubagentRunRuntime(
  value: unknown,
): Awaited<ReturnType<PluginRuntime["subagent"]["run"]>>["runtime"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const harness = typeof record.harness === "string" ? record.harness.trim() : "";
  const provider = typeof record.provider === "string" ? record.provider.trim() : "";
  const model = typeof record.model === "string" ? record.model.trim() : "";
  return harness && provider && model ? { harness, provider, model } : undefined;
}

export function createGatewaySubagentRuntimeImpl(
  deps: ServerPluginsSubagentRuntimeDeps,
): PluginRuntime["subagent"] {
  const getSessionMessages: PluginRuntime["subagent"]["getSessionMessages"] = async (params) => {
    const limit =
      params.limit == null || !Number.isFinite(params.limit)
        ? undefined
        : Math.min(
            PLUGIN_SUBAGENT_SESSION_MESSAGES_MAX_LIMIT,
            Math.max(1, Math.floor(params.limit)),
          );
    const payload = await deps.dispatchGatewayMethod<{ messages?: unknown[] }>("sessions.get", {
      key: params.sessionKey,
      ...(limit != null && { limit }),
    });
    return { messages: Array.isArray(payload?.messages) ? payload.messages : [] };
  };

  return {
    async run(params) {
      const scope = deps.getPluginRuntimeGatewayRequestScope();
      const pluginId =
        typeof scope?.pluginId === "string" && scope.pluginId.trim()
          ? scope.pluginId.trim()
          : undefined;
      const runtimePluginToolGrant = deps.resolvePluginSubagentToolsAlsoAllow({
        pluginId,
        toolsAlsoAllow: params.toolsAlsoAllow,
      });
      const overrideRequested = Boolean(params.provider || params.model);
      const hasRequestScopeClient = Boolean(scope?.client);
      let allowOverride =
        hasRequestScopeClient && deps.canClientUseModelOverride(scope?.client ?? null);
      let allowSyntheticModelOverride = false;
      if (overrideRequested && !allowOverride && !hasRequestScopeClient) {
        const fallbackAuth = deps.authorizeFallbackModelOverride({
          pluginId: scope?.pluginId,
          provider: params.provider,
          model: params.model,
        });
        if (!fallbackAuth.allowed) {
          throw new Error(fallbackAuth.reason);
        }
        allowOverride = true;
        allowSyntheticModelOverride = true;
      }
      if (overrideRequested && !allowOverride) {
        throw new Error("provider/model override is not authorized for this plugin subagent run.");
      }
      const trustedCompletionRequested =
        Boolean(params.requesterSessionKey) ||
        params.expectsCompletionMessage === true ||
        params.approvalGrant !== undefined;
      const canForwardTrustedCompletionContext = deps.canTrustedOfficialPluginRequestScopes({
        pluginId,
        pluginOrigin: scope?.pluginOrigin,
        pluginTrustedOfficialInstall: scope?.pluginTrustedOfficialInstall,
      });
      if (trustedCompletionRequested && !canForwardTrustedCompletionContext) {
        throw new Error(
          "requesterSessionKey, expectsCompletionMessage, and approvalGrant are only available to bundled or trusted official plugins.",
        );
      }

      const payload = await deps.dispatchGatewayMethod<{ runId?: string; runtime?: unknown }>(
        "agent",
        {
          sessionKey: params.sessionKey,
          message: params.message,
          ...(canForwardTrustedCompletionContext && params.requesterSessionKey
            ? { requesterSessionKey: params.requesterSessionKey }
            : {}),
          ...(canForwardTrustedCompletionContext && params.expectsCompletionMessage === true
            ? { expectsCompletionMessage: true }
            : {}),
          ...(canForwardTrustedCompletionContext && params.approvalGrant !== undefined
            ? { approvalGrant: params.approvalGrant }
            : {}),
          deliver: params.deliver ?? false,
          ...(allowOverride && params.provider && { provider: params.provider }),
          ...(allowOverride && params.model && { model: params.model }),
          ...(params.extraSystemPrompt && { extraSystemPrompt: params.extraSystemPrompt }),
          ...(params.lane && { lane: params.lane }),
          ...(params.cwd && { cwd: params.cwd }),
          ...(params.lightContext === true && { bootstrapContextMode: "lightweight" }),
          idempotencyKey: params.idempotencyKey || randomUUID(),
        },
        {
          allowSyntheticModelOverride,
          agentRunTracking: "plugin_subagent",
          ...(pluginId ? { pluginRuntimeOwnerId: pluginId } : {}),
          ...(runtimePluginToolGrant ? { runtimePluginToolGrant } : {}),
        },
      );
      const runId = payload?.runId;
      if (typeof runId !== "string" || !runId) {
        throw new Error("Gateway agent method returned an invalid runId.");
      }
      const runtime = normalizeSubagentRunRuntime(payload?.runtime);
      return { runId, ...(runtime ? { runtime } : {}) };
    },
    async waitForRun(params) {
      const payload = await deps.dispatchGatewayMethod<{ status?: string; error?: string }>(
        "agent.wait",
        {
          runId: params.runId,
          ...(params.timeoutMs != null && { timeoutMs: params.timeoutMs }),
        },
      );
      let status = payload?.status;
      if (status === "completed" || status === "succeeded") {
        status = "ok";
      } else if (status === "error" && payload?.error?.trim().toLowerCase() === "completed") {
        status = "ok";
      }
      if (status !== "ok" && status !== "error" && status !== "timeout") {
        throw new Error(`Gateway agent.wait returned unexpected status: ${payload?.status}`);
      }
      return {
        status,
        ...(status !== "ok" &&
          typeof payload?.error === "string" &&
          payload.error && { error: payload.error }),
      };
    },
    getSessionMessages,
    async deleteSession(params) {
      const scope = deps.getPluginRuntimeGatewayRequestScope();
      const pluginId =
        typeof scope?.pluginId === "string" && scope.pluginId.trim()
          ? scope.pluginId.trim()
          : undefined;
      const pluginOwnedCleanupOptions = pluginId
        ? {
            pluginRuntimeOwnerId: pluginId,
            ...(!deps.hasAdminScope(scope?.client)
              ? {
                  forceSyntheticClient: true,
                  syntheticScopes: [deps.adminScope],
                }
              : {}),
          }
        : undefined;
      await deps.dispatchGatewayMethod(
        "sessions.delete",
        {
          key: params.sessionKey,
          deleteTranscript: params.deleteTranscript ?? true,
        },
        pluginOwnedCleanupOptions,
      );
    },
  };
}
