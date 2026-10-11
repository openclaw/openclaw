import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import type { SessionObserverDigest } from "../../packages/gateway-protocol/src/schema/sessions.js";
import {
  AGENT_RUN_TERMINAL_RETRY_GRACE_MS,
  isDefinitiveRunLifecycle,
} from "../agents/agent-run-terminal-outcome.js";
import {
  flushSessionActivityAssistantNote,
  noteSessionActivityEvent,
  terminalHealthFor,
} from "../agents/session-activity-notes.js";
import { resolveUtilityModelRefForAgent } from "../agents/utility-model.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  createSessionObserverAudience,
  createSessionObserverAudienceLifecycle,
} from "./session-observer-audience.js";
import { createSessionObserverCompanionSnapshotReader } from "./session-observer-companion.js";
import { createSessionObserverCompletion } from "./session-observer-completion.js";
import type { SessionObserverEvent, SessionObserverService } from "./session-observer-contract.js";
import { createSessionObserverLifecycle } from "./session-observer-lifecycle.js";
import { createSessionObserverModelSlots } from "./session-observer-model-slots.js";
import {
  createDormantSessionObserverRun,
  defaultCompleteModel,
  defaultPersistDigest,
  defaultPrepareModel,
  defaultReadSession,
  isSameSessionObserverLifecycle,
  markSessionObserverRunSuperseded,
  rememberSessionObserverDisabledRun,
  rememberSessionObserverDormantRun,
  rememberSessionObserverRevisionFloor,
  resolveSessionObserverDigestForLifecycle,
  snapshotSessionObserverRevisionFloor,
} from "./session-observer-model.js";
import type {
  DormantSessionObserverRun,
  SessionObserverDeps,
  SessionObserverRead,
  SessionObserverState,
} from "./session-observer-model.js";
import { createSessionObserverDigestPersister } from "./session-observer-persistence.js";
import { createSessionObserverPreamblePublisher } from "./session-observer-preamble.js";
import { createSessionObserverTerminalPublisher } from "./session-observer-terminal.js";
import {
  createSessionObserverWork,
  type SessionObserverEventSteps,
} from "./session-observer-work.js";
import { resolveSessionSubscriptionKey } from "./session-subscription-keys.js";

const observerLog = createSubsystemLogger("gateway/session-observer");

const MIN_NOTES_PER_DIGEST = 4;
const MIN_DIGEST_INTERVAL_MS = 12_000;
const MAX_DIGESTS_PER_RUN = 40;
const MAX_LIVE_DIGESTS_PER_RUN = MAX_DIGESTS_PER_RUN - 1;
const MAX_CONSECUTIVE_FAILURES = 2;
const FINAL_DIGEST_MIN_RUN_MS = 30_000;
// The Control UI opens at most six live session subscriptions; matching that cap
// prevents background observer calls from outgrowing the surface consuming them.
const MAX_CONCURRENT_MODEL_SESSIONS = 6;

export function createSessionObserver(deps: SessionObserverDeps): SessionObserverService {
  const now = deps.now ?? Date.now;
  const setTimeoutFn = deps.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = deps.clearTimeoutFn ?? clearTimeout;
  const resolveUtilityModelRef = deps.resolveUtilityModelRef ?? resolveUtilityModelRefForAgent;
  const prepareModel = deps.prepareModel ?? defaultPrepareModel;
  const completeModel = deps.completeModel ?? defaultCompleteModel;
  const resolveStorePath = (agentId: string) =>
    resolveSessionStorePathCore(deps.getConfig().session?.store, { agentId });
  const readSession: NonNullable<SessionObserverDeps["readSession"]> =
    deps.readSession ??
    ((sessionKey, agentId) => defaultReadSession(sessionKey, agentId, resolveStorePath(agentId)));
  const persistDigest: NonNullable<SessionObserverDeps["persistDigest"]> = (params) =>
    params.reader
      ? params.reader.persist(params)
      : (
          deps.persistDigest ??
          ((input) =>
            defaultPersistDigest({ ...input, storePath: resolveStorePath(input.agentId) }))
        )(params);
  const contextlessTerminalRuns = new Map<string, number>();
  const terminalRuns = new Map<string, number>();
  const pendingTerminalErrors = new Map<string, ReturnType<typeof setTimeout>>();
  const visibleConnections = new Set<string>();
  const clearPendingTerminalError = (runId: string) => {
    clearTimeoutFn(pendingTerminalErrors.get(runId));
    pendingTerminalErrors.delete(runId);
  };
  const lifecycle = createSessionObserverLifecycle({
    getConfig: deps.getConfig,
    readSession,
    refreshAfterReset: (sessionKey, agentId, consume) =>
      work.refreshAfterReset(sessionKey, agentId, consume),
    now,
    isTerminal: (runId) => terminalRuns.has(runId),
    clearPendingTerminalError,
    releaseState: (state) => {
      preamblePublisher.clear(state);
      if (state.timer) {
        clearTimeoutFn(state.timer);
      }
      modelSlots.invalidateRequest(state);
    },
  });
  const { states, dormantRuns, revisionFloors, supersededRuns, disabledRuns } = lifecycle;
  const companionReader = createSessionObserverCompanionSnapshotReader({
    getConfig: deps.getConfig,
    readSession,
    states,
    retireObsolete: lifecycle.retireObsolete,
  });
  const work = createSessionObserverWork({
    deps,
    readSession,
    companionReader,
    handleEventSteps,
    canPublish: (state, session) =>
      audienceLifecycle.stateIsCurrent(state) && lifecycle.acceptPublication(state, session),
    beginClose: () => {
      pendingTerminalErrors.forEach((_timer, runId) => clearPendingTerminalError(runId));
      preamblePublisher.dispose();
      audienceLifecycle.unsubscribe();
      for (const state of states.values()) {
        clearTimeoutFn(state.timer);
        modelSlots.invalidateRequest(state);
      }
    },
    finishClose: () => {
      lifecycle.dispose();
      terminalRuns.clear();
      contextlessTerminalRuns.clear();
      visibleConnections.clear();
    },
    reportError: (error) =>
      observerLog.warn("session observer work failed", { error: formatErrorMessage(error) }),
  });
  const audience = createSessionObserverAudience({
    subscribers: deps.subscribers,
    sessionEventSubscribers: deps.sessionEventSubscribers,
    isVisible: (connId) => visibleConnections.has(connId),
    getConfig: deps.getConfig,
  });
  type ObservedAudience = ReturnType<typeof audience.classify>;
  const broadcastDigest = (
    digest: SessionObserverDigest,
    connIds: ReadonlySet<string>,
    agentId: string,
  ) =>
    deps.broadcastToConnIds(
      "session.observer",
      digest,
      connIds,
      audience.deliveryOptions(digest.sessionKey, agentId),
    );
  // Narrow run-identity guard shared by persist paths: a digest may still land
  // while its session is unwatched, but never after a newer run replaces it.
  const runStillCurrent = (runId: string, sessionKey: string, agentId: string) => () =>
    !work.disposed &&
    !supersededRuns.has(runId) &&
    (states.get(resolveSessionSubscriptionKey(sessionKey, agentId))?.runId ?? runId) === runId;

  const persistAcceptedDigest = createSessionObserverDigestPersister({
    now,
    persistDigest,
    stillCurrent: runStillCurrent,
    onMissingEntry: (state) => {
      // An unpersistable session must not re-bill the utility model every cycle.
      disableModelForRun(state);
    },
    // JSON logging drops Error's non-enumerable fields; format before serializing.
    onError: (state, error) =>
      observerLog.warn("session observer digest persistence failed", {
        sessionKey: state.sessionKey,
        runId: state.runId,
        error: formatErrorMessage(error),
      }),
  });
  const preamblePublisher = createSessionObserverPreamblePublisher({
    now,
    setTimeoutFn,
    clearTimeoutFn,
    isCurrent: (state) => audienceLifecycle.stateIsCurrent(state),
    preparePublication: work.preparePublication,
    publish: (state, digest) => {
      broadcastDigest(digest, audience.recipients(state.sessionKey, state.agentId), state.agentId);
      work.background(() => persistAcceptedDigest(state, digest, false, "preamble"));
    },
  });

  const synthesizeTerminalDigest = createSessionObserverTerminalPublisher({
    dormantRuns,
    readSession,
    persistDigest,
    now,
    work,
    runStillCurrent,
    broadcast: (digest, agentId) =>
      broadcastDigest(digest, audience.recipients(digest.sessionKey, agentId), agentId),
    onError: (runId, error) =>
      observerLog.warn("session observer terminal digest synthesis failed", {
        runId,
        error: formatErrorMessage(error),
      }),
  });

  const retireTerminalState = (state: SessionObserverState) => {
    work.background(() => synthesizeTerminalDigest({ state }));
    dormantRuns.delete(state.runId);
    lifecycle.dropState(state);
  };

  const suspendState = (state: SessionObserverState) => {
    if (state.terminalHealth) {
      retireTerminalState(state);
      return;
    }
    rememberSessionObserverDormantRun(
      dormantRuns,
      revisionFloors,
      createDormantSessionObserverRun(state),
    );
    lifecycle.dropState(state);
  };
  const retireInactiveState = (state: SessionObserverState) =>
    (work.disposed || supersededRuns.has(state.runId) ? lifecycle.dropState : suspendState)(state);

  const demoteUtilityModel = (state: SessionObserverState): void => {
    if (state.timer) {
      clearTimeoutFn(state.timer);
      state.timer = undefined;
    }
    modelSlots.invalidateRequest(state);
    state.preparedPromise = undefined;
    state.utilityModelRef = undefined;
    state.consecutiveFailures = 0;
  };
  const modelSlots = createSessionObserverModelSlots({
    states,
    maxSessions: MAX_CONCURRENT_MODEL_SESSIONS,
    resolve: (agentId) => resolveUtilityModelRef({ cfg: deps.getConfig(), agentId }),
    demote: demoteUtilityModel,
  });

  const disableModelForRun = (state: SessionObserverState) => {
    rememberSessionObserverDisabledRun(disabledRuns, state.runId);
    demoteUtilityModel(state);
  };

  const audienceLifecycle = createSessionObserverAudienceLifecycle({
    audience,
    states,
    subscribers: deps.subscribers,
    isCurrent: (state) =>
      !work.closing &&
      !work.disposed &&
      !work.resetting.has(resolveSessionSubscriptionKey(state.sessionKey, state.agentId)) &&
      lifecycle.isTracked(state) &&
      deps.getConfig().gateway?.controlUi?.sessionObserver !== false,
    resolveUtilityModelRef: (agentId) => resolveUtilityModelRef({ cfg: deps.getConfig(), agentId }),
    suspend: suspendState,
    demote: demoteUtilityModel,
  });

  const { modelStateIsCurrent } = audienceLifecycle;

  const requestModelDigest = createSessionObserverCompletion({
    getConfig: deps.getConfig,
    prepareModel,
    completeModel,
    setTimeoutFn,
    clearTimeoutFn,
    isCurrent: modelStateIsCurrent,
  });

  const schedule = (state: SessionObserverState, observedAudience?: ObservedAudience) => {
    const currentAudience = observedAudience ?? audience.classify(state.sessionKey, state.agentId);
    if (!audienceLifecycle.stateIsCurrent(state, currentAudience)) {
      retireInactiveState(state);
      return;
    }
    if (
      !modelStateIsCurrent(state, currentAudience) ||
      state.inFlight ||
      state.timer ||
      state.terminalHealth ||
      state.digestCount >= MAX_LIVE_DIGESTS_PER_RUN ||
      // Notes stay sequence-ordered even when the bounded buffer drops its oldest entries.
      (state.notes.at(-MIN_NOTES_PER_DIGEST)?.sequence ?? 0) <= state.lastDigestNoteSequence
    ) {
      return;
    }
    const delay = Math.max(0, MIN_DIGEST_INTERVAL_MS - (now() - state.lastRunAt));
    if (delay === 0) {
      runDigest(state, false);
      return;
    }
    state.timer = setTimeoutFn(() => {
      state.timer = undefined;
      runDigest(state, false);
    }, delay);
  };

  const runDigest = (state: SessionObserverState, final: boolean) => {
    const currentAudience = audience.classify(state.sessionKey, state.agentId);
    if (!audienceLifecycle.stateIsCurrent(state, currentAudience)) {
      retireInactiveState(state);
      return;
    }
    if (!modelStateIsCurrent(state, currentAudience)) {
      if (final) {
        retireTerminalState(state);
      }
      return;
    }
    if (state.inFlight) {
      state.finalPending ||= final;
      return;
    }
    const digestLimit = final ? MAX_DIGESTS_PER_RUN : MAX_LIVE_DIGESTS_PER_RUN;
    if (state.digestCount >= digestLimit) {
      return;
    }
    flushSessionActivityAssistantNote(state);
    const selectedNotes = state.notes.filter(
      (note) => note.sequence > state.lastDigestNoteSequence,
    );
    if (!final && selectedNotes.length < MIN_NOTES_PER_DIGEST) {
      return;
    }
    if (!final && now() - state.lastRunAt < MIN_DIGEST_INTERVAL_MS) {
      schedule(state);
      return;
    }
    if (state.timer) {
      clearTimeoutFn(state.timer);
      state.timer = undefined;
    }
    state.inFlight = true;
    state.lastRunAt = now();
    const lastSelectedSequence = selectedNotes.at(-1)?.sequence ?? state.lastDigestNoteSequence;
    const retireSelectedNotes = () => {
      // Run rollover replaces state; inFlight keeps its note retirement monotonic.
      state.lastDigestNoteSequence = Math.max(state.lastDigestNoteSequence, lastSelectedSequence);
    };
    const requestGeneration = modelSlots.beginRequest(state);
    const digestIsStale = () =>
      !modelStateIsCurrent(state) ||
      !modelSlots.requestIsCurrent(state, requestGeneration) ||
      (!final && state.terminalHealth !== undefined);
    const acceptDigestPublication = (session: ReturnType<typeof readSession>) => {
      if (digestIsStale()) {
        retireSelectedNotes();
        if (final && lifecycle.isTracked(state)) {
          retireTerminalState(state);
        }
        return false;
      }
      return lifecycle.acceptPublication(state, session);
    };
    state.digestCount += 1;
    work.background(async () => {
      try {
        const modelDigest = await requestModelDigest(
          state,
          selectedNotes.map((note) => note.text),
        );
        const acceptedDigest = await work.withCurrent(
          state.reader,
          state.sessionKey,
          state.agentId,
          (session) => {
            if (!acceptDigestPublication(session)) {
              return undefined;
            }
            preamblePublisher.clear(state);
            state.consecutiveFailures = 0;
            state.revision += 1;
            retireSelectedNotes();
            const digest: SessionObserverDigest = {
              sessionKey: state.sessionKey,
              agentId: state.agentId,
              ...(state.sessionId ? { sessionId: state.sessionId } : {}),
              ...(state.lifecycleRevision ? { lifecycleRevision: state.lifecycleRevision } : {}),
              runId: state.runId,
              revision: state.revision,
              updatedAt: now(),
              headline: modelDigest.headline,
              ...(modelDigest.assessment ? { assessment: modelDigest.assessment } : {}),
              health: final ? (state.terminalHealth ?? modelDigest.health) : modelDigest.health,
              ...((state.planProgress ?? modelDigest.planProgress)
                ? { planProgress: state.planProgress ?? modelDigest.planProgress }
                : {}),
            };
            const previous = state.previousDigest?.health;
            const next = digest.health;
            const criticalTransition =
              (next === "stuck" || next === "waiting-on-user") && previous !== next;
            state.previousDigest = digest;
            // The existing gateway.controlUi.sessionObserver=false gate prevents this
            // run entirely, so the wider critical announce inherits the same opt-out.
            const recipients = criticalTransition
              ? audience.criticalRecipients(state.sessionKey, state.agentId)
              : audience.recipients(state.sessionKey, state.agentId);
            broadcastDigest(digest, recipients, state.agentId);
            return digest;
          },
        );
        if (!acceptedDigest) {
          return;
        }
        await persistAcceptedDigest(state, acceptedDigest, final);
        if (final) {
          dormantRuns.delete(state.runId);
        }
      } catch (error) {
        await work.withCurrent(state.reader, state.sessionKey, state.agentId, (session) => {
          if (!acceptDigestPublication(session)) {
            return;
          }
          state.consecutiveFailures += 1;
          if (state.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            observerLog.warn("session observer disabled after consecutive failures", {
              sessionKey: state.sessionKey,
              runId: state.runId,
              consecutiveFailures: state.consecutiveFailures,
              error: formatErrorMessage(error),
            });
            if (final || state.finalPending || state.terminalHealth) {
              retireTerminalState(state);
            } else {
              disableModelForRun(state);
            }
          } else if (final) {
            state.finalPending = true;
          }
        });
      } finally {
        if (lifecycle.isTracked(state)) {
          state.inFlight = false;
          const runFinal = state.finalPending;
          state.finalPending = false;
          if (runFinal) {
            runDigest(state, true);
          } else if (final) {
            lifecycle.dropState(state);
          } else {
            schedule(state);
          }
        }
      }
    });
  };

  function* handleEventSteps(
    event: SessionObserverEvent,
    settledError = false,
    capturedReader?: SessionObserverRead,
  ): SessionObserverEventSteps {
    let reader = capturedReader;
    if (work.disposed) {
      return;
    }
    const lifecyclePhase = event.stream === "lifecycle" ? event.data.phase : undefined;
    const terminal =
      settledError || isDefinitiveRunLifecycle({ phase: lifecyclePhase, data: event.data });
    if (lifecyclePhase === "error" && !terminal) {
      clearPendingTerminalError(event.runId);
      const timer = setTimeoutFn(() => {
        if (reader) {
          work.background(() => work.handleEventAsync(event, true, reader));
        } else {
          work.handleEvent(event, true);
        }
      }, AGENT_RUN_TERMINAL_RETRY_GRACE_MS);
      pendingTerminalErrors.set(event.runId, timer);
      return;
    }
    if (terminal || lifecyclePhase === "start") {
      clearPendingTerminalError(event.runId);
    }
    if (terminalRuns.has(event.runId)) {
      return;
    }
    if (supersededRuns.has(event.runId)) {
      if (terminal) {
        markSessionObserverRunSuperseded(terminalRuns, event.runId, event.ts);
        contextlessTerminalRuns.delete(event.runId);
        supersededRuns.delete(event.runId);
        dormantRuns.delete(event.runId);
        disabledRuns.delete(event.runId);
      }
      return;
    }
    // A terminal with no recoverable run context still closes the live run, but
    // one routed terminal duplicate must pass later to finalize durable state.
    if (contextlessTerminalRuns.has(event.runId) && !terminal) {
      return;
    }
    const eventSessionKey = event.sessionKey?.trim();
    const eventAgentId = event.agentId?.trim();
    let knownRun: SessionObserverState | DormantSessionObserverRun | undefined;
    // Context-reduced terminals may omit either routing field. Recover their
    // tracked owner by run id before the agent-scoped fail-closed branch.
    if (terminal && (!eventSessionKey || !eventAgentId)) {
      for (const candidate of states.values()) {
        if (candidate.runId === event.runId) {
          knownRun = candidate;
          break;
        }
      }
      knownRun ??= dormantRuns.get(event.runId);
    }
    const sessionKey = eventSessionKey || knownRun?.sessionKey;
    if (!sessionKey) {
      if (terminal) {
        markSessionObserverRunSuperseded(contextlessTerminalRuns, event.runId, event.ts);
      }
      return;
    }
    const agentId = eventAgentId || knownRun?.agentId;
    reader ??= knownRun?.reader;
    if (terminal) {
      contextlessTerminalRuns.delete(event.runId);
      if (!settledError) {
        markSessionObserverRunSuperseded(terminalRuns, event.runId, event.ts);
      }
    }
    const isPreamble = event.stream === "item" && event.data.kind === "preamble";
    if (!agentId) {
      if (terminal) {
        work.background(() => synthesizeTerminalDigest({ event, reader }));
        dormantRuns.delete(event.runId);
        disabledRuns.delete(event.runId);
      }
      return;
    }
    const currentAudience = audience.classify(sessionKey, agentId);
    const scopeKey = resolveSessionSubscriptionKey(sessionKey, agentId);
    if (terminal && audience.recipients(sessionKey, agentId).size === 0) {
      work.background(() =>
        synthesizeTerminalDigest({ event, state: states.get(scopeKey), reader }),
      );
      dormantRuns.delete(event.runId);
      disabledRuns.delete(event.runId);
      return;
    }
    const isRunStart = event.stream === "lifecycle" && event.data.phase === "start";
    let state = states.get(scopeKey);
    let session: ReturnType<typeof readSession> = undefined;
    let admittedModelRef: string | undefined;
    let canAdmit = false;
    if (!state || state.runId !== event.runId) {
      const observesSession =
        currentAudience !== "none" &&
        deps.getConfig().gateway?.controlUi?.sessionObserver !== false;
      admittedModelRef =
        observesSession && currentAudience === "direct" && !disabledRuns.has(event.runId)
          ? modelSlots.claim(agentId, state)
          : undefined;
      canAdmit = observesSession && (admittedModelRef !== undefined || isPreamble);
      if (canAdmit || isRunStart) {
        session = yield { sessionKey, agentId, reader };
        // Select revision history only after removing obsolete lifecycle owners.
        // Tool/text events do not read the store unless they admit an observer state.
        lifecycle.retireObsolete(scopeKey, session);
        if (
          !session ||
          (event.sessionId !== undefined && event.sessionId !== session.sessionId) ||
          supersededRuns.has(event.runId)
        ) {
          return;
        }
        state = states.get(scopeKey);
      }
    }
    let revisionFloor = revisionFloors.get(scopeKey);
    if (state && state.runId !== event.runId) {
      const candidate = snapshotSessionObserverRevisionFloor(state);
      if (!revisionFloor || candidate.revision > revisionFloor.revision) {
        revisionFloor = candidate;
      }
      const supersededRunId = state.runId;
      clearPendingTerminalError(supersededRunId);
      if (isRunStart) {
        markSessionObserverRunSuperseded(supersededRuns, supersededRunId, event.ts);
      }
      suspendState(state);
      if (isRunStart) {
        dormantRuns.delete(supersededRunId);
      }
      state = undefined;
    }
    if (!state) {
      const superseded = [...dormantRuns.values()]
        .filter(
          (run) =>
            resolveSessionSubscriptionKey(run.sessionKey, run.agentId) === scopeKey &&
            isSameSessionObserverLifecycle(run, session) &&
            run.runId !== event.runId,
        )
        .toSorted(
          (left, right) => right.revision - left.revision || left.runId.localeCompare(right.runId),
        );
      const latest = superseded[0];
      if (latest && (!revisionFloor || latest.revision > revisionFloor.revision)) {
        revisionFloor = snapshotSessionObserverRevisionFloor(latest);
      }
      if (isRunStart) {
        if (revisionFloor) {
          rememberSessionObserverRevisionFloor(revisionFloors, scopeKey, revisionFloor);
          const previousRunId = revisionFloor.previousDigest?.runId;
          if (previousRunId && previousRunId !== event.runId) {
            markSessionObserverRunSuperseded(supersededRuns, previousRunId, event.ts);
          }
        }
        for (const run of superseded) {
          markSessionObserverRunSuperseded(supersededRuns, run.runId, event.ts);
          clearPendingTerminalError(run.runId);
          dormantRuns.delete(run.runId);
        }
      }
    }
    if (
      state &&
      (currentAudience === "none" || deps.getConfig().gateway?.controlUi?.sessionObserver === false)
    ) {
      suspendState(state);
      state = undefined;
    }
    if (!state && canAdmit) {
      state = lifecycle.admit(event, sessionKey, agentId, session, admittedModelRef);
      state.reader = reader;
    }
    if (!state) {
      if (terminal) {
        work.background(() => synthesizeTerminalDigest({ event, reader }));
        dormantRuns.delete(event.runId);
        disabledRuns.delete(event.runId);
      }
      return;
    }
    if (state.terminalHealth) {
      return;
    }
    if (
      revisionFloor &&
      isSameSessionObserverLifecycle(revisionFloor, state) &&
      revisionFloor.revision > state.revision
    ) {
      state.revision = revisionFloor.revision;
      state.previousDigest = resolveSessionObserverDigestForLifecycle(
        revisionFloor.previousDigest,
        state,
      );
    }
    revisionFloors.delete(scopeKey);
    const utilityModelRef =
      disabledRuns.has(state.runId) || currentAudience !== "direct"
        ? undefined
        : modelSlots.claim(state.agentId, state);
    if (state.utilityModelRef !== utilityModelRef) {
      modelSlots.invalidateRequest(state);
      state.preparedPromise = undefined;
      state.utilityModelRef = utilityModelRef;
      state.consecutiveFailures = 0;
    }
    state.lastActivityAt = event.ts;
    const eventStartedAt = asFiniteNumber(event.data.startedAt);
    if (eventStartedAt !== undefined) {
      state.startedAt = Math.min(state.startedAt, eventStartedAt);
    }
    noteSessionActivityEvent(state, event);
    const preamble = preamblePublisher.handle(state, event);
    if (typeof preamble === "object") {
      yield { work: preamble };
    }
    if (terminal) {
      if (!state.terminalHealth) {
        modelSlots.invalidateRequest(state);
      }
      const flush = preamblePublisher.flush(state);
      if (flush) {
        yield { work: flush };
      }
      preamblePublisher.clear(state);
      state.terminalHealth = terminalHealthFor(event);
      disabledRuns.delete(event.runId);
      const endedAt = asFiniteNumber(event.data.endedAt) ?? now();
      // previousDigest is set on every ACCEPTED digest of this run; digestCount now
      // counts attempts (budget), so it no longer implies any digest was published.
      const hasRunDigest = state.previousDigest?.runId === state.runId;
      if (!hasRunDigest && endedAt - state.startedAt < FINAL_DIGEST_MIN_RUN_MS) {
        dormantRuns.delete(state.runId);
        lifecycle.dropState(state);
        return;
      }
      runDigest(state, true);
      return;
    }
    schedule(state, currentAudience);
  }

  return {
    handleEvent: work.handleEvent,
    handleEventAsync: work.handleEventAsync,
    setConnectionVisibility(connId, visible) {
      if (visible) {
        visibleConnections.add(connId);
        return;
      }
      visibleConnections.delete(connId);
      audienceLifecycle.reconcileAll();
    },
    removeConnection(connId) {
      if (visibleConnections.delete(connId)) {
        audienceLifecycle.reconcileAll();
      }
    },
    getCompanionSnapshot: companionReader.readSync,
    getCompanionSnapshotAsync: work.getCompanionSnapshotAsync,
    dispose: work.dispose,
    disposeAsync: work.disposeAsync,
  };
}
