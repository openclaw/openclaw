import { randomUUID } from "node:crypto";
import { expectDefined } from "@openclaw/normalization-core";
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import {
  assertOperatorModelAllowed,
  type AdmittedRunOperatorAuthority,
} from "../agents/admitted-run-context.js";
import { resolveAgentWorkspaceDir, resolveSessionAgentIdsStrict } from "../agents/agent-scope.js";
import { splitTrailingAuthProfile } from "../agents/model-ref-profile.js";
import type { ModelRef } from "../agents/model-ref-shared.js";
import { NO_MODEL_CONFIGURED_MESSAGE } from "../agents/model-selection-config.js";
import { normalizeToolPolicyName } from "../agents/tool-policy.js";
import type { NormalizedUsage } from "../agents/usage.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getAgentRunContext } from "../infra/agent-run-registry.js";
import type { PluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.types.js";
import type { RuntimePluginToolGrant } from "../plugins/runtime/tool-grant.js";
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

type ForkOutcome = Parameters<SubagentForkedTurnParams<unknown>["onSettled"]>[0];

/** Core tools a plugin fork may run under the source session's own policy. */
const FORK_SESSION_TOOLS = new Set(["read", "ls", "exec"]);

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
  // Trust rule: a plugin may let a fork run tools it uniquely registered, plus read, ls and exec.
  // Those three never join the plugin grant, which widens the session's tool profile: the
  // source session's own policy must already allow them (checked below), and exec runs only on
  // the owner's turns. Other core tools and other plugins' tools are refused.
  // Host-captured registration of the calling plugin; a reload or disable revokes it.
  const assertOwnerCurrent = scope?.assertSystemOwnerCurrent;
  if (!assertOwnerCurrent) {
    throw new Error("Plugin forked turns require a live plugin registration.");
  }
  assertOwnerCurrent();
  const isSessionTool = (tool: string) => FORK_SESSION_TOOLS.has(normalizeToolPolicyName(tool));
  const sessionTools = params.tools.filter(isSessionTool).map(normalizeToolPolicyName);
  const runtimePluginToolGrant = resolvePluginSubagentToolsAlsoAllow({
    pluginId,
    toolsAlsoAllow: params.tools.filter((tool) => !isSessionTool(tool)),
  });
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
        if (!target.entry?.sessionId) {
          throw new Error(`No active session context for "${params.sessionKey}".`);
        }
        if (params.through && target.entry.sessionId !== params.through.sessionId) {
          throw new Error(
            `Session "${params.sessionKey}" was reset or replaced after the requested entry.`,
          );
        }
        return await forkPluginSession<T>({
          cfg,
          agentId,
          pluginId,
          session: {
            key: target.canonicalKey,
            storePath: target.storePath,
            sessionId: target.entry.sessionId,
            entry: target.entry,
          },
          ...(params.through ? { entryId: params.through.entryId } : {}),
          prompt: params.prompt,
          tools: [...(runtimePluginToolGrant?.toolNames ?? []), ...sessionTools],
          runtimePluginToolGrant,
          ...(params.provider && params.model
            ? { override: { provider: params.provider, model: params.model } }
            : {}),
          authorizeModelOverride: deps.authorizeModelOverride,
          operatorAuthority: execution.operatorAuthority,
          runId,
          timeoutMs: resolveTimerTimeoutMs(params.timeoutMs, 120_000),
          ...(params.maxTokens !== undefined ? { maxTokens: params.maxTokens } : {}),
          abortSignal: AbortSignal.any(
            [params.signal, runtimeLifetime, execution.signal].filter(
              (candidate): candidate is AbortSignal => candidate !== undefined,
            ),
          ),
          assertCurrent,
          run: (work) => execution.run(work),
          onSettled: (outcome) => params.onSettled(outcome),
        });
      },
    );
  } finally {
    execution.release();
  }
}

/**
 * One plugin-owned session fork through an active entry of a loaded session: the anchored
 * turn supplies the requester and model, the session's policy admits the tools, then
 * `runSessionFork` runs it. `forkSession` and `runForkedTurn` both fork through here.
 */
export async function forkPluginSession<T>(input: {
  cfg: OpenClawConfig;
  agentId: string;
  pluginId: string;
  session: { key: string; storePath: string; sessionId: string; entry: SessionEntry };
  /** The entry the fork reads through; the session's latest entry when omitted. */
  entryId?: string;
  prompt: string;
  tools: readonly string[];
  runtimePluginToolGrant?: RuntimePluginToolGrant;
  override?: { provider: string; model: string };
  authorizeModelOverride?: (model: ModelRef, authProfileId?: string) => void;
  operatorAuthority: AdmittedRunOperatorAuthority | undefined;
  runId: string;
  timeoutMs: number;
  maxTokens?: number;
  abortSignal: AbortSignal;
  assertCurrent: () => void;
  run: <R>(work: () => Promise<R>) => Promise<R>;
  onSettled: (outcome: ForkOutcome, usage: NormalizedUsage | undefined) => Promise<T> | T;
}): Promise<SubagentForkedTurnResult<T>> {
  const { cfg, agentId, session, assertCurrent } = input;
  // Lazy: the fork runtime stays out of the Gateway startup chunk.
  const [
    { readActiveTranscriptEntryAnchorAsync },
    { readSessionForkTurn, prepareSessionFork, resolveSessionForkModel, runSessionFork },
    { SessionManager },
  ] = await Promise.all([
    import("../config/sessions/session-transcript-anchor-read.js"),
    import("../agents/session-fork-run.js"),
    import("../agents/sessions/session-manager.js"),
  ]);
  const scope = {
    agentId,
    sessionId: session.sessionId,
    sessionKey: session.key,
    storePath: session.storePath,
  };
  // Only messages anchor a fork; the leaf may be a custom entry such as the prompt checkpoint.
  const entryId =
    input.entryId ??
    (await SessionManager.openModelContextAsync(scope, { signal: input.abortSignal }))
      .getBranch()
      .findLast((entry) => entry.type === "message")?.id;
  assertCurrent();
  if (!entryId) {
    throw new Error(`No active session context for "${session.key}".`);
  }
  const source = await readActiveTranscriptEntryAnchorAsync({ ...scope, entryId });
  assertCurrent();
  if (!source) {
    throw new Error(`Session "${session.key}" has no active entry "${entryId}".`);
  }
  // The anchored turn supplies its own requester and model, never the plugin.
  const turn = await readSessionForkTurn(source, input.abortSignal);
  assertCurrent();
  if (!turn && input.tools.length > 0) {
    // Without the turn's own requester, sender-specific tool policy cannot be checked. A
    // tool-free fork runs nothing, so it proceeds on the session's own facts.
    throw new Error(`Session "${session.key}" no longer holds the input of entry "${entryId}".`);
  }
  const {
    sessionModel,
    turnModel,
    model: sessionForkModel,
  } = resolveSessionForkModel({
    cfg,
    agentId,
    entry: session.entry,
    turnModel: turn?.model,
  });
  const override = input.override ? splitTrailingAuthProfile(input.override.model) : undefined;
  const model = override
    ? {
        provider: expectDefined(input.override?.provider, "override provider"),
        model: override.model,
        ...(override.profile ? { authProfileId: override.profile } : {}),
      }
    : sessionForkModel;
  if (!model) {
    throw new Error(NO_MODEL_CONFIGURED_MESSAGE);
  }
  // Running on the turn's or session's own model needs no override trust.
  const ownModel =
    !override?.profile &&
    [turnModel, sessionModel].some(
      (own) => own !== undefined && own.provider === model.provider && own.model === model.model,
    );
  if (override && !ownModel) {
    expectDefined(input.authorizeModelOverride, "model override authorization")(
      model,
      override.profile,
    );
  }
  assertOperatorModelAllowed(input.operatorAuthority, model);
  const prepared = await prepareSessionFork({
    config: cfg,
    source,
    tools: input.tools,
    model,
    workspaceDir: resolveAgentWorkspaceDir(cfg, agentId),
    ...(turn?.requester ? { requester: turn.requester } : {}),
    ...(input.runtimePluginToolGrant
      ? { runtimePluginToolGrant: input.runtimePluginToolGrant }
      : {}),
  });
  assertCurrent();
  if (!prepared) {
    return { status: "refused", reason: "tool_policy" };
  }
  let admitted: SubagentForkedTurnSource | undefined;
  const value = await input.run(() =>
    runSessionFork(
      {
        config: cfg,
        source,
        prompt: input.prompt,
        tools: input.tools,
        runId: input.runId,
        // Lane, admission origin and diagnostics belong to the calling plugin.
        owner: `plugin:${input.pluginId}`,
        model,
        workspaceDir: prepared.workspaceDir,
        ...(turn?.requester ? { requester: turn.requester } : {}),
        ...(input.runtimePluginToolGrant
          ? { runtimePluginToolGrant: input.runtimePluginToolGrant }
          : {}),
        timeoutMs: input.timeoutMs,
        ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
        abortSignal: input.abortSignal,
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
        const base = { runId: input.runId, ...(admitted ? { source: admitted } : {}) };
        if (!outcome.ok) {
          return await input.onSettled(
            { ...base, ok: false, error: outcome.error, cancelled: outcome.cancelled },
            undefined,
          );
        }
        const text = outcome.result.payloads
          ?.filter((payload) => !payload.isError && payload.text)
          .map((payload) => payload.text)
          .join("\n");
        return await input.onSettled(
          { ...base, ok: true, ...(text ? { text } : {}) },
          outcome.result.meta?.agentMeta?.usage,
        );
      },
    ),
  );
  return { status: "settled", runId: input.runId, value };
}
