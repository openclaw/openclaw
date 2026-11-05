import { randomUUID } from "node:crypto";
import { expectDefined } from "@openclaw/normalization-core";
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
    /** Authorizes a model other than the turn's or session's own; throws when not allowed. */
    authorizeModelOverride: (model: ModelRef, authProfileId?: string) => void;
    resolveGatewayContext?: GatewayContextResolver;
    runtimeLifetime?: AbortSignal;
  },
): Promise<SubagentForkedTurnResult<T>> {
  const params = { ...request, tools: [...request.tools] };
  const { scope, pluginId, context, assertConversationAccess, runtimeLifetime } = deps;
  const { resolveGatewayContext } = deps;
  // Trust rule: a plugin may hand a fork only tools it uniquely registered, never core tools
  // or another plugin's tools. The source session's policy is checked again below.
  // Host-captured registration of the calling plugin; a reload or disable revokes it.
  const assertOwnerCurrent = scope?.assertSystemOwnerCurrent;
  if (!assertOwnerCurrent) {
    throw new Error("Plugin forked turns require a live plugin registration.");
  }
  assertOwnerCurrent();
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
      assertOwnerCurrent();
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
        const [
          { readActiveTranscriptEntryAnchorAsync },
          { readSessionForkTurn, prepareSessionFork, runSessionFork },
        ] = await Promise.all([
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
        // The anchored turn supplies its own requester and model, never the plugin.
        const turn = await readSessionForkTurn(source, params.signal);
        assertCurrent();
        if (!turn) {
          // Without the turn's own requester, sender-specific policy cannot be checked.
          throw new Error(
            `Session "${params.sessionKey}" no longer holds the input of entry "${params.through.entryId}".`,
          );
        }
        const sessionModel = resolveSessionModelRef(cfg, target.entry, agentId);
        const turnModel = turn.model ?? sessionModel;
        const override =
          params.provider && params.model ? splitTrailingAuthProfile(params.model) : undefined;
        // On the session's own provider the fork runs on the credential the session's turns
        // use (a user pin or an automatic rotation): its internal session has no stored
        // selection, so without this it could bill another profile and miss the turn's cache.
        const sessionProfile =
          turnModel.provider === sessionModel.provider
            ? target.entry.authProfileOverride?.trim()
            : undefined;
        const model = override
          ? {
              provider: expectDefined(params.provider, "override provider"),
              model: override.model,
              ...(override.profile ? { authProfileId: override.profile } : {}),
            }
          : { ...turnModel, ...(sessionProfile ? { authProfileId: sessionProfile } : {}) };
        // Running on the turn's or session's own model needs no override trust.
        const ownModel =
          !override?.profile &&
          [turnModel, sessionModel].some(
            (own) => own.provider === model.provider && own.model === model.model,
          );
        if (override && !ownModel) {
          deps.authorizeModelOverride(model, override.profile);
        }
        assertOperatorModelAllowed(execution.operatorAuthority, model);
        const prepared = await prepareSessionFork({
          config: cfg,
          source,
          tools,
          model,
          workspaceDir: resolveAgentWorkspaceDir(cfg, agentId),
          ...(turn.requester ? { requester: turn.requester } : {}),
          runtimePluginToolGrant,
        });
        assertCurrent();
        if (!prepared) {
          return { status: "refused", reason: "tool_policy" };
        }
        let admitted: SubagentForkedTurnSource | undefined;
        const value = await execution.run(() =>
          runSessionFork(
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
              ...(turn.requester ? { requester: turn.requester } : {}),
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
              // A revoked plugin's settlement code never runs; the call rejects instead.
              assertCurrent();
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
