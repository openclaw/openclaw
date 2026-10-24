import { AsyncLocalStorage } from "node:async_hooks";
import type {
  WorkerTurnAdmissionParams,
  WorkerTurnAdmissionResult,
} from "../../../packages/gateway-protocol/src/schema/worker-turn-admission.js";
import { buildEmbeddedRunBlockedResult } from "../../agents/embedded-agent-runner/run/blocked-run-result.js";
import {
  buildAgentRunBlockedUserMessage,
  runBeforeAgentRunGate,
} from "../../agents/harness/before-agent-run.js";
import { buildAgentHookContext } from "../../agents/harness/hook-context.js";
import type { PreparedModelRuntimeSnapshot } from "../../agents/prepared-model-runtime.js";
import type { BoundAgentRunSessionTarget } from "../../agents/run-session-target.types.js";
import type { SessionPlacementTurnParams } from "../../agents/session-placement-admission.js";
import { convertToLlm } from "../../agents/sessions/messages.js";
import { SessionTranscriptMessageCommittedError } from "../../agents/sessions/session-manager-message-error.js";
import { withSessionManagerWrite } from "../../agents/sessions/session-manager-write-admission.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import {
  composeSessionSourceAssertion,
  type SessionSourceAssertion,
} from "../../config/sessions/session-source-authority.js";
import { withoutSessionTranscriptReadFence } from "../../config/sessions/session-transcript-read-fence.js";
import { withSessionTranscriptWriteAssertion } from "../../config/sessions/transcript-write-context.js";
import { buildAgentHookContextChannelFields } from "../../plugins/hook-agent-context.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import type { PluginHookBeforeAgentRunEvent } from "../../plugins/hook-types.js";
import { withPluginRuntimeGenerationScope } from "../../plugins/runtime/generation-scope.js";
import { readSessionTranscriptRunId } from "../../sessions/transcript-events.js";
import { buildPersistedUserTurnMessage } from "../../sessions/user-turn-transcript.js";
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
  cwd: string;
  transcriptTarget: BoundAgentRunSessionTarget;
  identity: { agentId: string; sessionId: string; sessionKey: string };
  modelRef: { provider: string; model: string };
  startedAt: number;
  assertCurrent: () => void;
  assertSourceCurrent: SessionSourceAssertion;
  onBlocked: () => void;
};

async function persistWorkerTurnRecordedInput(
  params: Pick<WorkerTurnInputParams, "turn" | "transcriptTarget" | "assertCurrent"> & {
    cwd: string;
  },
) {
  const { turn, transcriptTarget, assertCurrent, cwd } = params;
  const recorder = turn.userTurnTranscriptRecorder;
  if (recorder && turn.suppressNextUserMessagePersistence !== true && !recorder.hasPersisted()) {
    const persisted = await recorder.persistApproved({ storageTarget: transcriptTarget, cwd });
    if (persisted) {
      turn.onUserMessagePersisted?.(persisted.message);
    }
    assertCurrent();
  }
}

export async function persistWorkerTurnInput(
  params: Parameters<typeof persistWorkerTurnUserMessage>[0] & {
    turn: SessionPlacementTurnParams;
    cwd: string;
    assertCurrent: () => void;
    workerAdmission: boolean;
    userMessageAlreadyPersisted: boolean;
    baseLeafId: string | null;
  },
) {
  await persistWorkerTurnRecordedInput(params);
  const recorder = params.turn.userTurnTranscriptRecorder;
  if (recorder && params.workerAdmission && !params.userMessageAlreadyPersisted) {
    return recorder.getAdmissionReceipt()?.entryId ?? params.baseLeafId;
  }
  return !recorder && !params.userMessageAlreadyPersisted
    ? await persistWorkerTurnUserMessage(params)
    : params.baseLeafId;
}

export function createWorkerTurnInputAdmission(
  params: WorkerTurnInputParams & {
    runtime: PreparedModelRuntimeSnapshot;
    preparedInput: Pick<Awaited<ReturnType<typeof prepareWorkerTurnMedia>>, "prompt" | "history">;
    persist: () => Promise<string | null>;
    onBlockedResult: (result: NonNullable<Awaited<ReturnType<typeof gateWorkerTurnInput>>>) => void;
  },
) {
  // The RPC retains the launching turn's transcript and plugin scopes.
  const runAdmission = AsyncLocalStorage.snapshot();
  const { prompt, history } = params.preparedInput;
  const preparedInput = {
    prompt:
      typeof prompt === "string"
        ? prompt
        : prompt
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n"),
    messages: convertToLlm(history),
  };
  let started = false;
  return (
    request: WorkerTurnAdmissionParams,
    assertRpcCurrent: () => void,
    recordApproval: () => void,
  ): Promise<WorkerTurnAdmissionResult> =>
    runAdmission(async (): Promise<WorkerTurnAdmissionResult> => {
      if (started) {
        throw new Error("Worker turn input admission was already requested");
      }
      started = true;
      const assertCurrent = composeSessionSourceAssertion([params.assertCurrent, assertRpcCurrent]);
      assertCurrent();
      return await withSessionTranscriptWriteAssertion(
        params.transcriptTarget,
        composeSessionSourceAssertion([params.assertSourceCurrent, assertCurrent]),
        async () => {
          const blocked = await withPluginRuntimeGenerationScope(params.runtime, () =>
            // Host-local prompt bytes cannot be verified here. All other event fields
            // come from the Gateway; plugins must not trust systemPrompt as authority.
            gateWorkerTurnInput(
              { ...params, assertCurrent },
              {
                ...preparedInput,
                systemPrompt: request.systemPrompt,
              },
            ),
          );
          assertCurrent();
          if (blocked) {
            params.onBlockedResult(blocked);
            return { outcome: "block" };
          }
          recordApproval();
          const baseLeafId = await params.persist();
          assertCurrent();
          params.turn.userTurnTranscriptRecorder?.markSentToProvider?.();
          return { outcome: "allow", baseLeafId };
        },
      );
    });
}

export async function gateWorkerTurnInput(
  {
    turn,
    transcriptTarget,
    identity,
    modelRef,
    startedAt,
    assertCurrent,
    assertSourceCurrent,
    onBlocked,
  }: WorkerTurnInputParams,
  event?: Pick<PluginHookBeforeAgentRunEvent, "prompt" | "systemPrompt" | "messages">,
) {
  const recorder = turn.userTurnTranscriptRecorder;
  const runner = getGlobalHookRunner();
  if (!runner?.hasHooks("before_agent_run")) {
    return undefined;
  }
  const input: Pick<PluginHookBeforeAgentRunEvent, "prompt" | "systemPrompt" | "messages"> =
    event ?? {
      prompt: turn.prompt,
      messages: convertToLlm(
        (
          await SessionManager.openModelContextAsync(transcriptTarget, {
            admission: recorder?.getAdmissionReceipt(),
            signal: turn.abortSignal,
          })
        ).buildSessionContext().messages,
      ),
    };
  assertCurrent();
  const channel = buildAgentHookContextChannelFields(turn);
  const block = await runBeforeAgentRunGate(
    runner,
    {
      prompt: input.prompt,
      messages: input.messages,
      ...(input.systemPrompt === undefined ? {} : { systemPrompt: input.systemPrompt }),
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
  await withSessionTranscriptWriteAssertion(transcriptTarget, assertSourceCurrent, async () => {
    if (recorder) {
      const persisted = await recorder.persistBlocked(message, {
        storageTarget: transcriptTarget,
      });
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
  params: WorkerTurnInputParams,
  pendingAdmission = false,
) {
  if (!pendingAdmission) {
    await persistWorkerTurnRecordedInput(params);
  }
  const { turn, transcriptTarget, modelRef, assertCurrent } = params;
  const recorder = turn.userTurnTranscriptRecorder;
  const receipt = recorder?.getAdmissionReceipt();
  const admission = receipt ? { ...receipt } : undefined;
  if (recorder && !admission && !pendingAdmission) {
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
  let manager = userMessageAlreadyPersisted
    ? await SessionManager.openModelContextAsync(transcriptTarget, {
        admission,
        signal: turn.abortSignal,
      })
    : await SessionManager.openAsync(transcriptTarget, undefined, undefined, turn.abortSignal);
  assertCurrent();
  let baseLeafId = admission?.entryId ?? manager.getLeafId();
  // Reuse the fenced read's source watermark. Later writes still face the commit fence.
  if (admission && manager.getTranscriptSnapshotVersion()?.rawSeq !== admission.rawSeq) {
    const current = await withoutSessionTranscriptReadFence(() =>
      SessionManager.openModelContextAsync(transcriptTarget, { signal: turn.abortSignal }),
    );
    assertCurrent();
    const branch = current.getBranch();
    const admittedIndex = branch.findIndex((entry) => entry.id === admission.entryId);
    const suffix = branch.slice(admittedIndex + 1);
    let hasRunOutput = false;
    const isRunContinuation = suffix.every((entry) => {
      if (entry.type !== "message") {
        return false;
      }
      const { message } = entry;
      const runId = readSessionTranscriptRunId(message);
      if (runId !== undefined) {
        const ownedOutput =
          runId === turn.runId && (message.role === "assistant" || message.role === "toolResult");
        hasRunOutput ||= ownedOutput;
        return ownedOutput;
      }
      return (
        message.role === "custom" &&
        (message.customType === "openclaw.runtime-context" ||
          message.customType === "openclaw.system-update")
      );
    });
    // Untagged runtime context may accompany this run's output, but cannot establish ownership.
    if (admittedIndex >= 0 && hasRunOutput && isRunContinuation) {
      manager = current;
      baseLeafId = current.getLeafId();
    }
  }
  const contextMessages = manager.buildSessionContext().messages;
  const leaf = manager.getLeafEntry();
  const history =
    !admission &&
    userMessageAlreadyPersisted &&
    leaf?.type === "message" &&
    leaf.message.role === "user"
      ? contextMessages.slice(0, -1)
      : contextMessages;
  return {
    manager,
    history,
    userMessageAlreadyPersisted,
    baseLeafId,
  };
}
