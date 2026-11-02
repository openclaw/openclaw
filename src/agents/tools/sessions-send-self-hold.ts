import { isDeepStrictEqual } from "node:util";
import { formatErrorMessage } from "@openclaw/normalization-core/error-coercion";
import { getAgentToolExecutionContext } from "../../../packages/agent-core/src/tool-execution-context.js";
import { resolveReplyOperatorAuthorityKey } from "../../auto-reply/reply/reply-tool-authority.js";
import { getRuntimeConfig } from "../../config/config.js";
import { canonicalizeMainSessionAlias } from "../../config/sessions/main-session.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { resolveSqliteSessionKey } from "../../config/sessions/session-accessor.sqlite-scope-helpers.js";
import { captureSessionEntrySourceAssertion } from "../../config/sessions/session-entry-source-authority.js";
import type { PreparedSessionSourceAuthority } from "../../config/sessions/session-source-authority.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { readAgentSelfHeldRefusal } from "../../gateway/agent-turn/agent-admission-refusal.js";
import { readOperatorToolGatewayAuthority } from "../../gateway/operator-tool-gateway-authority.js";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import { captureExecRequestOwners } from "../../infra/exec-request-context.js";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import type { ReplyOperation } from "../../sessions/session-controller.contracts.js";
import { findSessionControllerOperationByRunId } from "../../sessions/session-controller.queries.js";
import { isCronSessionKey } from "../../sessions/session-key-utils.js";
import { resolveConversationCapabilityProfile } from "../conversation-capability-profile.js";
import { isConversationToolAllowed } from "../conversation-tool-policy-pipeline.js";
import { captureAgentPluginRuntimeRefresh } from "../plugin-runtime-refresh.js";
import { withSandboxRuntimeStatusInWorker } from "../sandbox/runtime-status.js";
import { resolveSandboxToolPolicyForAgent } from "../sandbox/tool-policy.js";
import { getLatestLiveSubagentRunByChildSessionKey } from "../subagents/registry/subagent-registry-read.js";
import { prepareSessionCapabilityRead } from "../subagents/spawn/subagent-session-store.js";
import { jsonResult } from "./common.js";
import {
  getGatewayToolCallerIdentity,
  resolveGatewayToolOperatorSelection,
} from "./gateway-caller-context.js";
import { handoffSessionTool } from "./session-tool-handoff.js";
import type { SessionsSendToolOptions } from "./sessions-send-tool.types.js";

type Refusal = NonNullable<ReturnType<typeof readAgentSelfHeldRefusal>>;
type Result = ReturnType<typeof jsonResult<Record<string, unknown>>>;
/** Replay runs the ordinary tool executor; its details settle as opaque outcomes. */
type ReplayResult = ReturnType<typeof jsonResult<unknown>>;
type Send = {
  runId: string;
  mode: "resume" | "followup";
  args: Record<string, unknown>;
  sessionKey: string;
  targetAgentId: string;
  sessionId: string;
  lifecycleRevision?: string;
  storePath: string;
  targetTask?: SessionsSendToolOptions["expectedTargetTask"];
  targetRun: SessionsSendToolOptions["expectedTargetRun"];
  requesterParentOwned: boolean;
};
type HeldSend = {
  send: Send;
  state:
    | { kind: "retained"; proof: Refusal }
    | { kind: "replaying" }
    | { kind: "settled"; result: unknown };
};
type Batch = {
  operations: Map<string, HeldSend>;
  requester: {
    origin: NonNullable<ReturnType<typeof getGatewayToolCallerIdentity>>["requesterOrigin"];
    selectedOrigin: ReturnType<typeof resolveGatewayToolOperatorSelection>["requesterOrigin"];
    authority: string;
    callerAuthority: string;
    invocationScopes: string[] | undefined;
    gatewayScopes: string[] | undefined;
  };
  ready: Promise<unknown>;
};
const batches = new WeakMap<ReplyOperation, Batch>();

/** Capture original identity and turn ownership; replay resolves config and policy afresh. */
export function createSelfHeldSendRetainer(
  options: SessionsSendToolOptions | undefined,
  replay: (
    options: SessionsSendToolOptions,
    args: Record<string, unknown>,
  ) => Promise<ReplayResult>,
) {
  const runId = options?.requesterTurnRunId ?? options?.runId;
  const sessionId = options?.agentSessionId ?? options?.sessionId;
  const operation = runId ? findSessionControllerOperationByRunId(runId) : undefined;
  const requestOwners = captureExecRequestOwners({ runId, sessionId });
  const refresh = captureAgentPluginRuntimeRefresh();
  const identity = {
    agentId: options?.agentId,
    agentSessionKey: options?.agentSessionKey,
    agentSessionId: sessionId,
    agentChannel: options?.agentChannel,
    requesterOrigin: options?.requesterOrigin,
    sandboxed: options?.sandboxed,
    completionOwner: options?.completionOwner,
    modelProvider: options?.modelProvider,
    modelId: options?.modelId,
  };
  const retain = async (proof: Refusal, send: Send, toolCallId: string): Promise<Result> => {
    const plugins = [...new Set(proof.held.map((held) => held.pluginId))];
    const notRetained = (why: string) =>
      jsonResult({
        status: "error",
        runId: send.runId,
        sessionKey: send.sessionKey,
        error:
          proof.admission.acceptance === "uncertain"
            ? "Outcome unknown; do not resend. After this turn, inspect run " + send.runId + "."
            : "This send was not delivered or retained (" +
              why +
              "). Finish this turn before inspecting the target and deciding whether to send again.",
        selfHold: { retained: false, acceptance: proof.admission.acceptance, plugins, why },
      });
    if (proof.admission.acceptance !== "not_accepted") {
      return notRetained("uncertain");
    }
    // Parent-owned sessions need their native task owner, not a root tool-handoff wake.
    if (send.requesterParentOwned) {
      return notRetained("unsupported-caller");
    }
    if (options?.swarmCollector) {
      return notRetained("collector");
    }
    if (
      isCronSessionKey(identity.agentSessionKey) ||
      options?.scheduledToolTargets?.placement !== undefined ||
      options?.workerPlacement ||
      options?.callGateway ||
      !operation ||
      !options?.onYield ||
      !sessionId
    ) {
      // Only a local root conversation can resume through this handoff.
      return notRetained("unsupported-caller");
    }
    const caller = getGatewayToolCallerIdentity();
    if (!caller) {
      return notRetained("unsupported-caller");
    }
    const selected = resolveGatewayToolOperatorSelection({ requireRequesterOrigin: true });
    selected.assertCurrent();
    // Comparison facts only: retain neither a turn-bound assertion nor its privileges.
    const requester: Batch["requester"] = {
      origin: caller.requesterOrigin,
      selectedOrigin: selected.requesterOrigin,
      authority: resolveReplyOperatorAuthorityKey(selected.operatorAuthority),
      callerAuthority: resolveReplyOperatorAuthorityKey(caller.operatorAuthority),
      invocationScopes: readOperatorToolGatewayAuthority()?.scopes.toSorted(),
      gatewayScopes: getPluginRuntimeGatewayRequestScope()?.client?.connect.scopes?.toSorted(),
    };
    let batch = batches.get(operation);
    if (batch && !isDeepStrictEqual(batch.requester, requester)) {
      return notRetained("different-requester");
    }
    const held: HeldSend = { send, state: { kind: "retained", proof } };
    const context = getAgentToolExecutionContext();
    const yieldMode =
      context?.toolCall.id === toolCallId &&
      !context.hasUnobservedAsyncToolResults &&
      refresh.requestSource() !== "tool"
        ? "conditional"
        : "after_turn";
    if (!batch) {
      batch = { operations: new Map([[send.runId, held]]), requester, ready: Promise.resolve() };
      batches.set(operation, batch);
      const ownedBatch = batch;
      batch.ready = handoffSessionTool({
        name: "Session send",
        operation,
        runId,
        sessionId,
        requestOwners,
        onYield: options.onYield,
        yield: yieldMode,
        retainRequester: true,
        senderIsOwner: options.senderIsOwner,
        run: async (scope) => {
          const outcomes: unknown[] = [];
          for (const item of ownedBatch.operations.values()) {
            if (item.state.kind !== "retained") {
              continue;
            }
            let releasePolicy: (() => void) | undefined;
            let sandboxSource: PreparedSessionSourceAuthority | undefined;
            try {
              const retainedProof = item.state.proof;
              const outcomesByHold = await racePromiseWithAbortSignal(
                () =>
                  Promise.all(retainedProof.held.map(({ operation: reload }) => reload.settled)),
                scope.signal,
              );
              scope.signal.throwIfAborted();
              scope.assertCurrent();
              if (
                outcomesByHold.some(
                  (outcome, index) =>
                    outcome.kind === "failed" ||
                    outcome.unavailablePluginIds.includes(retainedProof.held[index]!.pluginId),
                )
              ) {
                const result = {
                  runId: item.send.runId,
                  status: "not_delivered",
                  reason: "reload_failed",
                };
                item.state = { kind: "settled", result };
                outcomes.push(result);
                continue;
              }
              const config = getRuntimeConfig();
              const assertPolicyCurrent = () => {
                scope.signal.throwIfAborted();
                scope.assertCurrent();
                if (getRuntimeConfig() !== config) {
                  throw new Error("Policy changed during retained send admission.");
                }
              };
              let classificationEntry: SessionEntry | undefined;
              const prepared = await withSandboxRuntimeStatusInWorker(
                { cfg: config, sessionKey: identity.agentSessionKey, agentId: identity.agentId },
                {
                  env: process.env,
                  cwd: process.cwd(),
                  assertCurrent: assertPolicyCurrent,
                  assertEntryCurrent: (entry) => {
                    classificationEntry = entry;
                  },
                },
                async (currentSandbox) => {
                  const sandboxed = identity.sandboxed === true || currentSandbox.sandboxed;
                  // The classifier and capability preparation can observe different writes.
                  // Keep its entry predicates live through each final admission, not only
                  // through the classification helper's preparation-time checks.
                  sandboxSource = await captureSessionEntrySourceAssertion({
                    scope: {
                      agentId: currentSandbox.classificationAgentId,
                      sessionKey: canonicalizeMainSessionAlias({
                        cfg: config,
                        agentId: currentSandbox.classificationAgentId,
                        sessionKey: resolveSqliteSessionKey(
                          currentSandbox.classificationSessionKey,
                          currentSandbox.classificationAgentId,
                        ),
                      }),
                      storePath: resolveSessionStorePathCore(config.session?.store, {
                        agentId: currentSandbox.classificationAgentId,
                      }),
                    },
                    expected: classificationEntry,
                    fields: ["sandboxMode", "sandbox", "createdActor"],
                    assertCurrent: assertPolicyCurrent,
                    assertHostCurrent: assertPolicyCurrent,
                    refuse: () => {
                      throw new Error("Sandbox policy changed during retained send admission.");
                    },
                  }).prepareSessionSource();
                  const currentSource = sandboxSource;
                  const policy = await prepareSessionCapabilityRead(() => {
                    currentSource.assertCurrent();
                    assertPolicyCurrent();
                    // Conversation availability belongs to the original ingress, not a
                    // personally selected participant. That participant's independent
                    // authority remains fenced by the retained handoff source.
                    const profile = resolveConversationCapabilityProfile({
                      config,
                      sessionKey: identity.agentSessionKey,
                      agentId: identity.agentId,
                      requesterOrigin: ownedBatch.requester.origin,
                      messageProvider: identity.agentChannel,
                      senderIsOwner: options.senderIsOwner,
                      modelProvider: identity.modelProvider,
                      modelId: identity.modelId,
                      sandboxToolPolicy: sandboxed
                        ? resolveSandboxToolPolicyForAgent(config, identity.agentId)
                        : undefined,
                    });
                    if (!isConversationToolAllowed(profile, "sessions_send")) {
                      throw new Error("Current tool policy no longer permits sessions_send.");
                    }
                  });
                  releasePolicy = policy.release;
                  return { sandboxed, policy };
                },
              );
              // Finish all preparation checks before the opaque executor. A known
              // result must not be replaced by a later classification check.
              const assertCurrent = prepared.policy.read;
              assertCurrent();
              item.state = { kind: "replaying" };
              const result = await replay(
                {
                  ...identity,
                  sandboxed: prepared.sandboxed,
                  config,
                  signal: scope.signal,
                  assertSourceCurrent: assertCurrent,
                  idempotencyKey: item.send.runId,
                  expectedTargetSessionId: item.send.sessionId,
                  expectedTargetStorePath: item.send.storePath,
                  expectedTargetLifecycleRevision: item.send.lifecycleRevision ?? null,
                  expectedTargetTask: item.send.targetTask,
                  expectedTargetRun: item.send.targetRun,
                  retainedReplay: true,
                },
                {
                  ...item.send.args,
                  sessionKey: item.send.sessionKey,
                  agentId: item.send.targetAgentId,
                  label: undefined,
                  mode: item.send.mode,
                },
              );
              item.state = { kind: "settled", result: result.details };
              outcomes.push(result.details);
            } catch (error) {
              const result = {
                runId: item.send.runId,
                status: item.state.kind === "retained" ? "not_delivered" : "uncertain",
                error: formatErrorMessage(error),
              };
              item.state = { kind: "settled", result };
              outcomes.push(result);
            } finally {
              releasePolicy?.();
              await sandboxSource?.release?.();
            }
          }
          return { outcomes };
        },
        formatResult: (payload) => JSON.stringify(payload),
      }).catch((error: unknown) => {
        batches.delete(operation);
        throw error;
      });
    } else if (!batch.operations.has(send.runId)) {
      batch.operations.set(send.runId, held);
    }
    try {
      await batch.ready;
    } catch {
      return notRetained("handoff-unavailable");
    }
    return jsonResult({
      status: "started",
      async: true,
      runId: send.runId,
      sessionKey: send.sessionKey,
      mode: send.mode,
      retained: {
        acceptance: "not_accepted",
        reason: "plugin_reload_self_hold",
        plugins,
        durability: "process",
        continuation: "after_turn",
      },
      message:
        "Not delivered yet: this turn holds a reloading plugin. This exact send is kept for one submission after this turn finishes and the reload settles, unless stopped or cancelled first. If it proceeds, this conversation continues with its result. Do not duplicate a pending send. Stop or cancellation can prevent pending replay but cannot undo an already accepted send. This retention is process-local. After Stop, cancellation, or a Gateway restart, inspect the original run before deciding whether to retry; acceptance may already have occurred.",
    });
  };
  return Object.assign(retain, {
    capture(input: {
      runId: string;
      sessionKey: string;
      targetAgentId: string;
      requesterParentOwned: boolean;
      args: Record<string, unknown>;
      toolCallId: string;
      readTarget: () => { storePath: string; entry: SessionEntry | undefined };
    }) {
      const original = getLatestLiveSubagentRunByChildSessionKey(
        input.sessionKey,
        undefined,
        input.targetAgentId,
      );
      const targetRun = original
        ? {
            runId: original.runId,
            taskRunId: original.taskRunId,
            generation: original.generation,
            createdAt: original.createdAt,
          }
        : null;
      return (proof: Refusal, mode: Send["mode"], targetTask?: Send["targetTask"]) => {
        const target = input.readTarget();
        if (!target.entry) {
          throw new Error("Retained send requires its refused target incarnation");
        }
        return retain(
          proof,
          {
            runId: input.runId,
            sessionKey: input.sessionKey,
            targetAgentId: input.targetAgentId,
            requesterParentOwned: input.requesterParentOwned,
            args:
              mode === "resume"
                ? { ...input.args, timeoutSeconds: 0, watch: undefined }
                : input.args,
            mode,
            targetRun,
            targetTask,
            sessionId: target.entry.sessionId,
            lifecycleRevision: target.entry.lifecycleRevision,
            storePath: target.storePath,
          },
          input.toolCallId,
        );
      };
    },
  });
}
