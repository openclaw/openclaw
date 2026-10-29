import { isFutureDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { createMessageInjectionAuthority } from "../../auto-reply/reply/message-injection-authority.js";
import { hasPendingFollowupQueueWork } from "../../auto-reply/reply/queue/state.js";
import { retainPreparedSessionEntryPredicate } from "../../config/sessions/session-accessor.sqlite-entry-cache-publication-state.js";
import type { QualifiedSessionEntryAccessTarget } from "../../config/sessions/session-accessor.types.js";
import {
  getSessionActorStorageBinding,
  runWithSessionActorStorage,
} from "../../config/sessions/session-actor-storage-binding.js";
import { acquireSessionInputActor } from "../../config/sessions/session-input-actor.js";
import { withSessionPendingInputAuthorityGuard } from "../../config/sessions/session-pending-input-authority.js";
import {
  withOwnedSessionTranscriptWrites,
  withSessionTranscriptSourcePublication,
} from "../../config/sessions/transcript-write-context.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { isProgressCardRefreshInputProvenance } from "../../sessions/input-provenance.js";
import {
  isCompetingSessionControllerWorkActive,
  captureSessionTarget,
  type SessionEffectRef,
} from "../../sessions/session-controller.lifecycle.js";
import { bindSessionEffectTransition } from "../../sessions/session-controller.owner-context.js";
import {
  getRpcSourceIdentity,
  isRpcSourceRegistered,
  type RpcSourceRef,
} from "../../sessions/session-controller.rpc-sources.js";
import { recordGatewaySessionRunFailure } from "../../sessions/session-run-error.js";
import { trackAsyncWork } from "../../shared/async-work-scope.js";
import type { registerChatAbortController } from "../chat-abort.js";
import { ExpectedProfileMismatchError } from "../expected-profile.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import { captureGatewayClientUploadCommitGuard } from "../upload-policy.js";
import { formatForLog } from "../ws-log.js";
import { readPreRegisteredRun, writePreRegisteredChatAbort } from "./chat-abort-authorization.js";
import { broadcastChatError } from "./chat-broadcast.js";
import { respondChatSendAdmissionError } from "./chat-send-admission-errors.js";
import {
  prepareChatSendRetryComparison,
  resolveChatSendRequestConflict,
  respondChatSendRetry,
} from "./chat-send-pre-admission.js";
import type { ChatSendPreAdmissionParams } from "./chat-send-pre-admission.types.js";
import type { NormalizedChatSendRequest } from "./chat-send-request.js";
import { readChatSendDedupeResponse } from "./chat-send-reservation.js";
import type { ChatSendRetryComparison } from "./chat-send-retry-comparison.js";
import { withCurrentChatSendSession, type PreparedChatSendSession } from "./chat-send-session.js";
import { respondError } from "./response.js";
import type {
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
  SessionMutationAuthorization,
} from "./types.js";

export function assertChatSendWorkAdmissionCurrent(params: {
  retainedWork: Pick<ReturnType<typeof createChatSendWorkAdmission>, "isActive">;
  admission: Pick<SessionEffectRef, "isActive">;
  lifecycleGeneration: string;
  controller: AbortController;
  sourceRef: RpcSourceRef;
}) {
  // Collect retains admission after retiring source cancellation until aggregate settlement.
  if (
    !params.retainedWork.isActive() ||
    !params.admission.isActive() ||
    params.lifecycleGeneration !== getAgentEventLifecycleGeneration() ||
    (params.controller.signal.aborted &&
      !(
        isRpcSourceRegistered(params.sourceRef) &&
        params.sourceRef.input.custody.cancellationRetired
      ))
  ) {
    throw new Error("Chat admission ended or was cancelled; submit a new turn.");
  }
}

/** Preparation returns facts; the caller consumes current retry ownership before reserving. */
export function prepareChatSendAdmissionRetry(params: ChatSendPreAdmissionParams) {
  try {
    return prepareChatSendRetryComparison(params)?.catch((error: unknown) => ({ error }));
  } catch (error) {
    return { error };
  }
}

export function consumeChatSendAdmissionRetry(
  params: ChatSendPreAdmissionParams,
  prepared: Awaited<ReturnType<typeof prepareChatSendAdmissionRetry>>,
) {
  try {
    if (prepared && "error" in prepared) {
      throw prepared.error;
    }
    const pending = readPreRegisteredRun({
      key: params.session.pendingChatSendKey,
      entry: params.context.dedupe.get(params.session.pendingChatSendKey),
    });
    if (pending?.payload.goalFingerprint) {
      respondError(
        params.respond,
        ErrorCodes.INVALID_REQUEST,
        "Run ID is reserved by a Goal request; use a new ID.",
      );
      return false;
    }
    return !params.request.goalOperation && respondChatSendRetry(params, prepared)
      ? false
      : prepared;
  } catch (error) {
    if (error instanceof SessionMutationAuthorizationChangedError) {
      throw error;
    }
    respondChatSendAdmissionError(error, params.respond);
    return false;
  }
}

/** An awaited retry comparison must return to current rows before admission can consume it. */
export async function withCurrentChatSendRetry(
  params: ChatSendPreAdmissionParams & {
    session: PreparedChatSendSession;
    withPreparedCurrent?: SessionMutationAuthorization["withPreparedCurrent"];
  },
  ownPendingAttemptId: string,
  consume: (
    session: Parameters<Parameters<typeof withCurrentChatSendSession>[0]["consume"]>[0],
    comparison: ChatSendRetryComparison | undefined,
  ) => void,
) {
  const withCurrent = <T>(read: (session: Parameters<typeof consume>[0]) => T) =>
    withCurrentChatSendSession({
      session: params.session,
      getRuntimeConfig: params.context.getRuntimeConfig,
      includeMembership: Boolean(params.withPreparedCurrent),
      includeActivePath: params.request.p.queueMode !== "steer",
      consume: (latest, membership, assertSourceCurrent) => {
        const consumeCurrent = () => read(latest);
        if (params.withPreparedCurrent) {
          return params.withPreparedCurrent(
            {
              agentId: latest.agentId,
              storePath: latest.storePath,
              sessionKey: latest.canonicalKey,
              entry: latest.entry,
              readSource: latest.capturedReadSource,
              members: membership.get(latest.legacyKey ?? latest.canonicalKey) ?? [],
            },
            consumeCurrent,
            assertSourceCurrent,
          );
        }
        assertSourceCurrent();
        return consumeCurrent();
      },
    });
  const pending = await withCurrent((session) => {
    const comparison = prepareChatSendRetryComparison(
      { ...params, session: { ...params.session, entry: session.entry } },
      ownPendingAttemptId,
    );
    if (comparison) {
      return observeChatSendWork(comparison);
    }
    consume(session, undefined);
    return undefined;
  });
  if (pending) {
    const comparison = await pending();
    await withCurrent((session) => consume(session, comparison));
  }
}

/** Settle an invalid exact attempt before selecting its admission failure response. */
export function respondChatSendWorkAdmissionFailure(
  params: ChatSendPreAdmissionParams,
  error: unknown,
  admission: {
    attemptId: string;
    lifecycleGeneration: string;
    pendingReservation: ReturnType<typeof readPreRegisteredRun>;
    requestIdentity?: string;
    runAbort: ReturnType<typeof registerChatAbortController>;
  },
  comparison?: ChatSendRetryComparison,
) {
  if (error instanceof ExpectedProfileMismatchError) {
    throw error;
  }
  const { context, respond, session } = params;
  const { clientRunId } = session;
  const pending = admission.pendingReservation;
  const pendingAttempt = normalizeOptionalString(pending?.payload.attemptId);
  if (
    !readChatSendDedupeResponse(context.dedupe, clientRunId) &&
    (!pendingAttempt || pendingAttempt === admission.attemptId)
  ) {
    // The controller source exists before worker reads, so cancellation can win that read.
    const stopReason = admission.runAbort.controller.signal.aborted
      ? (admission.runAbort.entry?.adapter.abortStopReason ?? "rpc")
      : admission.lifecycleGeneration !== getAgentEventLifecycleGeneration()
        ? "restart"
        : !pending || !isFutureDateTimestampMs(pending.payload.expiresAtMs, { nowMs: Date.now() })
          ? "timeout"
          : undefined;
    // A pre-ACK restart leaves unstarted input with the client for retry.
    if (stopReason && stopReason !== "restart") {
      writePreRegisteredChatAbort({
        context,
        runId: clientRunId,
        stopReason,
        attemptId: admission.attemptId,
        requestIdentity: admission.requestIdentity,
      });
    }
  }
  try {
    const conflict = resolveChatSendRequestConflict(params, comparison);
    if (conflict) {
      respond(false, undefined, conflict);
      return;
    }
  } catch {
    // Preserve the original refusal when no current comparison evidence is available.
  }
  const aborted =
    context.chatRunState.hasAbortMarker(clientRunId) &&
    readChatSendDedupeResponse(context.dedupe, clientRunId);
  if (aborted) {
    respond(aborted.ok, aborted.payload, aborted.error, { cached: true, runId: clientRunId });
    return;
  }
  respondChatSendAdmissionError(error, respond, (errorMessage) => {
    if (isProgressCardRefreshInputProvenance(params.request.systemInputProvenance)) {
      return;
    }
    // Admission can fail before the transcript/setup error owner exists.
    broadcastChatError({
      context,
      terminalEntry: admission.runAbort.entry,
      runId: clientRunId,
      sessionKey: session.sessionKey,
      agentId: session.agentId,
      errorMessage,
    });
  });
}

/** New input is checked only after the chat owner has reconciled prior receipts. */
export function admitChatSendUploads({
  params,
  client,
  context,
  respond,
}: Pick<GatewayRequestHandlerOptions, "params" | "client" | "context" | "respond">) {
  try {
    const assertClientUploadAllowed = captureGatewayClientUploadCommitGuard({
      method: "chat.send",
      requestParams: params,
      client,
      context,
    });
    assertClientUploadAllowed?.();
    return { ok: true as const, assertClientUploadAllowed };
  } catch (error) {
    if (!(error instanceof SessionMutationAuthorizationChangedError)) {
      throw error;
    }
    respond(false, undefined, error.error);
    return { ok: false as const };
  }
}

/** Observe started work before the retained read releases; consuming still rethrows its error. */
export function observeChatSendWork<T>(work: Promise<T>): () => Promise<T> {
  void work.catch(() => {});
  return () => work;
}

/** Queued and collected turns share the original session and caller admission until settlement. */
export function createChatSendWorkAdmission(params: {
  admission: Pick<SessionEffectRef, "release">;
  followRegistration?: SessionMutationAuthorization["followRegistration"];
  releaseCallerAuthority?: () => void;
  releaseGatewayRootContinuation?: () => void;
  logGateway: Pick<GatewayRequestContext["logGateway"], "warn">;
  terminal?: {
    target: QualifiedSessionEntryAccessTarget;
    storePath: string;
    sourceRef: RpcSourceRef;
    lifecycleRevision?: string;
    isActive: () => boolean;
  };
}) {
  const terminal = params.terminal;
  const storage =
    terminal &&
    getSessionActorStorageBinding({
      agentId: terminal.target.agentId,
      sessionKey: terminal.target.canonicalKey,
      storePath: terminal.storePath,
    });
  const inStorage = <T>(run: () => T): T =>
    storage ? runWithSessionActorStorage(storage, run) : run();
  let references = 1;
  const cleanup: Array<() => void> = [];
  let admittedSource = terminal?.target.readSource;
  let lifecycleRevision = terminal?.lifecycleRevision;
  let isCommittedDestinationCurrent: (() => boolean) | undefined;
  let committedDestination: Pick<SessionEntry, "sessionId" | "lifecycleRevision"> | undefined;
  let releaseCommittedDestination: (() => void) | undefined;
  let finishPendingInput: (() => void | Promise<void>) | undefined;
  let inputActor: ReturnType<typeof acquireSessionInputActor> | undefined;
  let actorLifetimeActive = true;
  const releaseAdmission = () => {
    for (const dispose of cleanup.splice(0)) {
      try {
        dispose();
      } catch (error) {
        warnCleanupFailure(error);
      }
    }
    try {
      params.admission.release();
    } finally {
      try {
        params.releaseCallerAuthority?.();
      } finally {
        params.releaseGatewayRootContinuation?.();
      }
    }
  };
  const warnCleanupFailure = (error: unknown) => {
    params.logGateway.warn(`Failed to finish pending chat input: ${formatForLog(error)}`);
  };
  const finishRelease = () => {
    if (!inputActor) {
      actorLifetimeActive = false;
      releaseAdmission();
      return;
    }
    const close = async () => {
      try {
        await (await inputActor)?.actor.release();
      } finally {
        actorLifetimeActive = false;
        releaseAdmission();
      }
    };
    void close().catch(warnCleanupFailure);
  };
  const release = () => {
    if (references === 0) {
      return;
    }
    references -= 1;
    if (references !== 0) {
      return;
    }
    let pending: void | Promise<void> = undefined;
    try {
      pending = inStorage(() => finishPendingInput?.());
    } catch (error) {
      // A failed disposition write must
      // not strand session/root drain ownership during shutdown.
      warnCleanupFailure(error);
    }
    if (pending) {
      // The existing admission's drain joins this write before releasing the
      // session/root fence; prompt custody has already been revoked.
      void pending.then(finishRelease, (error: unknown) => {
        warnCleanupFailure(error);
        finishRelease();
      });
    } else {
      finishRelease();
    }
  };
  const hold = () => {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      release();
    };
  };
  const retain = () => {
    if (references === 0) {
      throw new Error("cannot retain a released chat work admission");
    }
    references += 1;
    return hold();
  };
  return {
    acquireInputActor() {
      if (!inputActor) {
        if (!terminal || references === 0) {
          throw new Error("Chat input actor has no live admission");
        }
        const assertCurrent = () => {
          if (!actorLifetimeActive || !terminal.isActive()) {
            throw new Error("Chat input actor admission ended");
          }
        };
        const followRegistration = params.followRegistration;
        inputActor = inStorage(() =>
          acquireSessionInputActor(
            {
              agentId: terminal.target.agentId,
              storePath: terminal.storePath,
              readSource: terminal.target.readSource,
              target: {
                canonicalKey: terminal.target.canonicalKey,
                storeKeys: [...terminal.target.storeKeys],
              },
            },
            { assertCurrent, assertReadable: assertCurrent },
            followRegistration &&
              ((change) =>
                followRegistration(
                  { sessionKey: terminal.target.canonicalKey, agentId: terminal.target.agentId },
                  change,
                )),
          ),
        );
      }
      return inputActor;
    },
    addCleanup: (dispose: () => void) => cleanup.push(dispose),
    isActive: () => references > 0,
    assertCommittedDestinationCurrent(this: void) {
      if (
        isCommittedDestinationCurrent &&
        (references === 0 || !terminal?.isActive() || !isCommittedDestinationCurrent())
      ) {
        throw new Error("Committed chat input session changed");
      }
    },
    recordFailureNotice(
      this: void,
      failure: Pick<
        Parameters<typeof recordGatewaySessionRunFailure>[0],
        "runId" | "error" | "errorKind"
      >,
    ) {
      if (!terminal) {
        throw new Error("Failed input notice requires its original admission target");
      }
      const expectedLifecycleRevision = lifecycleRevision;
      const target = {
        agentId: terminal.target.agentId,
        storePath: terminal.target.storePath,
        sessionKey: terminal.target.storeKey,
        sessionId: getRpcSourceIdentity(terminal.sourceRef).sessionId,
        expectedOwner: { lifecycleRevision: expectedLifecycleRevision },
      };
      const assertCommitAllowed = () => {
        if (references === 0 || !terminal.isActive()) {
          throw new Error("Failed input notice admission ended");
        }
      };
      // Failure bookkeeping keeps accepted source custody after sender revocation,
      // without claiming or terminating the session's running writer.
      return inStorage(() =>
        withOwnedSessionTranscriptWrites(
          { sessionTarget: target, assertCommitAllowed, withTranscriptWrite: trackAsyncWork },
          () =>
            recordGatewaySessionRunFailure({
              ...failure,
              target,
              assertCommitAllowed,
              sessionEntryCurrent: admittedSource
                ? {
                    source: { ...admittedSource, sessionKey: target.sessionKey },
                    assertCurrent(facts) {
                      assertCommitAllowed();
                      if (
                        facts?.sessionId !== target.sessionId ||
                        facts.lifecycleRevision !== expectedLifecycleRevision
                      ) {
                        throw new Error("Failed input notice session changed");
                      }
                    },
                  }
                : undefined,
            }),
        ),
      );
    },
    release: hold(),
    retain,
    withInputCommitPublication<T>(
      this: void,
      run: () => Promise<T>,
      onCommitted?: Parameters<typeof withSessionTranscriptSourcePublication>[1],
    ): Promise<T> {
      if (!terminal) {
        throw new Error("Chat input publication requires its original admission target");
      }
      return inStorage(() =>
        withSessionTranscriptSourcePublication(
          {
            agentId: terminal.target.agentId,
            sessionId: getRpcSourceIdentity(terminal.sourceRef).sessionId,
            sessionKey: terminal.target.storeKey,
            storePath: terminal.target.storePath,
          },
          (source, committedEntry) => {
            if (
              admittedSource &&
              (admittedSource.agentId !== source.agentId ||
                admittedSource.path !== source.path ||
                admittedSource.databaseIdentity !== source.databaseIdentity ||
                admittedSource.databaseBirthtime !== source.databaseBirthtime)
            ) {
              throw new Error("Committed chat input changed its admitted physical source");
            }
            admittedSource ??= source;
            if (!isCommittedDestinationCurrent) {
              const bindDestination = (entry: SessionEntry) => {
                releaseCommittedDestination?.();
                committedDestination = entry;
                const { sessionId, lifecycleRevision: committedRevision } = entry;
                const matches = (current: SessionEntry | undefined) =>
                  current !== undefined &&
                  current.archivedAt === undefined &&
                  current.lifecycleRevision === committedRevision &&
                  (committedRevision !== undefined || current.sessionId === sessionId);
                // Compaction can rotate a revision-bound transcript; legacy rows still bind its id.
                if (storage) {
                  isCommittedDestinationCurrent = () =>
                    matches(
                      storage.actor.storage.readCurrent(
                        {
                          type: "session.entry.read",
                          input: { sessionKey: terminal.target.storeKey },
                        },
                        storage.authority,
                      ),
                    );
                } else {
                  const retained = retainPreparedSessionEntryPredicate({
                    databaseIdentity: `file:${source.databaseIdentity}`,
                    sessionKey: terminal.target.storeKey,
                    entry,
                    matches: (_before, current) => matches(current),
                  });
                  releaseCommittedDestination = retained.release;
                  isCommittedDestinationCurrent = retained.isCurrent;
                }
              };
              bindDestination(committedEntry);
              cleanup.push(() => releaseCommittedDestination?.());
              bindSessionEffectTransition(
                captureSessionTarget({
                  storeScope: terminal.storePath,
                  sessionKey: terminal.target.canonicalKey,
                  agentId: terminal.target.agentId,
                }),
                terminal,
                ({ previous, current }) => {
                  if (
                    previous?.sessionId === committedDestination?.sessionId &&
                    previous?.lifecycleRevision === committedDestination?.lifecycleRevision
                  ) {
                    bindDestination({ ...committedEntry, ...current });
                    lifecycleRevision = current.lifecycleRevision;
                  }
                },
              );
            }
            lifecycleRevision = committedEntry.lifecycleRevision;
            onCommitted?.(source, committedEntry);
          },
          run,
        ),
      );
    },
    setPendingInputCleanup: (finish: () => void | Promise<void>) => {
      finishPendingInput = finish;
    },
  };
}

/** Rechecked inside the session writer barrier before exclusive input is admitted. */
export function assertChatSendExclusiveAdmission(
  request: NormalizedChatSendRequest,
  session: PreparedChatSendSession,
): void {
  if (!request.goalOperation && !request.providerReviewAcknowledgment) {
    return;
  }
  const { storePath, sessionKey, backingSessionId, activeRunScopeKey } = session;
  if (
    isCompetingSessionControllerWorkActive(
      storePath,
      [sessionKey, backingSessionId],
      session.agentId,
    ) ||
    hasPendingFollowupQueueWork([sessionKey, backingSessionId, activeRunScopeKey], {
      storeScope: storePath,
      agentId: session.agentId,
    })
  ) {
    throw new Error(
      request.providerReviewAcknowledgment
        ? "The session still has active work. Review its status before continuing."
        : "goal-session-busy",
    );
  }
}

export function createChatSendPendingInputAdmission({
  runId,
  expectedProfileId,
  sessionMutationAuthorization,
  sessionMutationCommitGuard,
  assertCustodyLifetimeCurrent,
  assertClientUploadAllowed,
}: Pick<
  GatewayRequestHandlerOptions,
  "sessionMutationAuthorization" | "sessionMutationCommitGuard"
> & {
  runId: string;
  expectedProfileId?: string;
  assertCustodyLifetimeCurrent: () => void;
  assertClientUploadAllowed?: () => void;
}) {
  const assertCustodyCurrent = () => {
    assertCustodyLifetimeCurrent();
    if (sessionMutationAuthorization?.assertAdmittedInputCurrent) {
      sessionMutationAuthorization.assertAdmittedInputCurrent();
    } else {
      sessionMutationCommitGuard?.();
      sessionMutationAuthorization?.assertCurrent();
    }
  };
  let preparationFailure: { cause: unknown } | undefined;
  const assertAdmittedCurrent =
    expectedProfileId === undefined
      ? assertCustodyCurrent
      : createMessageInjectionAuthority(() => {
          if (preparationFailure) {
            throw preparationFailure.cause;
          }
          assertCustodyCurrent();
          return true;
        });
  return {
    runId,
    authority: sessionMutationAuthorization?.admittedInputAuthority
      ? withSessionPendingInputAuthorityGuard(
          sessionMutationAuthorization.admittedInputAuthority,
          assertCustodyLifetimeCurrent,
          expectedProfileId === undefined
            ? undefined
            : (cause) => {
                preparationFailure ??= { cause };
                assertAdmittedCurrent();
                throw cause;
              },
        )
      : undefined,
    assertCurrent: () => {
      assertClientUploadAllowed?.();
      sessionMutationCommitGuard?.();
      assertCustodyCurrent();
    },
    assertAdmittedCurrent,
  };
}
