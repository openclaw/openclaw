import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { WorkerTranscriptMessage } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import {
  WORKER_INFERENCE_MAX_CONTEXT_MESSAGES,
  WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES,
} from "../../../packages/gateway-protocol/src/schema/worker-inference.js";
import {
  getAdmittedRunDelegatedAuthority,
  readAdmittedRunOperatorAuthority,
  resolvePreparedRunAdmission,
  resolveAdmittedRunActiveAssertion,
} from "../../agents/admitted-run-context.js";
import {
  isDefaultAgentRuntimeId,
  normalizeOptionalAgentRuntimeId,
  OPENCLAW_AGENT_RUNTIME_ID,
} from "../../agents/agent-runtime-id.js";
import { isHeartbeatLifecycleRunKind } from "../../agents/bootstrap-mode.js";
import { collectTextContentBlocks } from "../../agents/content-blocks.js";
import { bindActiveOperatorTurnAuthority } from "../../agents/cron-creator-authority-context.js";
import {
  buildUsageAgentMetaFields,
  resolveFinalAssistantRawText,
  resolveFinalAssistantVisibleText,
  resolveReportedModelRef,
} from "../../agents/embedded-agent-runner/run/helpers.js";
import type { EmbeddedAgentRunResult } from "../../agents/embedded-agent-runner/types.js";
import {
  createUsageAccumulator,
  mergeUsageIntoAccumulator,
} from "../../agents/embedded-agent-runner/usage-accumulator.js";
import { recordModelFallbackStop } from "../../agents/failover-error.js";
import {
  finalizeHarnessContextEngineTurn,
  runHarnessContextEngineMaintenance,
} from "../../agents/harness/context-engine-lifecycle.js";
import { resolveDefaultModelForAgent } from "../../agents/model-selection-config.js";
import type { BoundAgentRunSessionTarget } from "../../agents/run-session-target.types.js";
import type { AgentMessage } from "../../agents/runtime/index.js";
import type { SessionPlacementTurnParams } from "../../agents/session-placement-admission.js";
import { convertToLlm } from "../../agents/sessions/messages.js";
import { withSessionManagerWrite } from "../../agents/sessions/session-manager-write-admission.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { resolveEffectiveAgentRuntime } from "../../agents/thinking-runtime.js";
import { capturePresenceToolAuthority } from "../../agents/tools/presence-tool-authority.js";
import { hasNonzeroUsage, normalizeUsage } from "../../agents/usage.js";
import { composeSessionSourceAssertion } from "../../config/sessions/session-source-authority.js";
import {
  runWithoutOwnedSessionTranscriptWrites,
  withSessionTranscriptWriteAssertion,
} from "../../config/sessions/transcript-write-context.js";
import { emitTrustedDiagnosticEvent, isDiagnosticsEnabled } from "../../infra/diagnostic-events.js";
import { redactSensitiveText } from "../../logging/redact.js";
import type { SpawnResult } from "../../process/exec.js";
import type { WorkerLaunchPlan } from "../../worker/launch-descriptor.js";
import {
  windowWorkerReplayMessages,
  fitWorkerReplayImages,
  type WorkerReplayMessageWindowUnavailable,
} from "../../worker/replay-message-window.js";
import {
  toWorkerTranscriptMessage,
  type WorkerProviderReplayUnavailable,
} from "../../worker/transcript-message.js";
import { parseWorkerRuntimeResult } from "../../worker/worker-process-protocol.js";
import {
  measureAgentRuntimeIdentityTokenBytes,
  mintAgentRuntimeIdentityToken,
  type AgentRuntimeIdentityTokenParams,
} from "../agent-runtime-identity-token.js";
import type { WorkerSessionTurnClaim } from "./placement-record.js";
import type { WorkerSessionPlacementStore } from "./placement-store.js";
import {
  bindWorkerTurnOwner,
  type WorkerTurnPromptCacheContext,
} from "./placement-turn-claim-events.js";
import type { WorkerReplyMediaPreparer } from "./worker-reply-media.types.js";
import { WorkerTurnExecutionError } from "./worker-turn-failure.js";
import type { prepareWorkerTurnPrompt } from "./worker-turn-prompt.js";
import {
  captureWorkerTurnTranscriptSource,
  resolveWorkerTurnTranscriptTarget,
} from "./worker-turn-transcript-target.js";
import {
  reconcileWorkspaceAfterTurn,
  workerWorkspaceFailure,
} from "./workspace-result-finalize.js";

type WorkerInitialMessagePlan =
  | { kind: "complete"; messages: WorkerTranscriptMessage[] }
  | {
      kind: "provider-replay-unavailable";
      details: WorkerProviderReplayUnavailable | WorkerReplayMessageWindowUnavailable;
    };

type PrepareWorkerAgentRuntimeIdentityParams = {
  agentId: string;
  sessionKey: string;
  turnClaim: WorkerSessionTurnClaim;
  runtimeInstanceId: string;
  turn: SessionPlacementTurnParams;
  placements: WorkerSessionPlacementStore;
  sessionTarget: BoundAgentRunSessionTarget;
  promptCacheContext: WorkerTurnPromptCacheContext;
  assertSourceCurrent: () => void;
};

/** Keep input admission ordered before placement and transcript source checks. */
export function captureWorkerTurnInputAuthority(params: {
  transcriptTarget: BoundAgentRunSessionTarget;
  recorder: SessionPlacementTurnParams["userTurnTranscriptRecorder"];
  signal?: AbortSignal;
  assertRunCurrent: () => void;
  isBlocked: () => boolean;
}) {
  const assertInputCurrent = composeSessionSourceAssertion(
    [params.assertRunCurrent],
    (assertRun) => {
      assertRun();
      params.signal?.throwIfAborted();
      if (params.recorder?.isBlocked() && !params.isBlocked()) {
        throw new Error("Cloud worker turn input is blocked");
      }
    },
  );
  const transcriptSource = captureWorkerTurnTranscriptSource(params.transcriptTarget);
  return {
    assertTurnInputCurrent: assertInputCurrent,
    assertSourceCurrent: composeSessionSourceAssertion([assertInputCurrent, transcriptSource]),
    assertContextCurrent: () => {
      assertInputCurrent();
      resolveWorkerTurnTranscriptTarget({
        ...params.transcriptTarget,
        sessionTarget: params.transcriptTarget,
      });
    },
  };
}

export async function prepareWorkerAgentRuntimeIdentity(
  params: PrepareWorkerAgentRuntimeIdentityParams,
) {
  const admittedRunContext = await resolvePreparedRunAdmission({
    runId: params.turn.runId,
    runtimeKind: "worker",
    runtimeInstanceId: params.runtimeInstanceId,
    admittedRunContext: params.turn.admittedRunContext,
    preparedRunAdmission: params.turn.preparedRunAdmission,
  });
  const assertAdmittedActive = resolveAdmittedRunActiveAssertion(
    admittedRunContext,
    params.turn.abortSignal,
  );
  if (!assertAdmittedActive) {
    throw new Error("Worker turn has no active admitted execution authority");
  }
  const assertActive = composeSessionSourceAssertion([
    params.assertSourceCurrent,
    assertAdmittedActive,
  ]);
  assertAdmittedActive();
  const operatorAuthority = readAdmittedRunOperatorAuthority(admittedRunContext);
  const assertPresenceSourceCurrent = capturePresenceToolAuthority({
    runId: params.turn.runId,
    ownerAuthority: bindActiveOperatorTurnAuthority(params.turn.runId),
    operatorAuthority,
    delegatedAuthority: getAdmittedRunDelegatedAuthority(admittedRunContext),
    assertCurrent: assertActive,
  });
  // Stop closes the operational run before its placement claim finishes draining.
  // Worker tools must retain both owners even when audit collection is disabled.
  const { capability, takeFinishingOutcome } = await bindWorkerTurnOwner(
    params.placements,
    params.turnClaim,
    admittedRunContext.executionIdentityToken,
    admittedRunContext.operationalRunInstance,
    params.sessionTarget,
    assertActive,
    params.turn.prepareAssistantTranscriptMessage,
    operatorAuthority,
    assertPresenceSourceCurrent,
    params.promptCacheContext,
  );
  capability.receiptAuthority();
  // Worker-local process keys isolate ephemeral state only. The signed caller
  // identity retains the host-owned session and route used by approvals.
  const runtimeIdentity = await capability.run((owner) => {
    const { turn } = params;
    return {
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      operationalRunInstance: admittedRunContext.operationalRunInstance,
      executionIdentityToken: admittedRunContext.executionIdentityToken,
      turnSourceChannel: turn.messageChannel ?? turn.messageProvider,
      turnSourceTo: turn.currentMessagingTarget ?? turn.currentChannelId,
      turnSourceAccountId: turn.agentAccountId,
      turnSourceThreadId: turn.currentThreadTs,
      gatewayUiCommandTarget: turn.gatewayUiCommandTarget,
      workerTurnClaim: owner.turnClaim,
      approvalAuthority: owner.delegatedAuthority,
    } satisfies AgentRuntimeIdentityTokenParams;
  });
  return {
    admittedRunContext,
    operationalRunInstance: admittedRunContext.operationalRunInstance,
    runtimeIdentity,
    assertActive: capability.receiptAuthority,
    takeFinishingOutcome,
  };
}

export function emitProviderReplayRejected(
  config: SessionPlacementTurnParams["config"],
  details: { reason: string; bytes?: number; limitBytes?: number; count?: number },
): void {
  if (isDiagnosticsEnabled(config)) {
    emitTrustedDiagnosticEvent({
      type: "payload.large",
      surface: "worker.provider-replay",
      action: "rejected",
      ...details,
    });
  }
}

export function windowInitialMessages(
  messages: AgentMessage[],
  promptMessages = 1,
): WorkerInitialMessagePlan {
  const windowed = windowWorkerReplayMessages(
    messages,
    WORKER_INFERENCE_MAX_CONTEXT_MESSAGES - promptMessages,
  );
  if (windowed.kind === "provider-replay-unavailable") {
    return windowed;
  }
  const projected: WorkerTranscriptMessage[] = [];
  const projectedHistory = windowed.messages.flatMap<AgentMessage>((message) =>
    message.role === "custom" &&
    (message.customType === "openclaw.runtime-context" ||
      message.customType === "openclaw.system-update")
      ? [message]
      : convertToLlm([message]),
  );
  for (const message of projectedHistory) {
    const result = toWorkerTranscriptMessage(message, "launch");
    if (!result) {
      continue;
    }
    if (result.kind === "provider-replay-unavailable") {
      return result;
    }
    projected.push(result.message);
  }
  return { kind: "complete", messages: projected };
}

type WorkerLaunchFit =
  | { kind: "launch"; plan: WorkerLaunchPlan }
  | {
      kind: "provider-replay-unavailable";
      reason: "provider-replay-launch-payload-limit";
      bytes: number;
      limitBytes: number;
    };

/** Fits replay context before minting the exact worker-bound identity bearer. */
export async function fitLaunchDescriptorWithRuntimeIdentity(params: {
  build: (identityToken: string, messages: WorkerTranscriptMessage[]) => WorkerLaunchPlan;
  messages: WorkerTranscriptMessage[];
  runtimeIdentity: AgentRuntimeIdentityTokenParams;
  measure: (plan: WorkerLaunchPlan) => number;
}): Promise<WorkerLaunchFit> {
  const tokenBytes = measureAgentRuntimeIdentityTokenBytes(params.runtimeIdentity);
  const plan = fitLaunchDescriptor(
    (messages) => params.build("x".repeat(tokenBytes), messages),
    params.messages,
    params.measure,
  );
  if (plan.kind !== "launch") {
    return plan;
  }
  const token = await mintAgentRuntimeIdentityToken(params.runtimeIdentity);
  if (Buffer.byteLength(token, "utf8") !== tokenBytes) {
    throw new Error("Agent runtime identity changed while preparing worker launch");
  }
  return {
    kind: "launch",
    plan: {
      ...plan.plan,
      assignment: { ...plan.plan.assignment, agentRuntimeIdentityToken: token },
    },
  };
}

function fitLaunchDescriptor(
  build: (initialMessages: WorkerTranscriptMessage[]) => WorkerLaunchPlan,
  messages: WorkerTranscriptMessage[],
  measure: (plan: WorkerLaunchPlan) => number,
): WorkerLaunchFit {
  let initialMessages =
    fitWorkerReplayImages(messages, (candidate) => measure(build(candidate))) ?? messages;
  while (true) {
    const plan = build(initialMessages);
    const bytes = measure(plan);
    if (bytes <= WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES) {
      return { kind: "launch", plan };
    }
    const replayIndex = initialMessages.findLastIndex(
      (message) => message.role === "assistant" && message.providerReplay !== undefined,
    );
    if (replayIndex === 0) {
      return {
        kind: "provider-replay-unavailable",
        reason: "provider-replay-launch-payload-limit",
        bytes,
        limitBytes: WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES,
      };
    }
    const nextTurn = initialMessages.findIndex(
      (message, index) => index > 0 && message.role === "user",
    );
    // A replay owner is a valid context start because its checkpoint replaces
    // the discarded prefix; never advance past it to reach a later user turn.
    const nextStart =
      replayIndex > 0 && (nextTurn < 0 || nextTurn > replayIndex) ? replayIndex : nextTurn;
    if (nextStart < 0) {
      throw new Error("Worker turn context exceeds the launch descriptor payload limit");
    }
    initialMessages = initialMessages.slice(nextStart);
  }
}

function parseWorkerTurnProcessResult(processResult: SpawnResult) {
  if (processResult.code !== 0 || processResult.signal !== null || processResult.killed) {
    // Boxes are destroyed on failure, so the redacted stderr tail is the only forensics.
    const detail = truncateUtf16Safe(
      redactSensitiveText(processResult.stderr, { mode: "tools" }).replace(/\s+/gu, " ").trim(),
      400,
    );
    throw new Error(
      detail
        ? `Cloud worker process failed before completing the turn: ${detail}`
        : "Cloud worker process failed before completing the turn",
    );
  }
  const result = parseWorkerRuntimeResult(safeParseJsonRecord(processResult.stdout.trim()));
  if (!result) {
    throw new Error("Worker process returned invalid output");
  }
  if (result.status === "not-started") {
    throw new Error(result.errorText);
  }
  if (result.status === "fenced") {
    throw new Error(`Cloud worker turn was fenced: ${result.reason}`);
  }
  return result;
}

/** Delivers the committed reply while its result owner continues workspace settlement. */
export async function finalizeWorkerTurnResult(
  params: Parameters<typeof reconcileWorkspaceAfterTurn>[0] & {
    turn: SessionPlacementTurnParams;
    processResult: SpawnResult;
    modelRef: ReturnType<typeof assertSupportedTurn>;
    baseLeafId: string | null;
    promptContext: Awaited<ReturnType<typeof prepareWorkerTurnPrompt>>;
    prepareReplyMedia: WorkerReplyMediaPreparer;
    takeFinishingOutcome: () => ReturnType<
      Awaited<ReturnType<typeof prepareWorkerAgentRuntimeIdentity>>["takeFinishingOutcome"]
    >;
    settleSteering: () => Promise<void>;
    signal: AbortSignal;
    startedAt: number;
    onReply: (result: EmbeddedAgentRunResult) => void;
  },
) {
  const { turn, placement, transcriptTarget, promptContext } = params;
  const runtimeResult = parseWorkerTurnProcessResult(params.processResult);
  const workerTurnFailed = runtimeResult.status === "failed";

  // A terminal result settles under its pending-result owner, even after execution ends.
  const completed = await SessionManager.openAsync(transcriptTarget);
  const resultTarget = { ...transcriptTarget, expectedWriterRunId: undefined };
  const assertResultCurrent = () => {
    if (!params.placements.validateWorkspaceResultClaim(params.turnClaim)) {
      throw new Error("Cloud worker result lost its placement owner during transcript hydration");
    }
    resolveWorkerTurnTranscriptTarget({ ...resultTarget, sessionTarget: resultTarget });
  };
  assertResultCurrent();
  const currentPlacement = params.placements.preparedWorkspaceResultPlacement(params.turnClaim);
  if (
    runtimeResult.transcriptLeafId !== completed.getLeafId() ||
    runtimeResult.transcriptNextSeq !== (currentPlacement?.lastTranscriptAckCursor ?? 0) + 1
  ) {
    throw new Error(
      `Cloud worker result does not match its committed transcript acknowledgement ` +
        `(leaf=${runtimeResult.transcriptLeafId ?? "none"}/${completed.getLeafId() ?? "none"}, ` +
        `nextSeq=${runtimeResult.transcriptNextSeq}/${(currentPlacement?.lastTranscriptAckCursor ?? 0) + 1})`,
    );
  }
  const terminal = runtimeResult.transcriptLeafId
    ? completed.getEntry(runtimeResult.transcriptLeafId)
    : undefined;
  if (!terminal || terminal.type !== "message" || terminal.message.role !== "assistant") {
    throw new Error("Cloud worker completed without a terminal assistant transcript message");
  }
  // Reply accounting needs the admitted writer even when this turn did not compact.
  if (transcriptTarget.expectedWriterRunId !== undefined) {
    turn.onCompactionAccounting?.({
      kind: "durable",
      count: 0,
      target: {
        agentId: transcriptTarget.agentId,
        sessionId: transcriptTarget.sessionId,
        sessionKey: transcriptTarget.sessionKey,
        storePath: transcriptTarget.storePath,
        lifecycleRevision: transcriptTarget.expectedLifecycleRevision,
        activeWriterRunId: transcriptTarget.expectedWriterRunId,
      },
    });
  }
  const text = collectTextContentBlocks(terminal.message.content).join("");
  const baseIndex = completed.getBranch().findIndex((entry) => entry.id === params.baseLeafId);
  const workerMessages = completed
    .getBranch()
    .slice(baseIndex + 1)
    .flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
  // Consume and mark before reconciliation releases the exact finishing-ACK owner.
  const finishing = workerTurnFailed ? params.takeFinishingOutcome() : undefined;
  const workerFailure = workerTurnFailed
    ? new WorkerTurnExecutionError(finishing?.error ?? "Cloud worker turn failed")
    : undefined;
  if (workerFailure && finishing?.replayInvalid) {
    recordModelFallbackStop(workerFailure);
  }
  const reply = workerFailure ? { text } : await params.prepareReplyMedia({ text });
  const aborted = params.signal.aborted;
  const finalizeContext = async () => {
    const finalizationManager = turn.onContextEngineTurnCandidate
      ? completed
      : await SessionManager.openAsync(resultTarget);
    assertResultCurrent();
    const userEntry = params.baseLeafId
      ? finalizationManager.getEntry(params.baseLeafId)
      : undefined;
    await finalizeHarnessContextEngineTurn({
      ...promptContext.contextEngineTurn,
      sessionManager: finalizationManager,
      sessionIdUsed: placement.sessionId,
      promptError: workerTurnFailed,
      aborted,
      yieldAborted: false,
      isHeartbeat: isHeartbeatLifecycleRunKind(turn.bootstrapContextRunKind),
      messagesSnapshot: [
        ...promptContext.history,
        ...(userEntry?.type === "message" && userEntry.message.role === "user"
          ? [userEntry.message]
          : []),
        ...workerMessages,
      ],
      prePromptMessageCount: promptContext.history.length,
      turnCandidate: turn.onContextEngineTurnCandidate
        ? {
            admission: turn.userTurnTranscriptRecorder?.getAdmissionReceipt(),
            terminalEntryId: terminal.id,
            record: (facts) => {
              assertResultCurrent();
              turn.onContextEngineTurnCandidate?.(facts);
            },
          }
        : undefined,
      runMaintenance: (maintenance) =>
        runHarnessContextEngineMaintenance({
          ...maintenance,
          withSessionManagerRewriteLock: (operation) =>
            withSessionTranscriptWriteAssertion(resultTarget, assertResultCurrent, () =>
              withSessionManagerWrite(finalizationManager, operation),
            ),
        }),
    });
    assertResultCurrent();
  };
  if (turn.onContextEngineTurnCandidate) {
    await finalizeContext();
  }
  // The exact result claim owns these writes after the caller closes its reply writer.
  const settleWorkspace = () =>
    runWithoutOwnedSessionTranscriptWrites(() =>
      reconcileWorkspaceAfterTurn({
        ...params,
        transcriptTarget: resultTarget,
        publishAcceptedWorkspace: async (claim) => {
          await params.publishAcceptedWorkspace?.(claim);
          assertResultCurrent();
          if (!turn.onContextEngineTurnCandidate) {
            await finalizeContext();
          }
        },
      }),
    );
  if (workerFailure) {
    await settleWorkspace().catch((error: unknown) => {
      throw workerWorkspaceFailure(workerFailure, error);
    });
    throw workerFailure;
  }
  await params.settleSteering();
  const durationMs = Date.now() - params.startedAt;
  const usageAccumulator = createUsageAccumulator();
  const assistants = workerMessages.filter(
    (message): message is Extract<AgentMessage, { role: "assistant" }> =>
      message.role === "assistant",
  );
  let lastRunPromptUsage: ReturnType<typeof normalizeUsage>;
  for (const assistant of assistants) {
    const usage = normalizeUsage(assistant.usage);
    mergeUsageIntoAccumulator(usageAccumulator, usage);
    if (hasNonzeroUsage(usage)) {
      lastRunPromptUsage = usage;
    }
  }
  const lastAssistant = assistants.at(-1);
  const usageMeta = buildUsageAgentMetaFields({
    usageAccumulator,
    latestUsage: lastAssistant?.usage,
    lastRunPromptUsage,
  });
  const reportedModelRef = resolveReportedModelRef({
    ...params.modelRef,
    assistant: lastAssistant,
  });
  const result: EmbeddedAgentRunResult = {
    ...(reply.text || reply.mediaUrl || reply.mediaUrls?.length ? { payloads: [reply] } : {}),
    meta: {
      durationMs,
      agentMeta: {
        sessionId: placement.sessionId,
        sessionFile: turn.sessionFile,
        provider: reportedModelRef.provider,
        model: reportedModelRef.model,
        ...usageMeta,
      },
      stopReason: terminal.message.stopReason,
      finalAssistantVisibleText: resolveFinalAssistantVisibleText(terminal.message),
      finalAssistantRawText: resolveFinalAssistantRawText(terminal.message),
    },
  };
  assertResultCurrent();
  params.onReply(result);
  await settleWorkspace();
  return result;
}

export function assertSupportedTurn(params: SessionPlacementTurnParams) {
  if (params.clientTools?.length) {
    throw new Error("Cloud worker turns do not support client-provided tools");
  }
  const explicitProvider = params.provider?.trim();
  const explicitModel = params.model?.trim();
  const defaults =
    explicitProvider && explicitModel
      ? undefined
      : resolveDefaultModelForAgent({ cfg: params.config ?? {}, agentId: params.agentId });
  const modelRef = {
    provider: explicitProvider ?? defaults?.provider ?? "",
    model: explicitModel ?? defaults?.model ?? "",
  };
  const explicitRuntime =
    normalizeOptionalAgentRuntimeId(params.agentHarnessId) ??
    normalizeOptionalAgentRuntimeId(params.agentHarnessRuntimeOverride);
  const runtime =
    explicitRuntime && !isDefaultAgentRuntimeId(explicitRuntime)
      ? explicitRuntime
      : resolveEffectiveAgentRuntime({
          cfg: params.config ?? {},
          provider: modelRef.provider,
          modelId: modelRef.model,
          agentId: params.agentId,
          sessionKey: params.sessionKey,
        });
  if (runtime !== OPENCLAW_AGENT_RUNTIME_ID) {
    throw new Error(`Cloud worker turns require the OpenClaw runtime, not ${runtime}`);
  }
  return modelRef;
}
