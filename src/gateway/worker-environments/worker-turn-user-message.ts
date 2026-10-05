import { buildEmbeddedRunBlockedResult } from "../../agents/embedded-agent-runner/run/blocked-run-result.js";
import {
  buildAgentRunBlockedUserMessage,
  runBeforeAgentRunGate,
} from "../../agents/harness/before-agent-run.js";
import { buildAgentHookContext } from "../../agents/harness/hook-context.js";
import type { BoundAgentRunSessionTarget } from "../../agents/run-session-target.types.js";
import type { SessionPlacementTurnParams } from "../../agents/session-placement-admission.js";
import { convertToLlm } from "../../agents/sessions/messages.js";
import { SessionTranscriptMessageCommittedError } from "../../agents/sessions/session-manager-message-error.js";
import { withSessionManagerWrite } from "../../agents/sessions/session-manager-write-admission.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { withSessionTranscriptWriteAssertion } from "../../config/sessions/transcript-write-context.js";
import { buildAgentHookContextChannelFields } from "../../plugins/hook-agent-context.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { buildPersistedUserTurnMessage } from "../../sessions/user-turn-transcript.js";
import { applyWorkerModelFallbackRelaunch } from "./worker-relaunch-base.js";
import type { prepareWorkerTurnMedia } from "./worker-turn-media.js";
import { resolveWorkerTurnTranscriptTarget } from "./worker-turn-transcript-target.js";

export async function persistWorkerTurnUserMessage(params: {
  turn: Pick<
    SessionPlacementTurnParams,
    "prompt" | "transcriptPrompt" | "media" | "onUserMessagePersisted"
  >;
  manager: SessionManager;
  transcriptTarget: BoundAgentRunSessionTarget;
  media: Pick<Awaited<ReturnType<typeof prepareWorkerTurnMedia>>, "images" | "imageFactIndexes">;
  assertRunCurrent?: () => void;
  isAuthorized: () => boolean;
}): Promise<string | null> {
  const { turn, manager, transcriptTarget, media } = params;
  const canonical = buildPersistedUserTurnMessage({
    text: turn.transcriptPrompt ?? turn.prompt,
    media: turn.media,
    mediaImageLayout: {
      slots: media.imageFactIndexes.map((factIndex) => ({
        kind: "inline" as const,
        ...(factIndex === null ? {} : { factIndex }),
      })),
    },
  });
  const message = {
    ...canonical,
    content: [
      { type: "text" as const, text: turn.transcriptPrompt ?? turn.prompt },
      ...media.images,
    ],
    __openclaw: {
      ...canonical["__openclaw"],
      mediaImageBlockFactIndexes: media.imageFactIndexes,
    },
  };
  const assertCurrent = () => {
    params.assertRunCurrent?.();
    if (!params.isAuthorized()) {
      throw new Error("Worker turn authority changed before transcript write");
    }
    resolveWorkerTurnTranscriptTarget({ ...transcriptTarget, sessionTarget: transcriptTarget });
  };
  const entryId = await withSessionTranscriptWriteAssertion(transcriptTarget, assertCurrent, () =>
    withSessionManagerWrite(manager, () => manager.appendMessageAsync(message)),
  );
  try {
    assertCurrent();
    turn.onUserMessagePersisted?.(message);
  } catch (error) {
    if (entryId) {
      throw new SessionTranscriptMessageCommittedError(entryId, error, transcriptTarget);
    }
    throw error;
  }
  return entryId ?? null;
}

type WorkerTurnInputParams = {
  turn: SessionPlacementTurnParams;
  transcriptTarget: BoundAgentRunSessionTarget;
  identity: { agentId: string; sessionId: string; sessionKey: string };
  modelRef: { provider: string; model: string };
  startedAt: number;
  assertCurrent: () => void;
  onBlocked: () => void;
};

export async function gateWorkerTurnInput({
  turn,
  transcriptTarget,
  identity,
  modelRef,
  startedAt,
  assertCurrent,
  onBlocked,
}: WorkerTurnInputParams) {
  const recorder = turn.userTurnTranscriptRecorder;
  const runner = getGlobalHookRunner();
  if (!runner?.hasHooks("before_agent_run")) {
    return undefined;
  }
  const history = await SessionManager.openModelContextAsync(transcriptTarget, {
    admission: recorder?.getAdmissionReceipt(),
    signal: turn.abortSignal,
  });
  assertCurrent();
  const channel = buildAgentHookContextChannelFields(turn);
  const block = await runBeforeAgentRunGate(
    runner,
    {
      prompt: turn.prompt,
      messages: convertToLlm(history.buildSessionContext().messages),
      channelId: channel.channelId,
      accountId: turn.agentAccountId,
      senderId: turn.senderId ?? undefined,
      senderIsOwner: turn.senderIsOwner,
    },
    buildAgentHookContext({
      ...turn,
      ...identity,
      ...channel,
      senderId: turn.senderId ?? undefined,
      modelProviderId: modelRef.provider,
      modelId: modelRef.model,
    }),
  );
  assertCurrent();
  if (!block) {
    return undefined;
  }
  onBlocked();
  const message = buildAgentRunBlockedUserMessage(turn.runId, block);
  await withSessionTranscriptWriteAssertion(transcriptTarget, assertCurrent, async () => {
    if (recorder) {
      const persisted = await recorder.persistBlocked(message);
      assertCurrent();
      if (persisted) {
        turn.onUserMessagePersisted?.(persisted.message);
      }
    } else {
      const manager = await SessionManager.openAsync(
        transcriptTarget,
        undefined,
        undefined,
        turn.abortSignal,
      );
      assertCurrent();
      await withSessionManagerWrite(manager, () => manager.appendMessageAsync(message));
      assertCurrent();
      turn.onUserMessagePersisted?.(message);
    }
  });
  assertCurrent();
  return buildEmbeddedRunBlockedResult({
    text: block.message,
    errorKind: "hook_block",
    errorMessage: block.message,
    durationMs: Date.now() - startedAt,
    agentMeta: { sessionId: identity.sessionId, ...modelRef },
    replayInvalid: false,
  });
}

export async function readWorkerTurnInputContext(
  params: WorkerTurnInputParams & { admissionPersistedBeforeLaunch?: boolean },
) {
  const { turn, transcriptTarget, modelRef, assertCurrent } = params;
  const recorder = turn.userTurnTranscriptRecorder;
  const receipt = recorder?.getAdmissionReceipt();
  const admission = receipt ? { ...receipt } : undefined;
  if (recorder && !admission) {
    throw new Error("Cloud worker turn has no readable canonical user admission");
  }
  const userMessageAlreadyPersisted =
    admission !== undefined || turn.suppressNextUserMessagePersistence === true;
  // Validate context after reentrant phase callbacks have finished.
  turn.onExecutionPhase?.({
    phase: "model_resolution",
    backend: "cloud-worker",
    provider: modelRef.provider,
    model: modelRef.model,
  });
  const manager = userMessageAlreadyPersisted
    ? await SessionManager.openModelContextAsync(transcriptTarget, {
        admission,
        signal: turn.abortSignal,
      })
    : await SessionManager.openAsync(transcriptTarget, undefined, undefined, turn.abortSignal);
  assertCurrent();
  const contextMessages = manager.buildSessionContext().messages;
  const leaf = manager.getLeafEntry();
  const history =
    !admission &&
    userMessageAlreadyPersisted &&
    leaf?.type === "message" &&
    leaf.message.role === "user"
      ? contextMessages.slice(0, -1)
      : contextMessages;
  let baseLeafId = admission?.entryId ?? manager.getLeafId();
  // Only an admission that predates this launch marks a fallback relaunch: the
  // failed candidate may have committed past that admission, so the launch base
  // must follow the durable leaf instead of the fenced admission prefix.
  if (params.admissionPersistedBeforeLaunch === true && admission) {
    const relaunch = await applyWorkerModelFallbackRelaunch({
      transcriptTarget,
      admissionEntryId: admission.entryId,
      runId: turn.runId,
      ...(turn.abortSignal ? { signal: turn.abortSignal } : {}),
    });
    if (relaunch.kind === "stopped") {
      throw relaunch.refusal;
    }
    if (relaunch.baseLeafId) {
      baseLeafId = relaunch.baseLeafId;
    }
  }
  return {
    manager,
    history,
    userMessageAlreadyPersisted,
    baseLeafId,
  };
}
