import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { ErrorCodes, type AgentWaitParams } from "../../../packages/gateway-protocol/src/index.js";
import { isMainSessionRecoveryReconciliationCandidate } from "../../agents/main-session-recovery/main-session-recovery-state.js";
import type { MainSessionRecoveryOwnerLease } from "../../agents/main-session-recovery/main-session-recovery-store.js";
import { mergeSessionEntry, type SessionEntry } from "../../config/sessions.js";
import {
  acquireSessionActorStorage,
  runWithSessionActorStorage,
} from "../../config/sessions/session-actor-storage-binding.js";
import { composeSessionSourceAssertion } from "../../config/sessions/session-source-authority.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import {
  getRpcSourceForGateway,
  isRpcSourceRegistered,
  updateRpcSourceSessionId,
} from "../../sessions/session-controller.rpc-sources.js";
import { normalizeDeliveryContext } from "../../utils/delivery-context.shared.js";
import { registerChatAbortController } from "../chat-abort.js";
import type { OffloadedRef } from "../chat-attachments.js";
import { errorShapeFromError } from "../error-shape.js";
import { readInProcessSubagentResume } from "../in-process-subagent-resume.js";
import { createCronContinuationController } from "../server-methods/agent-cron-continuation.js";
import { runAgentResetPhase } from "../server-methods/agent-reset-phase.js";
import { buildAgentSessionPatch } from "../server-methods/agent-session-patch.js";
import { prepareAgentSession } from "../server-methods/agent-session-prepare.js";
import type { GatewayRequestHandlerOptions, RespondFn } from "../server-methods/shared-types.js";
import { resolveAgentRunSessionCreation } from "../session-creation-provenance.js";
import { resolveSessionWorkerPlacementContext } from "../session-worker-placement-context.js";
import { prepareSkillLibrarySessionCreation } from "../skill-library-session.js";
import { createAgentAdmissionController } from "./agent-admission-controller.js";
import { prepareAgentContentPhase } from "./agent-content-phase.js";
import { createAgentDedupeLifecycle } from "./agent-dedupe-lifecycle.js";
import { AgentRequestReservationEndedError, replayAgentTurnIfCached } from "./agent-dedupe.js";
import { resolveAgentDeliveryPhase } from "./agent-delivery-phase.js";
import type { RestoredCronContinuation } from "./agent-handler-helpers.js";
import { prepareAgentRequestRouting } from "./agent-request-routing.js";
import { prepareAgentRunDispatch } from "./agent-run-admission-phase.js";
import { isGatewayAgentAbortRejection } from "./agent-run-dispatch-outcome.js";
import { startAgentRunExecution } from "./agent-run-execution-phase.js";
import {
  persistAgentSessionPhase,
  type AgentSessionPersistResult,
} from "./agent-session-persist.js";
import { finishAgentTurnPreparation } from "./agent-turn-admission-cleanup.js";
import { createAgentTurnPreparationSource } from "./agent-turn-preparation-source.js";
import {
  authorizeAgentTurnSession,
  registerAgentTurnRunAbort,
  registerAgentTurnSourceAdmission,
} from "./agent-turn-source-admission.js";
import type { AgentTurnStartRequest } from "./agent-turn-start-request.types.js";
import { prepareAgentWaitForTurn } from "./agent-wait.js";

export function createAgentTurnService(
  { context, isWebchatConnect }: Pick<GatewayRequestHandlerOptions, "context" | "isWebchatConnect">,
  assertContextCurrent?: () => void,
) {
  const startTurn = async ({
    controllerInput,
    privateCompletion,
    replyExpectation,
    settleWakeReplay,
    assertAdmissionCurrent,
    assertCancellationCurrent,
    executionSource,
    assertInputCommitAllowed,
    hasCurrentClientAuthority,
    preflight,
    principal,
    io,
    onRunObserved,
  }: AgentTurnStartRequest): Promise<void> => {
    const promptedAt = Date.now();
    assertAdmissionCurrent?.();
    // Durable input decides replay for private continuations and trusted parent
    // resumes after their prior source retires, including pre-admission Stop.
    const reconcileDurableInput =
      privateCompletion === true || readInProcessSubagentResume(principal?.internal) !== undefined;
    if (replayAgentTurnIfCached({ preflight, context, io, acceptedOnly: reconcileDurableInput })) {
      return;
    }
    // Cache eviction does not release a registered source's protocol run ID.
    const existingSource = getRpcSourceForGateway(preflight.runId, context.resolveGatewayContext);
    if (existingSource && existingSource.input !== controllerInput) {
      io.emitAcceptance([true, { runId: preflight.runId, status: "in_flight" }, undefined], {
        cached: true,
        runId: preflight.runId,
      });
      return;
    }
    assertInputCommitAllowed?.();
    const respond: RespondFn = (ok, payload, error, meta) =>
      io.emitAcceptance([ok, payload, error], meta);
    const {
      request,
      cfg,
      runId,
      canUseCronRunContinuation,
      expectedSession,
      expectedExistingSessionId,
      normalizedSpawned,
      isRestartRecoveryResumeRun,
      suppressVisibleSessionEffects,
      agentDedupeKeys,
    } = preflight;
    // Cached replay returns before a new lifecycle generation is observed, matching
    // the idempotency path that preceded this service extraction.
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const initialSessionGroups = {
      groupId: normalizedSpawned.groupId,
      groupChannel: normalizedSpawned.groupChannel,
      groupSpace: normalizedSpawned.groupSpace,
    };
    const ownerConnId = typeof principal?.connId === "string" ? principal.connId : undefined;
    const ownerDeviceId =
      typeof principal?.connect?.device?.id === "string" ? principal.connect.device.id : undefined;
    const dedupeLifecycle = createAgentDedupeLifecycle({
      ...preflight,
      reconcileDurableInput,
      assertAdmissionCurrent,
      assertCancellationCurrent,
      ownerConnId,
      ownerDeviceId,
      context,
      io,
    });
    let sourcePreparationComplete = false;
    let earlyRunAbort: ReturnType<typeof registerChatAbortController> | undefined;
    using preparationSource = createAgentTurnPreparationSource({
      runId,
      context,
      controllerInput,
      requester: { connectionId: ownerConnId, deviceId: ownerDeviceId },
      assertAdmissionCurrent,
      onCancelled: dedupeLifecycle.cancelOwnedReservation,
    });
    const assertRequestCurrent = composeSessionSourceAssertion([
      assertContextCurrent,
      assertAdmissionCurrent,
      () => {
        const signal = preparationSource.input?.abortSignal;
        // Preserve source failures; classified cancellation yields to its terminal replay.
        if (signal?.aborted && !isGatewayAgentAbortRejection(signal.reason, signal)) {
          signal.throwIfAborted();
        }
        dedupeLifecycle.assertReservationCurrent();
      },
      preparationSource.assertCurrent,
      () => {
        if (earlyRunAbort?.entry && !isRpcSourceRegistered(earlyRunAbort.entry)) {
          throw new Error("Agent request no longer owns its RPC source");
        }
      },
      assertInputCommitAllowed,
    ]);
    const routing = await prepareAgentRequestRouting({
      ...preflight,
      context,
      respond,
      reserveDedupe: (sessionKey, agentId) => {
        dedupeLifecycle.reserve(sessionKey, agentId);
        dedupeLifecycle.assertReservationCurrent();
        preparationSource.reserve(sessionKey, agentId);
      },
      bindDedupeSessionTarget: dedupeLifecycle.bindSessionTarget,
      clearDedupe: dedupeLifecycle.clearUnaccepted,
      assertCurrent: assertRequestCurrent,
    }).catch((error: unknown) => {
      dedupeLifecycle.clearUnaccepted();
      return dedupeLifecycle.handlePreparationFailure(assertAdmissionCurrent)(error);
    });
    if (!routing) {
      return;
    }
    let storageActive = true;
    let gatewayAdmissionTransferred = false;
    const assertStorageCurrent = () => {
      if (!storageActive) {
        throw new Error("Agent session storage admission ended");
      }
      assertContextCurrent?.();
    };
    const sessionStorage = await acquireSessionActorStorage(
      { sessionKey: routing.requestedSessionKey, agentId: routing.agentId },
      {
        lifetime: { assertCurrent: assertStorageCurrent, assertReadable: assertStorageCurrent },
        authority: { assertCurrent: assertStorageCurrent, authorize: assertStorageCurrent },
      },
    ).catch((error: unknown) => {
      dedupeLifecycle.clearUnaccepted();
      throw error;
    });
    const releaseSessionStorage = async () => {
      if (!storageActive) {
        return;
      }
      storageActive = false;
      await sessionStorage?.actor.release();
    };
    const execute = async () => {
      const {
        requestedBestEffortDeliver,
        requestedSessionId,
        sessionKeyFromTo,
        requestedSessionKeyRaw,
        preAcceptedReservedSessionKey,
        preAttachmentSession,
      } = routing;
      const runAbortSource = {
        preflight,
        io,
        sourceWork: preparationSource.work,
        lifecycleGeneration,
        ownerConnId,
        ownerDeviceId,
        assertAdmissionCurrent,
        isSourcePreparationComplete: () => sourcePreparationComplete,
        onCancelled: dedupeLifecycle.cancelOwnedReservation,
        controllerInput: preparationSource.input,
      };
      let agentId = routing.agentId;
      let requestedSessionKey = routing.requestedSessionKey;
      let preparedOffloadedRefs: OffloadedRef[] = [];
      let mainRestartRecoveryOwnerLease: MainSessionRecoveryOwnerLease | undefined;
      let releaseGatewayAdmission = () => {};
      let respondToAdmissionOutcome = () => false;
      const cronContinuation = createCronContinuationController({
        runId,
        lifecycleGeneration,
        context,
      });
      try {
        assertAdmissionCurrent?.();
        const content = await prepareAgentContentPhase({
          ...preflight,
          ...routing,
          assertAdmissionCurrent: assertRequestCurrent,
          context,
          respond,
          requestedSessionKey,
          agentId,
          onTargetResolved: (target) =>
            registerAgentTurnSourceAdmission({
              ...target,
              ...runAbortSource,
              principal,
              assertRequestCurrent,
              onRegistered: (registration) => {
                earlyRunAbort = registration;
              },
            }),
        }).catch(dedupeLifecycle.handlePreparationFailure(assertAdmissionCurrent));
        if (!content) {
          return;
        }
        preparedOffloadedRefs = content.offloadedRefs;
        assertAdmissionCurrent?.();
        agentId = content.agentId;
        requestedSessionKey = content.requestedSessionKey;
        // Participation is authorized below against the canonical session the run
        // actually targets (see prepareAgentSession). A keyless request resolves its
        // default/effective session there, so authorizing only an explicit key here
        // would let a non-member drive a restricted default session.
        let effectiveTranscriptInputText = content.effectiveTranscriptInputText;
        let message = content.message;
        const {
          images,
          imageOrder,
          media,
          offloadedRefs,
          recipientChannel,
          recipientAccountId,
          recipientThreadId,
          to,
        } = content;
        const session: AgentSessionPersistResult = {
          resolvedSessionId: requestedSessionId,
          sessionPersistedBeforeGatewayAdmission: false,
          bestEffortDeliver: requestedBestEffortDeliver ?? false,
          isNewSession: false,
          skipAgentInitialSessionTouch: false,
          admittedSessionId: requestedSessionId ?? runId,
          ...initialSessionGroups,
        };
        let effectiveBootstrapContextRunKind = preflight.bootstrapContextRunKind;
        let restoredCronContinuationIdentity:
          | Pick<RestoredCronContinuation, "lifecycleRevision" | "sessionId">
          | undefined;
        let cfgForAgent: OpenClawConfig | undefined;
        let freshChild = false;
        let sessionStorePath: string | undefined;
        let resolvedSessionKey = requestedSessionKey;
        let resolvedSessionAgentId: string | undefined;
        const admissionController = createAgentAdmissionController({
          assertAdmissionCurrent,
          runId,
          agentDedupeKeys,
          preAcceptedReservedSessionKey,
          expectedSession,
          context,
          io,
          dedupeLifecycle,
          getRequestedSessionKey: () => requestedSessionKey,
          getResolvedSessionKey: () => resolvedSessionKey,
          getResolvedSessionId: () => session.resolvedSessionId,
          getSessionEntry: () => session.sessionEntry,
          setSessionEntry: (entry) => {
            session.sessionEntry = entry;
          },
          getResolvedSessionAgentId: () => resolvedSessionAgentId,
          getAgentId: () => agentId,
          getSessionPersisted: () => session.sessionPersistedBeforeGatewayAdmission,
          getSupersededSessionId: () => session.supersededSessionId,
          setAdmittedSessionId: (sessionId) => {
            session.admittedSessionId = sessionId;
          },
        });
        if (earlyRunAbort) {
          admissionController.setAdmittedRunAbort(earlyRunAbort);
        }
        releaseGatewayAdmission = admissionController.release;
        respondToAdmissionOutcome = () => {
          admissionController.assertAllowed();
          return admissionController.respondToOutcome();
        };
        const resetPhase = await runAgentResetPhase({
          assertAdmissionCurrent: assertRequestCurrent,
          request,
          cfg,
          requestedSessionKey,
          resolvedSessionId: session.resolvedSessionId,
          effectiveTranscriptInputText,
          message,
          agentId,
          sessionKeyFromTo,
          lifecycleGeneration,
          runId,
          agentDedupeKeys,
          client: principal,
          context,
          respond,
          setCommittedResetCompletion: dedupeLifecycle.setCommittedResetCompletion,
        });
        requestedSessionKey = resetPhase.requestedSessionKey;
        session.resolvedSessionId = resetPhase.resolvedSessionId;
        effectiveTranscriptInputText = resetPhase.effectiveTranscriptInputText;
        message = resetPhase.message;
        if (resetPhase.accepted) {
          dedupeLifecycle.markAccepted(true);
        }
        if (resetPhase.stop) {
          return;
        }

        if (requestedSessionKey) {
          const preparedSession = await prepareAgentSession({
            cfg,
            requestedSessionKey,
            requestedSessionId,
            expectedExistingSessionId,
            agentId,
            recipientChannel,
            request,
            canUseCronRunContinuation,
            lifecycleGeneration,
            effectiveBootstrapContextRunKind,
            preAttachmentSession,
            respond,
            assertCurrent: assertRequestCurrent,
          });
          assertRequestCurrent();
          if (!preparedSession) {
            return;
          }
          const {
            cfg: cfgLocal,
            storePath,
            canonicalKey: canonicalSessionKey,
            storeKeys,
            maintenanceConfig: sessionMaintenanceConfig,
            canonicalSessionAgentId: sessionAgentId,
            mainSessionKey,
            touchInteraction,
          } = preparedSession;
          let { entry } = preparedSession;
          cfgForAgent = cfgLocal;
          freshChild = preparedSession.freshChild;
          sessionStorePath = storePath;
          // Authorize the canonical session the run will actually target — covering
          // keyless requests whose default/effective session is resolved only here —
          // before any run side effects (admission, dispatch).
          const sessionAuthorizationError = await authorizeAgentTurnSession({
            cfg: cfgLocal,
            principal,
            sessionKey: canonicalSessionKey,
            agentId: sessionAgentId,
          });
          if (sessionAuthorizationError) {
            io.emitAcceptance([false, undefined, sessionAuthorizationError]);
            return;
          }
          if (
            !isRestartRecoveryResumeRun &&
            entry &&
            isMainSessionRecoveryReconciliationCandidate(entry)
          ) {
            // Replay can precede startup recovery. Restore the dead predecessor's
            // custody before this admission touches its row or replaces its claim.
            const { reconcileOrphanedGatewaySessionRecovery } =
              await import("../session-recovery-source.js");
            entry =
              (await reconcileOrphanedGatewaySessionRecovery({
                cfg: cfgLocal,
                target: {
                  agentId: sessionAgentId,
                  storePath,
                  canonicalKey: canonicalSessionKey,
                  storeKeys,
                },
                entry,
                authorizedPluginId: principal?.internal?.pluginRuntimeOwnerId,
                commitGuard: assertRequestCurrent,
                workerPlacementContext: resolveSessionWorkerPlacementContext(context),
              })) ?? entry;
            assertRequestCurrent();
          }
          effectiveBootstrapContextRunKind = preparedSession.effectiveBootstrapContextRunKind;
          restoredCronContinuationIdentity = preparedSession.restoredCronContinuationIdentity;
          session.sessionPersistedBeforeGatewayAdmission =
            preparedSession.sessionPersistedBeforeGatewayAdmission;
          const requestDeliveryHint = normalizeDeliveryContext({
            channel: recipientChannel?.trim(),
            to,
            accountId: recipientAccountId?.trim(),
            // Pass threadId directly — normalizeDeliveryContext handles both
            // string and numeric threadIds (e.g., Matrix uses integers).
            threadId: recipientThreadId,
          });
          const explicitSessionKey = normalizeOptionalString(request.sessionKey);
          const buildSessionPatch = (
            freshEntry: SessionEntry | undefined,
            fallbackSessionId?: string,
          ) =>
            buildAgentSessionPatch({
              ...preparedSession,
              freshEntry,
              initialEntry: entry,
              sessionAgentId,
              canonicalSessionKey,
              normalizedSpawned,
              requestDeliveryHint,
              requestLabel: request.label,
              ...(explicitSessionKey ? { explicitSessionKey } : {}),
              pluginOwnerId:
                freshEntry === undefined
                  ? normalizeOptionalString(principal?.internal?.pluginRuntimeOwnerId)
                  : undefined,
              expectedExistingSessionId,
              hasRestoredCronContinuation: restoredCronContinuationIdentity !== undefined,
              requestedSessionId,
              fallbackSessionId,
            });
          const patchBuild = preparedSession.freshChild
            ? {
                patch: {},
                spawnedBy: entry?.spawnedBy,
                groupId: entry?.groupId,
                groupChannel: entry?.groupChannel,
                groupSpace: entry?.space,
                freshSessionRotatedSinceLoad: false,
                isNewSession: false,
                rotatedSessionId: false,
                usableRequestedSessionId: undefined,
                freshness: { fresh: true },
              }
            : await buildSessionPatch(entry);
          assertRequestCurrent();
          session.sessionEntry = entry;
          session.resolvedSessionId = mergeSessionEntry(entry, patchBuild.patch).sessionId;
          // The initial patch owns the stable fallback for writer-side re-evaluation.
          const fallbackSessionId = session.resolvedSessionId;
          session.admittedSessionId = session.resolvedSessionId ?? runId;
          resolvedSessionKey = canonicalSessionKey;
          resolvedSessionAgentId = sessionAgentId;
          if (!admissionController.getAdmittedRunAbort()) {
            registerAgentTurnRunAbort(
              {
                ...runAbortSource,
                onRegistered: (registration) => {
                  earlyRunAbort = registration;
                  admissionController.setAdmittedRunAbort(registration);
                },
              },
              {
                cfg: cfgLocal,
                storeScope: storePath,
                physicalStorePath: preparedSession.physicalStorePath,
                sessionKey: canonicalSessionKey,
                aliases: [requestedSessionKey],
                agentId: sessionAgentId,
                sessionId: session.resolvedSessionId,
                incarnation: entry?.sessionId,
              },
            );
          }
          try {
            await admissionController.acquire(storePath ?? `agent:${sessionAgentId}`);
          } catch (err) {
            io.emitAcceptance([
              false,
              undefined,
              errorShapeFromError(ErrorCodes.INVALID_REQUEST, err),
            ]);
            return;
          }
          if (admissionController.respondToOutcome()) {
            return;
          }
          const persistedSession = await persistAgentSessionPhase({
            freshChild: preparedSession.freshChild,
            onSessionCommitted: (committedEntry) => {
              session.sessionEntry = committedEntry;
              if (earlyRunAbort?.entry) {
                updateRpcSourceSessionId(earlyRunAbort.entry, committedEntry.sessionId);
              }
              dedupeLifecycle.bindSessionTarget({
                sessionKey: canonicalSessionKey,
                agentId: sessionAgentId,
                sessionId: committedEntry.sessionId,
              });
            },
            assertAdmissionCurrent: assertRequestCurrent,
            request,
            cfg: cfgLocal,
            storePath,
            storeKeys,
            entry,
            canonicalSessionKey,
            sessionAgentId,
            mainSessionKey,
            creation: await prepareSkillLibrarySessionCreation(
              principal,
              () => context.getRuntimeConfig(),
              resolveAgentRunSessionCreation(principal),
            ),
            ...(principal?.authenticatedUserProfile
              ? { requestingOperatorProfileId: principal.authenticatedUserProfile.profileId }
              : {}),
            ...(principal?.internal?.operatorRoleActor
              ? { operatorRoleActor: principal.internal.operatorRoleActor }
              : {}),
            lifecycleGeneration,
            isRestartRecoveryResumeRun,
            runId,
            agentId,
            suppressVisibleSessionEffects,
            restoredCronContinuationIdentity,
            initialPatchBuild: patchBuild,
            buildSessionPatch: (freshEntry) => buildSessionPatch(freshEntry, fallbackSessionId),
            state: session,
            touchInteraction,
            requestedBestEffortDeliver,
            expectedSession,
            maintenanceConfig: sessionMaintenanceConfig,
            assertGatewayWorkAdmissionAllowed: admissionController.assertAllowed,
            respondToGatewayAdmissionOutcome: admissionController.respondToOutcome,
            setCronContinuationClaim: cronContinuation.setClaim,
            setMainRestartRecoveryOwnerLease: (lease) => {
              mainRestartRecoveryOwnerLease = lease;
            },
            respond,
          });
          if (!persistedSession) {
            return;
          }
          Object.assign(session, persistedSession);
        }

        const delivery = await resolveAgentDeliveryPhase({
          ...content,
          ...session,
          request,
          cfg,
          cfgForAgent,
          resolvedSessionKey,
          storePath: sessionStorePath,
          resolvedSessionAgentId,
          agentId,
          runId,
          client: principal,
          context,
          respond,
          isWebchatConnect,
          onRunObserved,
        });
        if (!delivery) {
          return;
        }
        const { activeSessionAgentId } = delivery;

        const runParams = {
          ...preflight,
          ...session,
          cfgForAgent,
          freshChild,
          resolvedSessionKey,
          requestedSessionKey,
          activeSessionAgentId,
          delivery,
          lifecycleGeneration,
          images,
          context,
          io,
          client: principal,
        };
        const preparedDispatch = await prepareAgentRunDispatch({
          ...runParams,
          sourceWork: preparationSource.work,
          needsImageUnderstanding: content.needsImageUnderstanding,
          lifecycleStorePath: sessionStorePath ?? `agent:${activeSessionAgentId}`,
          assertAdmissionCurrent: assertRequestCurrent,
          hasCurrentClientAuthority,
          promptedAt,
          requestedSessionKeyRaw,
          preAcceptedReservedSessionKey,
          restoredCronContinuationIdentity,
          getAdmittedSessionId: () => session.admittedSessionId,
          ownerConnId,
          ownerDeviceId,
          message,
          effectiveTranscriptInputText,
          offloadedRefs,
          onUserTurnMediaPersisted: () => {
            preparedOffloadedRefs = [];
          },
          privateCompletion,
          replyExpectation,
          settleWakeReplay,
          acquireGatewayWorkAdmission: admissionController.acquire,
          assertGatewayWorkAdmissionAllowed: admissionController.assertAllowed,
          hasGatewayAdmissionOutcome: admissionController.hasOutcome,
          respondToGatewayAdmissionOutcome: admissionController.respondToOutcome,
          admissionAgentId: admissionController.admissionAgentId,
          getGatewayWorkAdmission: admissionController.getAdmission,
          setAdmittedRunAbort: admissionController.setAdmittedRunAbort,
          getAdmittedRunAbort: admissionController.getAdmittedRunAbort,
          markAgentRunAccepted: (accepted) => {
            if (accepted) {
              sourcePreparationComplete = true;
            }
            dedupeLifecycle.markAccepted(accepted);
          },
          getOwnedAgentDedupeKeys: dedupeLifecycle.ownedReservationKeys,
        });
        if (!preparedDispatch) {
          return;
        }
        session.resolvedSessionId = session.admittedSessionId;
        // The prepared dispatch now owns either transcript-persisted media or its
        // closed unpersisted ref set; admission must not retain a second owner.
        preparedOffloadedRefs = [];
        sourcePreparationComplete = true;
        // Retain the original command and cleanup after the caller receives acceptance.
        void (async () => {
          try {
            await context.trackExecution(() =>
              startAgentRunExecution({
                ...runParams,
                ...session,
                assertContextCurrent,
                executionSource,
                prepared: preparedDispatch,
                mainRestartRecoveryOwnerLease,
                agentId,
                imageOrder,
                media,
                inputProvenance: preparedDispatch.userTurn.inputProvenance,
                effectiveBootstrapContextRunKind,
                releaseCronContinuationClaimWithRecovery: cronContinuation.releaseWithRecovery,
              }),
            );
          } finally {
            await releaseSessionStorage();
          }
        })().catch((error: unknown) => {
          preparedDispatch.releaseCallerAuthority?.();
          context.logGateway.warn(`agent execution cleanup failed: ${String(error)}`);
        });
        preparationSource.transfer();
        gatewayAdmissionTransferred = true;
        mainRestartRecoveryOwnerLease = undefined;
      } catch (error) {
        if (!(error instanceof AgentRequestReservationEndedError)) {
          throw error;
        }
        if (!respondToAdmissionOutcome()) {
          dedupeLifecycle.handlePreparationFailure(assertAdmissionCurrent)(error);
        }
      } finally {
        await finishAgentTurnPreparation({
          transferred: gatewayAdmissionTransferred,
          lease: mainRestartRecoveryOwnerLease,
          cleanupRunAbort: () => earlyRunAbort?.cleanup(),
          releaseGatewayAdmission,
          releaseCronContinuation: cronContinuation.releaseWithRecovery,
          getOffloadedRefs: () => preparedOffloadedRefs,
          clearUnaccepted: dedupeLifecycle.clearUnaccepted,
          settleSourceWork: preparationSource.settle,
        });
      }
    };
    try {
      await (sessionStorage ? runWithSessionActorStorage(sessionStorage, execute) : execute());
    } finally {
      if (!gatewayAdmissionTransferred) {
        await releaseSessionStorage();
      }
    }
  };

  const prepareWaitForTurn = (params: AgentWaitParams) =>
    prepareAgentWaitForTurn(context, params, { exactTurnSource: true });
  const waitForTurn = async (params: AgentWaitParams) => await prepareWaitForTurn(params).wait();

  return { startTurn, prepareWaitForTurn, waitForTurn };
}
