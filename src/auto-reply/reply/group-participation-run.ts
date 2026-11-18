import { isDecisionAssistanceEligible } from "../../agents/decision-assistance.js";
import { resolveDecisionModelSetting } from "../../agents/decision-model-setting.js";
import { resolveReplyCompletion } from "../../agents/reply-completion.js";
import { resolveSessionRuntimeOverrideForProvider } from "../../agents/session-runtime-compat.js";
import {
  createRuntimeConfigReader,
  getRuntimeConfigSnapshot,
  getRuntimeConfigSnapshotMetadata,
  selectLiveRuntimeConfig,
} from "../../config/runtime-snapshot.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { SessionTranscriptRuntimeTarget } from "../../config/sessions/session-accessor.types.js";
import type { DecisionRuntimeV1 } from "../../decisions/runtime-types.js";
import type { ReplyOperation } from "../../sessions/session-controller.js";
import type { UserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.types.js";
import { resolveRunAfterAutoFallbackPrimaryProbeRecheck } from "./agent-runner-auto-fallback.js";
import { resolveReplyCandidateRuntime } from "./agent-runner-runtime.js";
import { readGroupParticipationEvidence } from "./group-participation-context.js";
import { assessGroupAttention } from "./group-participation-decisions.js";
import {
  readGroupParticipationInputs,
  recordGroupParticipationInput,
} from "./group-participation-inputs.js";
import type { InternalFollowupRun } from "./queue/types.js";
import { resolveReplyOperationAbortReason } from "./reply-operation-abort.js";
import { runWithReplyOperationLifecycleAdmission } from "./reply-turn-admission-lifecycle.js";

type GroupParticipationMode = "ordinary" | "observe" | "reply";

export type GroupParticipationRun = ReturnType<typeof createGroupParticipationRun>;
const runs = new WeakMap<ReplyOperation, GroupParticipationRun>();

function createGroupParticipationRun(params: {
  run: () => InternalFollowupRun;
  operation: ReplyOperation;
  target: SessionTranscriptRuntimeTarget;
  recorder: UserTurnTranscriptRecorder;
}) {
  const { operation, target } = params;
  const run = params.run();
  const originalExpectation = run.run.terminalReplyExpectation;
  let mode: GroupParticipationMode = "ordinary";
  let assessedRevision: number | undefined;
  let live = true;
  const readConfig = createRuntimeConfigReader(run.run.config);
  const currentSelection = () => {
    const config = readConfig();
    if (!isDecisionAssistanceEligible(config, run.run.agentId)) {
      return undefined;
    }
    const model = resolveDecisionModelSetting(config, run.run.agentId);
    const revision =
      config === getRuntimeConfigSnapshot()
        ? getRuntimeConfigSnapshotMetadata()?.revision
        : "scoped";
    return model ? `${revision}:${model.provider}/${model.model}` : undefined;
  };
  let selection = currentSelection();
  const runtime: DecisionRuntimeV1 = {
    evaluate: async (batch, options) => {
      const { evaluateDecision } = await import("../../decisions/runtime.js");
      assertCurrent();
      if (!selection || selection !== currentSelection()) {
        return { status: "unavailable", reason: "disabled" };
      }
      const admittedSelection = selection;
      return evaluateDecision(batch, {
        ...options,
        // The shared runtime carries this live owner check through provider
        // preparation to guarded HTTP dispatch and answer acceptance.
        admit: () => {
          assertCurrent();
          return admittedSelection === currentSelection();
        },
      });
    },
  };
  void operation.ownerSettlement?.then(() => {
    live = false;
  });
  const timeoutMs = run.run.timeoutMs > 0 ? Math.min(run.run.timeoutMs, 30_000) : 30_000;
  const deadline = performance.now() + timeoutMs;
  const assertCurrent = () => {
    operation.abortSignal.throwIfAborted();
    run.operatorAuthority?.assertCurrent();
    if (resolveReplyOperationAbortReason(operation) || operation.result?.kind === "failed") {
      throw new Error("The group participation run no longer owns a reply");
    }
    if (!live) {
      throw new Error("The group participation run has settled");
    }
  };
  const applyExpectation = () => {
    const current = params.run();
    current.run.terminalReplyExpectation = mode === "observe" ? "optional" : originalExpectation;
    for (const state of current.replyOperationRunStates ?? []) {
      state.replyCompletion = resolveReplyCompletion(
        current.run.terminalReplyExpectation ?? "required",
        "empty",
      );
    }
  };
  const useOrdinaryBehavior = () => {
    mode = "ordinary";
    applyExpectation();
    assertCurrent();
  };
  const refresh = async (): Promise<void> => {
    for (;;) {
      assertCurrent();
      selection = currentSelection();
      if (!selection || performance.now() >= deadline) {
        useOrdinaryBehavior();
        return;
      }
      const inputs = readGroupParticipationInputs(operation);
      if (inputs.requiresOrdinaryBehavior) {
        useOrdinaryBehavior();
        return;
      }
      const evidence = await readGroupParticipationEvidence({
        agentId: target.agentId,
        agentName: run.groupParticipation?.agentName,
        target: { ...target, sessionId: operation.sessionId },
        sourceMessageId: run.messageId,
        replyToText: run.groupParticipation?.replyToText,
        recorder: params.recorder,
        acceptedInputs: inputs.sources,
        adoptedRecorders: inputs.adoptedRecorders,
        signal: operation.abortSignal,
        timeoutMs: deadline - performance.now(),
      });
      assertCurrent();
      if (selection !== currentSelection()) {
        continue;
      }
      if (!evidence) {
        useOrdinaryBehavior();
        return;
      }
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        useOrdinaryBehavior();
        return;
      }
      const attention = await assessGroupAttention(runtime, evidence, {
        signal: operation.abortSignal,
        timeoutMs: remaining,
      });
      assertCurrent();
      if (selection !== currentSelection()) {
        continue;
      }
      if (attention.status === "unavailable") {
        useOrdinaryBehavior();
        return;
      }
      if (readGroupParticipationInputs(operation).revision !== inputs.revision) {
        continue;
      }
      assessedRevision = inputs.revision;
      mode = attention.shouldReply ? "reply" : "observe";
      applyExpectation();
      return;
    }
  };
  const isCurrent = () =>
    assessedRevision !== undefined &&
    selection !== undefined &&
    selection === currentSelection() &&
    readGroupParticipationInputs(operation).revision === assessedRevision;
  return {
    get mode() {
      return mode;
    },
    get isObserving() {
      return mode === "observe";
    },
    refresh,
    useOrdinaryBehavior,
    isCurrent,
  };
}

/** Preparation occurs before typing, maintenance agents, or a required reply obligation. */
export async function prepareGroupParticipationRun(params: {
  run: () => InternalFollowupRun;
  operation: ReplyOperation;
  sessionKey?: string;
  storePath?: string;
  sessionEntry?: SessionEntry;
}): Promise<GroupParticipationRun | undefined> {
  const { operation } = params;
  const run = params.run();
  const existing = runs.get(operation);
  if (existing) {
    return existing;
  }
  if (
    !run.groupParticipation ||
    !run.userTurnTranscriptRecorder ||
    !params.sessionKey ||
    !params.storePath
  ) {
    return undefined;
  }
  const executionRun = resolveRunAfterAutoFallbackPrimaryProbeRecheck({
    run: run.run,
    entry: params.sessionEntry,
    sessionKey: params.sessionKey,
  });
  const config = selectLiveRuntimeConfig(executionRun.config);
  if (!isDecisionAssistanceEligible(config, run.run.agentId)) {
    return undefined;
  }
  if (
    resolveReplyCandidateRuntime({
      run: executionRun,
      config,
      provider: executionRun.provider,
      model: executionRun.model,
      sessionEntry: params.sessionEntry,
      sessionRuntimeOverride: resolveSessionRuntimeOverrideForProvider({
        provider: executionRun.provider,
        entry: params.sessionEntry,
        cfg: config,
      }),
    }).useCliExecution
  ) {
    return undefined;
  }
  recordGroupParticipationInput(operation, run, "initial");
  const owner = createGroupParticipationRun({
    run: params.run,
    operation,
    recorder: run.userTurnTranscriptRecorder,
    target: {
      agentId: run.run.agentId,
      sessionId: operation.sessionId,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
    },
  });
  await runWithReplyOperationLifecycleAdmission(operation, owner.refresh);
  runs.set(operation, owner);
  return owner;
}

export function readGroupParticipationRun(operation: ReplyOperation | undefined) {
  return operation ? runs.get(operation) : undefined;
}
