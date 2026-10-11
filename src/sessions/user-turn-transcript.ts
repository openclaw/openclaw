import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  bindSessionPendingInputSources,
  stageSessionPendingInput,
  withSessionPendingInputPersistence,
  resolveSessionTranscriptRuntimeTarget,
  type TranscriptEntryAnchor,
  type SessionTranscriptTurnPersistOptions,
} from "../config/sessions/session-accessor.js";
import { readWithdrawnSessionPendingInputId } from "../config/sessions/session-accessor.pending-inputs.js";
import {
  registerUserTurnInputActor,
  withSessionInputActor,
  type SessionInputActorBinding,
} from "../config/sessions/session-input-actor.js";
import { createDynamicSessionSourceAssertion } from "../config/sessions/session-source-authority.js";
import { runInDetachedAsyncContext } from "../shared/detached-async-context.js";
import {
  getUserTurnTranscriptAdmissionOwner,
  registerUserTurnTranscriptAdmissionOwner,
  inheritUserTurnPromptReactionSource,
} from "./user-turn-transcript-admission.js";
import { createUserTurnProcessingCompletion } from "./user-turn-transcript-processing.js";
import {
  capturePersistedModelPromptProjection,
  confirmPersistedSteerTargetRunId,
} from "./user-turn-transcript-updates.js";
import {
  buildLateResolvedMediaMessage,
  resolvePersistedUserTurnMessage,
} from "./user-turn-transcript.message.js";
import {
  buildRunUserTurnIdempotencyKey,
  normalizePersistedSteerTargetRunId,
  preparePersistedUserTurnMessageForTranscriptWrite,
  restorePreparedUserTurnOperationalMetaForRuntime,
  rewritePersistedSteerTargetRunId,
} from "./user-turn-transcript.metadata.js";
import {
  admittedUserTurnResult,
  persistUserTurnTranscript,
  resolveCommittedUserTurnTranscript,
  type CommittedUserTurnTranscript,
} from "./user-turn-transcript.persistence.js";
import type {
  CreateUserTurnTranscriptRecorderParams,
  PersistedUserTurnMessage,
  UserTurnTranscriptAdmissionReceipt,
  UserTurnOriginalInputCommit,
  UserTurnTranscriptPersistResult,
  UserTurnTranscriptRecorder,
  UserTurnTranscriptTarget,
  UserTurnTranscriptTargetResolver,
  UserTurnTranscriptUpdateMode,
} from "./user-turn-transcript.types.js";

const originalInputCommitNotifiers = new WeakMap<
  UserTurnTranscriptRecorder,
  (anchor: TranscriptEntryAnchor) => void
>();

export type {
  PersistedUserTurnMessage,
  UserTurnInput,
  UserTurnTranscriptRecorder,
} from "./user-turn-transcript.types.js";

export {
  buildLateMediaAttachedProjection,
  buildPersistedUserTurnMediaInputsFromFields,
  buildPersistedUserTurnMessage,
  mergePreparedUserTurnMessageForRuntime,
  resolvePersistedUserTurnText,
} from "./user-turn-transcript.message.js";

export {
  buildRunUserTurnIdempotencyKey,
  preparePersistedUserTurnMessageForTranscriptWrite,
  restorePreparedUserTurnOperationalMetaForRuntime,
};

async function resolveUserTurnTranscriptTarget(
  target: UserTurnTranscriptTargetResolver,
): Promise<UserTurnTranscriptTarget | undefined> {
  return typeof target === "function" ? await target() : target;
}

export function createUserTurnTranscriptRecorder(
  params: CreateUserTurnTranscriptRecorderParams,
): UserTurnTranscriptRecorder {
  const logicalTurnId = randomUUID();
  let message = resolvePersistedUserTurnMessage(params);
  let blocked = false;
  let runtimePersisted = false;
  let persistedResult: UserTurnTranscriptPersistResult | undefined;
  let committedInput: CommittedUserTurnTranscript | undefined;
  let resolvedPersistenceTarget: UserTurnTranscriptTarget | undefined;
  let admissionReceipt: UserTurnTranscriptAdmissionReceipt | undefined;
  let admittedMessage: PersistedUserTurnMessage | undefined;
  let runtimePersistencePromise: Promise<void> | undefined;
  let selfPersistencePromise: Promise<UserTurnTranscriptPersistResult | undefined> | undefined;
  let resolvedMessagePromise: Promise<PersistedUserTurnMessage | undefined> | undefined;
  let persistedMessageNotified = false;
  let originalInputCommitted = false;
  let resolvedSourceMessage: PersistedUserTurnMessage | undefined;
  let runtimePersistedMessage: PersistedUserTurnMessage | undefined;
  let sentToProvider = false;
  let admissionHandler:
    | ((admission: UserTurnTranscriptAdmissionReceipt) => void | Promise<void>)
    | undefined;
  let admissionWrite: Promise<void> | undefined;
  let replacementText: string | undefined;
  let confirmedSteerTargetRunId: string | undefined;
  let pendingInput: Awaited<ReturnType<typeof stageSessionPendingInput>>;
  const processing = createUserTurnProcessingCompletion(
    () => pendingInput,
    params.pendingInputSources,
  );
  let staging: Promise<boolean> | undefined;

  const applyReplacementText = (
    candidate: PersistedUserTurnMessage | undefined,
  ): PersistedUserTurnMessage | undefined => {
    if (!candidate || replacementText === undefined) {
      return candidate;
    }
    const metadata = { ...candidate["__openclaw"] };
    if (candidate.content !== replacementText) {
      delete metadata.humanMentions;
      delete metadata.workContext;
    }
    const next = { ...candidate, content: replacementText };
    delete next["__openclaw"];
    return Object.keys(metadata).length > 0 ? { ...next, __openclaw: metadata } : next;
  };

  const applyMessageOverrides = (candidate: PersistedUserTurnMessage | undefined) => {
    const next = rewritePersistedSteerTargetRunId(
      applyReplacementText(candidate),
      confirmedSteerTargetRunId,
    );
    // Native mirrors must reuse this admission even when no transport supplied a key.
    return next && !next.idempotencyKey
      ? { ...next, idempotencyKey: buildRunUserTurnIdempotencyKey(logicalTurnId) }
      : next;
  };

  const handlePersistenceError = (error: unknown) => {
    if (params.onPersistenceError) {
      try {
        params.onPersistenceError(error);
      } catch {
        // Diagnostics cannot change an already committed transcript outcome.
      }
      return;
    }
    void import("../globals.js")
      .then(({ logVerbose }) => {
        logVerbose(
          `failed to persist ${params.errorContext ?? "user turn transcript"}: ${String(error)}`,
        );
      })
      .catch(() => undefined);
  };

  const resolveMessageForPersistence = async (): Promise<PersistedUserTurnMessage | undefined> => {
    if (!params.message && params.resolveInput && !resolvedMessagePromise) {
      resolvedMessagePromise = (async () => {
        try {
          const resolvedInput = await params.resolveInput?.();
          const resolvedMessage =
            resolvePersistedUserTurnMessage({
              message: params.message,
              input: resolvedInput ?? params.input,
            }) ?? message;
          return applyMessageOverrides(resolvedMessage);
        } catch (error) {
          handlePersistenceError(error);
          return applyMessageOverrides(message);
        }
      })();
    }
    const resolved = await (params.message || !params.resolveInput
      ? applyMessageOverrides(message)
      : resolvedMessagePromise);
    resolvedSourceMessage =
      params.pendingInputSources && resolved ? structuredClone(resolved) : resolved;
    if (!pendingInput && resolved && params.pendingInputSources) {
      const sources = params.pendingInputSources.flatMap(
        (source) => getUserTurnTranscriptAdmissionOwner(source)?.pendingInput() ?? [],
      );
      if (sources.length > 0 && sources.length !== params.pendingInputSources.length) {
        throw new Error("Collected input cannot mix staged and unstaged source approval");
      }
      pendingInput = bindSessionPendingInputSources(sources, resolved);
      if (pendingInput) {
        message = pendingInput.message;
        resolvedMessagePromise = Promise.resolve(message);
      }
    }
    return pendingInput?.message ?? resolved;
  };

  const notifyMessagePersisted = (persistedMessage?: PersistedUserTurnMessage) => {
    const notificationMessage = persistedMessage ?? persistedResult?.message ?? message;
    if (!notificationMessage || persistedMessageNotified || !params.onMessagePersisted) {
      return;
    }
    persistedMessageNotified = true;
    try {
      void Promise.resolve(params.onMessagePersisted(notificationMessage)).catch(
        handlePersistenceError,
      );
    } catch (error) {
      handlePersistenceError(error);
    }
  };

  const notifyOriginalInputCommitted = (commit: UserTurnOriginalInputCommit) => {
    const sourceMessage = commit.message;
    const metadata = sourceMessage["__openclaw"];
    if (
      originalInputCommitted ||
      blocked ||
      sourceMessage.display === false ||
      sourceMessage.excludeFromContext === true ||
      (sourceMessage.provenance && sourceMessage.provenance.kind !== "external_user") ||
      metadata?.lateMedia === true ||
      metadata?.beforeAgentRunBlocked !== undefined
    ) {
      return;
    }
    originalInputCommitted = true;
    // Collection commits one framed message, but each source owns its sender and
    // selections. A rewritten aggregate no longer attests those original bytes.
    if (
      params.pendingInputSources &&
      metadata?.humanMentions?.length &&
      isDeepStrictEqual(
        sourceMessage.content,
        (pendingInput?.message ?? resolvedSourceMessage ?? message)?.content,
      )
    ) {
      for (const source of params.pendingInputSources) {
        originalInputCommitNotifiers.get(source)?.(commit.anchor);
      }
    }
    try {
      void Promise.resolve(params.onOriginalInputCommitted?.(commit)).catch(handlePersistenceError);
    } catch (error) {
      handlePersistenceError(error);
    }
  };

  const recordAdmission = (
    receipt: TranscriptEntryAnchor | UserTurnTranscriptAdmissionReceipt,
    persistedMessage: PersistedUserTurnMessage,
    detached = false,
  ): Promise<void> => {
    if (admissionReceipt) {
      return admissionWrite ?? Promise.resolve();
    }
    const admission: UserTurnTranscriptAdmissionReceipt =
      "logicalTurnId" in receipt ? receipt : { ...receipt, logicalTurnId, role: "user" };
    admissionReceipt = admission;
    admittedMessage = persistedMessage;
    const run = async () => {
      await admissionHandler?.(admission);
    };
    // Runtime writes must queue behind the transcript writer instead of reentering it.
    admissionWrite = detached ? runInDetachedAsyncContext(run) : run();
    // The turn owner awaits this write; an early rejection must not be unobserved.
    admissionWrite.catch(() => undefined);
    return admissionWrite;
  };

  const refreshAdmission = (
    admission: UserTurnTranscriptAdmissionReceipt,
    persistedMessage: PersistedUserTurnMessage,
  ) => {
    admissionReceipt = admission;
    admittedMessage = persistedMessage;
    runtimePersistedMessage = persistedMessage;
    if (persistedResult) {
      persistedResult = { ...persistedResult, admission, message: persistedMessage };
    }
  };

  const waitForRuntimePersistence = async () => {
    if (runtimePersistencePromise) {
      try {
        await runtimePersistencePromise;
      } catch (error) {
        handlePersistenceError(error);
      }
    }
    // A failed durable admission reaches the turn owner before provider dispatch.
    await admissionWrite;
  };

  let inputActorBinding: SessionInputActorBinding | undefined;
  const persistPreparedWithoutActor = async (
    options: NonNullable<Parameters<UserTurnTranscriptRecorder["persistApproved"]>[0]> & {
      waitForRuntime: boolean;
      skipWhenBlocked: boolean;
      message?: PersistedUserTurnMessage;
    },
  ): Promise<UserTurnTranscriptPersistResult | undefined> => {
    if (options.skipWhenBlocked && blocked) {
      return undefined;
    }
    if (!options.message && !message && !params.resolveInput) {
      return undefined;
    }
    if (options.waitForRuntime) {
      await waitForRuntimePersistence();
    }
    if (selfPersistencePromise) {
      const existingPromise = selfPersistencePromise;
      const existingResult = await existingPromise;
      if (existingResult || !options.retryIfUnpersisted) {
        return persistedResult ?? existingResult;
      }
      // A guarded store write can lose a session-generation race without appending.
      // Explicit retry callers may re-resolve the target, but concurrent ownership stays shared.
      if (selfPersistencePromise !== existingPromise) {
        return await selfPersistencePromise;
      }
      selfPersistencePromise = undefined;
    }
    if (!options.message && persistedResult) {
      return persistedResult;
    }
    const persistencePromise = (async () => {
      if (!options.message && committedInput && resolvedPersistenceTarget) {
        const result = await resolveCommittedUserTurnTranscript(committedInput, {
          ...resolvedPersistenceTarget,
          logicalTurnId,
        });
        if (result) {
          persistedResult = result;
          await recordAdmission(result.admission, result.message);
          if (result.appended) {
            notifyOriginalInputCommitted({ message: result.message, anchor: result.admission });
          }
        }
        return result;
      }
      const resolvedMessage = options.message ?? (await resolveMessageForPersistence());
      if (!resolvedMessage) {
        return undefined;
      }
      const target = await resolveUserTurnTranscriptTarget(options.target ?? params.target);
      if (!target) {
        return undefined;
      }
      const resolvedTarget = options.cwd ? { ...target, cwd: options.cwd } : target;
      resolvedPersistenceTarget = resolvedTarget;
      const updateMode = options.updateMode ?? params.updateMode ?? "inline";
      const persistMessage = async (
        candidate: PersistedUserTurnMessage,
        candidateUpdateMode: UserTurnTranscriptUpdateMode,
      ) => {
        const persist = () =>
          persistUserTurnTranscript({
            ...resolvedTarget,
            logicalTurnId,
            message: candidate,
            sessionTurnMutation: params.sessionTurnMutation,
            expectedSessionId: options.expectedSessionId || resolvedTarget.expectedSessionId,
            sessionLifecyclePatch: options.sessionLifecyclePatch ?? params.sessionLifecyclePatch,
            expectedSessionState: options.expectedSessionState ?? params.expectedSessionState,
            updateMode: candidateUpdateMode,
            beforeMessageWrite: params.beforeMessageWrite ?? resolvedTarget.beforeMessageWrite,
            beforeFreshMessageCommit:
              candidate.idempotencyKey === message?.idempotencyKey
                ? recorder.assertOriginalInputCommit
                : undefined,
            onOriginalInputCommitted: notifyOriginalInputCommitted,
            onCommitted: (committed, acceptCompletion) => {
              committedInput = committed;
              admittedMessage = committed.message;
              const result = admittedUserTurnResult(
                committed,
                logicalTurnId,
                resolvedTarget.sessionKey,
              );
              if (result) {
                persistedResult = result;
                acceptCompletion(() => recordAdmission(result.admission, result.message));
              }
              notifyMessagePersisted(committed.message);
            },
          });
        // Collection can resolve its media lazily during admission. Bind custody
        // here too so the canonical append always consumes the exact sources.
        return await (pendingInput
          ? withSessionPendingInputPersistence(pendingInput, persist)
          : persist());
      };
      const lateMediaMessage =
        sentToProvider || runtimePersisted || persistedResult
          ? buildLateResolvedMediaMessage({
              admittedMessage:
                admittedMessage ?? runtimePersistedMessage ?? persistedResult?.message ?? message,
              resolvedMessage,
            })
          : undefined;
      if (lateMediaMessage) {
        // Durable admission fixes the original bytes, including while projection
        // capture is preparing dispatch. New media belongs to a separate turn (#99495).
        if (!runtimePersisted && !persistedResult && message) {
          const admittedResult = await persistMessage(message, updateMode);
          if (admittedResult) {
            persistedResult = admittedResult;
            await recordAdmission(admittedResult.admission, admittedResult.message);
            notifyMessagePersisted(admittedResult.message);
          }
        }
        const appendedMedia = await persistMessage(lateMediaMessage, "none");
        if (appendedMedia) {
          persistedResult = appendedMedia;
        }
        return appendedMedia;
      }
      if (runtimePersisted) {
        return undefined;
      }
      if (persistedResult) {
        return persistedResult;
      }
      const result = await persistMessage(resolvedMessage, updateMode);
      if (result) {
        persistedResult = result;
        await recordAdmission(result.admission, result.message);
        notifyMessagePersisted(result.message);
      }
      return result;
    })();
    selfPersistencePromise = persistencePromise;
    try {
      const result = await persistencePromise;
      if (!result && options.retryIfUnpersisted && selfPersistencePromise === persistencePromise) {
        selfPersistencePromise = undefined;
      }
      return result;
    } catch (error) {
      // Approved custody retries only its idempotent write under the same live
      // owner. A cached rejection must not poison a later definitive fallback.
      if ((committedInput || pendingInput) && selfPersistencePromise === persistencePromise) {
        selfPersistencePromise = undefined;
      }
      handlePersistenceError(error);
      throw error;
    }
  };
  const persistPrepared = (options: Parameters<typeof persistPreparedWithoutActor>[0]) =>
    withSessionInputActor(inputActorBinding, () => persistPreparedWithoutActor(options));
  const recorder: UserTurnTranscriptRecorder = {
    get message() {
      return message;
    },
    resolveMessage: resolveMessageForPersistence,
    assertOriginalInputCommit: params.assertOriginalInputCommit
      ? createDynamicSessionSourceAssertion(
          () =>
            !blocked && !persistedResult && !runtimePersisted && !pendingInput
              ? params.assertOriginalInputCommit
              : undefined,
          () => {
            throw new Error("Original input custody changed before transcript commit");
          },
        )
      : undefined,
    stageApproved: (options) =>
      withSessionInputActor(inputActorBinding, () => {
        staging ??= (async () => {
          const candidate = await resolveMessageForPersistence();
          const target = await resolveUserTurnTranscriptTarget(params.target);
          if (!candidate || !target || persistedResult || runtimePersisted) {
            return false;
          }
          const config = target.config as SessionTranscriptTurnPersistOptions["config"];
          const runtimeTarget = await resolveSessionTranscriptRuntimeTarget(target, config);
          pendingInput = await stageSessionPendingInput(
            { ...target, ...runtimeTarget },
            {
              ...options,
              requestFingerprint: params.pendingInputRequestFingerprint,
              trackCompletion: params.trackInputCompletion,
              replaySourceSessionKeys: params.pendingInputReplaySourceSessionKeys,
              message: candidate,
              config,
              onCommitted: (receipt) => {
                pendingInput = receipt;
                message = receipt.message;
                resolvedMessagePromise = Promise.resolve(message);
              },
              prepareMessageAfterIdempotencyCheck: (next) =>
                preparePersistedUserTurnMessageForTranscriptWrite(next, {
                  ...target,
                  beforeMessageWrite: params.beforeMessageWrite ?? target.beforeMessageWrite,
                }),
            },
          );
          if (!pendingInput) {
            return false;
          }
          message = pendingInput.message;
          resolvedMessagePromise = Promise.resolve(message);
          return pendingInput.state !== "consumed";
        })();
        return staging;
      }),
    getPendingInputMessage: () => pendingInput?.message,
    ...processing,
    isPendingInputConsumed: () => pendingInput?.state === "consumed",
    withPendingInput: (run) => (pendingInput ? pendingInput.run(run) : run()),
    finishPendingInput: (disposition) => {
      if (pendingInput) {
        pendingInput.finish(disposition);
      } else {
        for (const source of params.pendingInputSources ?? []) {
          source.finishPendingInput?.(disposition);
        }
      }
    },
    replaceTextBeforePersistence: (text) => {
      if (pendingInput || persistedResult || runtimePersisted || sentToProvider) {
        return;
      }
      replacementText = text;
      message = applyMessageOverrides(message);
      resolvedMessagePromise = undefined;
    },
    confirmSteerTargetRunIdForPersistence: async (targetRunId) => {
      const normalizedTargetRunId = normalizePersistedSteerTargetRunId(targetRunId);
      if (!normalizedTargetRunId || confirmedSteerTargetRunId === normalizedTargetRunId) {
        return;
      }
      confirmedSteerTargetRunId = normalizedTargetRunId;
      message = applyMessageOverrides(message);
      resolvedMessagePromise = undefined;

      const pendingSelfPersistence = selfPersistencePromise;
      await waitForRuntimePersistence();
      await pendingSelfPersistence?.catch(() => undefined);
      if (!admissionReceipt) {
        return;
      }
      try {
        const confirmed = await confirmPersistedSteerTargetRunId({
          admission: admissionReceipt,
          targetRunId: normalizedTargetRunId,
        });
        if (!confirmed) {
          return;
        }
        refreshAdmission(confirmed.admission, confirmed.message);
      } catch (error) {
        handlePersistenceError(error);
      }
    },
    getPersistedMessage: () =>
      admittedMessage ?? runtimePersistedMessage ?? persistedResult?.message,
    captureModelPromptProjection: async (text, assertCurrent) => {
      assertCurrent();
      await waitForRuntimePersistence();
      assertCurrent();
      if (!admissionReceipt && selfPersistencePromise) {
        await selfPersistencePromise;
        assertCurrent();
      }
      resolvedPersistenceTarget ??= await resolveUserTurnTranscriptTarget(params.target);
      assertCurrent();
      const admission = admissionReceipt;
      if (blocked || !admission || !admittedMessage) {
        throw new Error("Model prompt projection requires a live, persisted user turn");
      }
      return await capturePersistedModelPromptProjection({
        admission,
        message: admittedMessage,
        text,
        assertCurrent,
        assertWritable: () => {
          assertCurrent();
          if (blocked || sentToProvider) {
            throw new Error("Model prompt projection must be captured before provider dispatch");
          }
        },
        onCommitted: refreshAdmission,
      });
    },
    getAdmissionReceipt: () => admissionReceipt,
    setAdmissionHandler: (handler) => {
      admissionHandler = handler;
    },
    markSentToProvider: () => {
      sentToProvider = true;
    },
    markRuntimePersistencePending: (pending) => {
      runtimePersistencePromise = pending;
    },
    markRuntimePersisted: (persistedMessage, receipt, persistence) => {
      runtimePersistedMessage = persistedMessage;
      runtimePersisted = true;
      if (persistedMessage && receipt) {
        if (persistence?.appended === true) {
          notifyOriginalInputCommitted({ message: persistedMessage, anchor: receipt });
        }
        void recordAdmission(receipt, persistedMessage, true); // settled by waitForRuntimePersistence
      }
      if (persistedMessage && persistedResult) {
        persistedResult = {
          ...persistedResult,
          message: persistedMessage,
        };
      }
      notifyMessagePersisted(persistedMessage);
    },
    markBlocked: () => {
      blocked = true;
    },
    hasPersisted: () =>
      committedInput !== undefined || persistedResult !== undefined || runtimePersisted,
    isBlocked: () => blocked,
    // An admission write from runtime persistence must also settle before provider dispatch.
    hasRuntimePersistencePending: () =>
      runtimePersistencePromise !== undefined || admissionWrite !== undefined,
    waitForRuntimePersistence,
    persistApproved: async (options) =>
      await persistPrepared({
        waitForRuntime: false,
        skipWhenBlocked: true,
        target: options?.target,
        updateMode: options?.updateMode,
        cwd: options?.cwd,
        expectedSessionId: options?.expectedSessionId,
        expectedSessionState: options?.expectedSessionState,
        sessionLifecyclePatch: options?.sessionLifecyclePatch,
        retryIfUnpersisted: options?.retryIfUnpersisted,
      }),
    persistBlocked: async (blockedMessage, options) => {
      blocked = true;
      return await persistPrepared({
        waitForRuntime: false,
        skipWhenBlocked: false,
        message: blockedMessage,
        target: options?.target,
        updateMode: options?.updateMode,
        cwd: options?.cwd,
      });
    },
    persistFallback: async (options) =>
      await persistPrepared({
        waitForRuntime: true,
        skipWhenBlocked: true,
        target: options?.target,
        updateMode: options?.updateMode,
        cwd: options?.cwd,
      }),
  };
  originalInputCommitNotifiers.set(recorder, (anchor) => {
    const sourceMessage = pendingInput?.message ?? resolvedSourceMessage ?? message;
    if (sourceMessage) {
      notifyOriginalInputCommitted({ message: sourceMessage, anchor });
    }
  });
  registerUserTurnInputActor(recorder, (binding) => {
    inputActorBinding = binding;
  });
  registerUserTurnTranscriptAdmissionOwner(recorder, {
    pendingInput: () => pendingInput,
    withdrawnInputId: () => readWithdrawnSessionPendingInputId(pendingInput),
    receipt: () => admissionReceipt,
    message: () => admittedMessage,
    blocked: () => blocked || confirmedSteerTargetRunId !== undefined,
    sentToProvider: () => sentToProvider,
    refresh: refreshAdmission,
  });
  inheritUserTurnPromptReactionSource(recorder, params.pendingInputSources);
  return recorder;
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.userTurnTranscriptTestApi")] = {
    persistUserTurnTranscript,
  };
}
