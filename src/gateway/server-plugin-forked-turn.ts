import { randomUUID } from "node:crypto";
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { assertOperatorModelAllowed } from "../agents/admitted-run-context.js";
import { resolveAgentWorkspaceDir, resolveSessionAgentIdsStrict } from "../agents/agent-scope.js";
import { splitTrailingAuthProfile } from "../agents/model-ref-profile.js";
import type { ModelRef } from "../agents/model-ref-shared.js";
import { resolveSessionModelRef } from "../agents/session-model-ref.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getAgentRunContext } from "../infra/agent-run-registry.js";
import type { PluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.types.js";
import type {
  SubagentForkedTurnParams,
  SubagentForkedTurnResult,
  SubagentForkedTurnSource,
} from "../plugins/runtime/types.js";
import type { GatewayContextResolver, GatewayRequestContext } from "./server-methods/types.js";
import {
  prepareInProcessAgentExecution,
  withInProcessGatewayRead,
} from "./server-plugin-in-process-dispatch.js";
import { resolvePluginSubagentToolsAlsoAllow } from "./server-plugin-runtime-client.js";
import { loadGatewaySessionEntryReadOnlyInWorker } from "./session-utils-store-worker.js";

/**
 * Plugin adapter over the core session fork owner: resolves the caller's identity, its own
 * tools, the `through` anchor and the model, then runs `runSessionFork` with the plugin as owner.
 */
export async function runPluginForkedTurn<T>(
  request: SubagentForkedTurnParams<T>,
  deps: {
    scope: PluginRuntimeGatewayRequestScope | undefined;
    pluginId: string;
    context: GatewayRequestContext;
    assertConversationAccess: (cfg: OpenClawConfig) => void;
    /** The plugin's subagent model-override policy, already authorized for this request. */
    assertModelAllowed: (model: ModelRef, authProfileId?: string) => void;
    resolveGatewayContext?: GatewayContextResolver;
    runtimeLifetime?: AbortSignal;
  },
): Promise<SubagentForkedTurnResult<T>> {
  const params = { ...request, tools: [...request.tools] };
  const { scope, pluginId, context, assertConversationAccess, runtimeLifetime } = deps;
  const { resolveGatewayContext } = deps;
  // Trust rule: a plugin may hand a fork only tools it uniquely registered, never core tools
  // or another plugin's tools. The source session's policy is checked again below.
  const runtimePluginToolGrant = resolvePluginSubagentToolsAlsoAllow({
    pluginId,
    toolsAlsoAllow: params.tools,
  });
  const tools = runtimePluginToolGrant?.toolNames ?? [];
  if (Boolean(params.provider) !== Boolean(params.model)) {
    throw new Error("Plugin forked turn model overrides need both provider and model.");
  }
  const runId = params.runId?.trim() || randomUUID();
  if (getAgentRunContext(runId)) {
    throw new Error(`Plugin forked turn run id "${runId}" is already in use.`);
  }
  const { sessionAgentId: agentId } = resolveSessionAgentIdsStrict({
    sessionKey: params.sessionKey,
    config: context.getRuntimeConfig(),
  });
  const execution = await prepareInProcessAgentExecution({
    agentId,
    pluginRuntimeOwnerId: pluginId,
    resolveGatewayContext,
  });
  try {
    const assertExecutionCurrent = () => {
      runtimeLifetime?.throwIfAborted();
      execution.assertCurrent();
      assertConversationAccess(execution.context.getRuntimeConfig());
    };
    await execution.authorize();
    assertExecutionCurrent();
    return await withInProcessGatewayRead(
      {
        method: "sessions.get",
        requestParams: { key: params.sessionKey },
        scope,
        resolveGatewayContext,
        callerAuthorityError: "Plugin forked turn caller authority expired.",
      },
      async (_resolved, assertReadCurrent): Promise<SubagentForkedTurnResult<T>> => {
        const assertCurrent = () => {
          assertExecutionCurrent();
          assertReadCurrent();
        };
        const cfg = execution.context.getRuntimeConfig();
        const target = await loadGatewaySessionEntryReadOnlyInWorker({
          cfg,
          key: params.sessionKey,
          agentId,
          assertActive: assertCurrent,
        });
        if (!target.entry?.sessionId || target.entry.sessionId !== params.through.sessionId) {
          throw new Error(
            `Session "${params.sessionKey}" was reset or replaced after the requested entry.`,
          );
        }
        // Lazy: the fork runtime stays out of the Gateway startup chunk.
        const [{ readActiveTranscriptEntryAnchorAsync }, sessionFork] = await Promise.all([
          import("../config/sessions/session-transcript-anchor-read.js"),
          import("../agents/session-fork-run.js"),
        ]);
        const source = await readActiveTranscriptEntryAnchorAsync({
          agentId,
          sessionId: target.entry.sessionId,
          sessionKey: target.canonicalKey,
          storePath: target.storePath,
          entryId: params.through.entryId,
        });
        assertCurrent();
        if (!source) {
          throw new Error(
            `Session "${params.sessionKey}" has no active entry "${params.through.entryId}".`,
          );
        }
        const sessionModel = resolveSessionModelRef(cfg, target.entry, agentId);
        const authProfileId = params.model
          ? splitTrailingAuthProfile(params.model).profile
          : undefined;
        const model =
          params.provider && params.model
            ? {
                provider: params.provider,
                model: splitTrailingAuthProfile(params.model).model,
                ...(authProfileId ? { authProfileId } : {}),
              }
            : sessionModel;
        deps.assertModelAllowed(model, authProfileId);
        assertOperatorModelAllowed(execution.operatorAuthority, model);
        const prepared = await sessionFork.prepareSessionFork({
          config: cfg,
          source,
          tools,
          model,
          workspaceDir: resolveAgentWorkspaceDir(cfg, agentId),
          runtimePluginToolGrant,
        });
        assertCurrent();
        if (!prepared) {
          return { status: "refused", reason: "tool_policy" };
        }
        let admitted: SubagentForkedTurnSource | undefined;
        const value = await execution.run(() =>
          sessionFork.runSessionFork(
            {
              config: cfg,
              source,
              prompt: params.prompt,
              tools,
              runId,
              // Lane, admission origin and diagnostics belong to the calling plugin.
              owner: `plugin:${pluginId}`,
              model,
              workspaceDir: prepared.workspaceDir,
              runtimePluginToolGrant,
              timeoutMs: resolveTimerTimeoutMs(params.timeoutMs, 120_000),
              abortSignal: AbortSignal.any(
                [params.signal, runtimeLifetime, execution.signal].filter(
                  (candidate): candidate is AbortSignal => candidate !== undefined,
                ),
              ),
              assertCallerCurrent: assertCurrent,
              onSourceAdmitted: (entry) => {
                admitted = {
                  sessionId: entry.sessionId,
                  lifecycleRevision: entry.lifecycleRevision ?? null,
                };
              },
            },
            async (outcome) => {
              const base = { runId, ...(admitted ? { source: admitted } : {}) };
              const text = outcome.ok
                ? outcome.result.payloads
                    ?.filter((payload) => !payload.isError && payload.text)
                    .map((payload) => payload.text)
                    .join("\n")
                : undefined;
              return await params.onSettled(
                outcome.ok
                  ? { ...base, ok: true, ...(text ? { text } : {}) }
                  : { ...base, ok: false, error: outcome.error, cancelled: outcome.cancelled },
              );
            },
          ),
        );
        return { status: "settled", runId, value };
      },
    );
  } finally {
    execution.release();
  }
}
