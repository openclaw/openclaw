import { resolveReplyCompletion } from "../../agents/reply-completion.js";
import { resolveSessionRuntimeOverrideForProvider } from "../../agents/session-runtime-compat.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { SessionTranscriptRuntimeTarget } from "../../config/sessions/session-accessor.types.js";
import type { DecisionRuntimeV1 } from "../../decisions/types.js";
import type { UserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.types.js";
import { resolveRunAfterAutoFallbackPrimaryProbeRecheck } from "./agent-runner-auto-fallback.js";
import type { InternalFollowupRun } from "./agent-runner-execution.types.js";
import { resolveReplyCandidateRuntime } from "./agent-runner-runtime.js";
import { resolveQueuedReplyRuntimeConfig } from "./agent-runner-utils.js";
import { readGroupParticipationEvidence } from "./group-participation-context.js";
import {
  assessGroupAttention,
  type GroupParticipationConcern,
  type GroupParticipationEvidence,
} from "./group-participation-decisions.js";
import {
  readGroupParticipationInputs,
  recordGroupParticipationInput,
} from "./group-participation-inputs.js";
import { resolveReplyOperationAbortReason } from "./reply-operation-abort.js";
import type { ReplyOperation } from "./reply-run-registry.js";
import { runWithReplyOperationLifecycleAdmission } from "./reply-turn-admission.js";
import { readSourceReplyDeliveryRuntime } from "./source-reply-delivery-runtime.js";

type GroupParticipationMode = "ordinary" | "observe" | "engagement" | "opportunity";
export type GroupParticipationSnapshot = {
  revision: number;
  evidence: GroupParticipationEvidence;
  concerns: GroupParticipationConcern[];
};

export type GroupParticipationRun = ReturnType<typeof createGroupParticipationRun>;
const runs = new WeakMap<ReplyOperation, GroupParticipationRun>();
const runtime: DecisionRuntimeV1 = {
  evaluate: async (batch, options) => {
    const { evaluateDecision } = await import("../../decisions/runtime.js");
    return evaluateDecision(batch, options);
  },
};

function createGroupParticipationRun(params: {
  run: () => InternalFollowupRun;
  operation: ReplyOperation;
  target: SessionTranscriptRuntimeTarget;
  recorder: UserTurnTranscriptRecorder;
  onOrdinaryBehavior?: () => Promise<void>;
}) {
  const { operation, target } = params;
  const run = params.run();
  const originalExpectation = run.run.terminalReplyExpectation;
  const originalDeliveryMode = run.run.sourceReplyDeliveryMode ?? "automatic";
  let mode: GroupParticipationMode = "ordinary";
  let snapshot: GroupParticipationSnapshot | undefined;
  let live = true;
  let ordinaryRestoration: Promise<void> | undefined;
  void operation.ownerSettlement?.then(() => {
    live = false;
  });
  const timeoutMs = run.run.timeoutMs > 0 ? Math.min(run.run.timeoutMs, 30_000) : 30_000;
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
    current.run.terminalReplyExpectation =
      mode === "observe" || mode === "opportunity" ? "optional" : originalExpectation;
    for (const state of current.replyOperationRunStates ?? []) {
      state.replyCompletion = resolveReplyCompletion(
        current.run.terminalReplyExpectation ?? "required",
        "empty",
      );
    }
  };
  const restoreOrdinaryBehavior = async () => {
    const current = params.run().run;
    readSourceReplyDeliveryRuntime(current)?.applyPreparedMode(current, originalDeliveryMode);
    ordinaryRestoration ??= params.onOrdinaryBehavior?.();
    await ordinaryRestoration;
    assertCurrent();
  };
  const useOrdinaryBehavior = async () => {
    const wasPrivate = mode === "observe" || mode === "opportunity";
    mode = "ordinary";
    applyExpectation();
    if (wasPrivate || ordinaryRestoration) {
      await restoreOrdinaryBehavior();
    }
  };
  const refresh = async (): Promise<GroupParticipationSnapshot | undefined> => {
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      assertCurrent();
      const inputs = readGroupParticipationInputs(operation);
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
      });
      assertCurrent();
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        await useOrdinaryBehavior();
        return undefined;
      }
      const attention = await assessGroupAttention(runtime, evidence, {
        signal: operation.abortSignal,
        timeoutMs: remaining,
      });
      assertCurrent();
      if (attention.status === "unavailable") {
        await useOrdinaryBehavior();
        return undefined;
      }
      if (readGroupParticipationInputs(operation).revision !== inputs.revision) {
        continue;
      }
      snapshot = { revision: inputs.revision, evidence, concerns: attention.concerns };
      const wasPrivate = mode === "observe" || mode === "opportunity";
      mode = attention.concerns.some(
        (item) =>
          item.reason === "engagement" &&
          evidence.messages.some(
            (message) => message.id === item.messageId && message.admission === "current",
          ),
      )
        ? "engagement"
        : attention.concerns.length
          ? "opportunity"
          : "observe";
      applyExpectation();
      if (mode === "engagement" && wasPrivate) {
        await restoreOrdinaryBehavior();
      }
      return snapshot;
    }
  };
  return {
    get mode() {
      return mode;
    },
    get snapshot() {
      return snapshot;
    },
    get isPrivate() {
      return mode === "observe" || mode === "opportunity";
    },
    get ordinaryReplyExpectation() {
      return originalExpectation;
    },
    runtime,
    timeoutMs,
    refresh,
    useOrdinaryBehavior,
    isCurrent: (revision: number) => readGroupParticipationInputs(operation).revision === revision,
    publicationAuthority: (revision: number) => {
      assertCurrent();
      if (readGroupParticipationInputs(operation).revision !== revision) {
        return undefined;
      }
      return {
        recoveryMode: "reconcile-only" as const,
        assertCurrent: () => {
          assertCurrent();
          if (readGroupParticipationInputs(operation).revision !== revision) {
            throw new Error("The group conversation changed after this draft was approved");
          }
        },
      };
    },
  };
}

/** Preparation occurs before typing, maintenance agents, or a required reply obligation. */
export async function prepareGroupParticipationRun(params: {
  run: () => InternalFollowupRun;
  operation: ReplyOperation;
  sessionKey?: string;
  storePath?: string;
  sessionEntry?: SessionEntry;
  onOrdinaryBehavior?: () => Promise<void>;
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
  const config = resolveQueuedReplyRuntimeConfig(executionRun.config);
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
    onOrdinaryBehavior: params.onOrdinaryBehavior,
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
