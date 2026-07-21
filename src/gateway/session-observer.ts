import type {
  SessionObserverDigest,
  SessionsObserverAskResult,
} from "../../packages/gateway-protocol/src/schema/sessions.js";
import { resolveSessionAgentId } from "../agents/agent-scope.js";
import { resolveUtilityModelRefForAgent } from "../agents/utility-model.js";
import { getAgentRunContext, type AgentEventPayload } from "../infra/agent-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  buildSessionObserverAskPrompt,
  buildSessionObserverPrompt,
  createDormantSessionObserverRun,
  defaultCompleteModel,
  defaultPersistDigest,
  defaultPrepareModel,
  defaultReadSession,
  isTerminalLifecycleEvent,
  markSessionObserverRunSuperseded,
  normalizeSessionObserverModelOutput,
  readFiniteNumber,
  rememberSessionObserverDisabledRun,
  rememberSessionObserverDormantRun,
  rememberSessionObserverItemStatus,
  rememberSessionObserverRevisionFloor,
  sanitizeSessionObserverModelText,
  SESSION_OBSERVER_ASK_ANSWER_MAX_CHARS,
  SESSION_OBSERVER_ASK_MODEL_MAX_TOKENS,
  SESSION_OBSERVER_ASK_SYSTEM_PROMPT,
  SESSION_OBSERVER_MODEL_MAX_TOKENS,
  SESSION_OBSERVER_SYSTEM_PROMPT,
  synthesizeSessionObserverTerminalDigest,
  terminalHealthFor,
} from "./session-observer-model.js";
import type {
  DormantSessionObserverRun,
  PreparedModel,
  SessionObserverDeps,
  SessionObserverRevisionFloor,
  SessionObserverState,
} from "./session-observer-model.js";
import {
  flushSessionObserverAssistantNote,
  noteSessionObserverEvent,
} from "./session-observer-notes.js";

const observerLog = createSubsystemLogger("gateway/session-observer");

const MIN_NOTES_PER_DIGEST = 4;
const MIN_DIGEST_INTERVAL_MS = 12_000;
const MODEL_TIMEOUT_MS = 10_000;
const MAX_DIGESTS_PER_RUN = 40;
const MAX_LIVE_DIGESTS_PER_RUN = MAX_DIGESTS_PER_RUN - 1;
const MAX_CONSECUTIVE_FAILURES = 2;
const MAX_ITEM_STATUSES = 160;
const FINAL_DIGEST_MIN_RUN_MS = 30_000;
const PERSIST_INTERVAL_MS = 60_000;
// The Control UI opens at most six live session subscriptions; matching that cap
// prevents background observer calls from outgrowing the surface consuming them.
const MAX_CONCURRENT_OBSERVED_SESSIONS = 6;
const MAX_CONCURRENT_ASKS = 6;
const ASK_RATE_WINDOW_MS = 60_000;
const MAX_ASKS_PER_RATE_WINDOW = 12;
const MAX_ASKS_PER_CONNECTION_RATE_WINDOW = 4;

type SessionObserverSnapshot = {
  agentId: string;
  runId?: string;
  digest?: SessionObserverDigest;
  notes: string[];
};

type SessionObserverAskErrorReason =
  | "busy"
  | "disabled"
  | "not-subscribed"
  | "rate-limited"
  | "utility-model-unavailable"
  | "model-unavailable";

export class SessionObserverAskError extends Error {
  constructor(
    readonly reason: SessionObserverAskErrorReason,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "SessionObserverAskError";
  }
}

export type SessionObserverService = {
  handleEvent: (event: AgentEventPayload) => void;
  getSnapshot: (sessionKey: string) => SessionObserverSnapshot;
  ask: (params: {
    sessionKey: string;
    question: string;
    connId: string;
  }) => Promise<SessionsObserverAskResult>;
  dispose: () => void;
};

export function createSessionObserver(deps: SessionObserverDeps): SessionObserverService {
  const now = deps.now ?? Date.now;
  const setTimeoutFn = deps.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = deps.clearTimeoutFn ?? clearTimeout;
  const resolveUtilityModelRef = deps.resolveUtilityModelRef ?? resolveUtilityModelRefForAgent;
  const prepareModel = deps.prepareModel ?? defaultPrepareModel;
  const completeModel = deps.completeModel ?? defaultCompleteModel;
  const readSession = deps.readSession ?? defaultReadSession;
  const persistDigest = deps.persistDigest ?? defaultPersistDigest;
  const states = new Map<string, SessionObserverState>();
  const dormantRuns = new Map<string, DormantSessionObserverRun>();
  const revisionFloors = new Map<string, SessionObserverRevisionFloor>();
  const supersededRuns = new Map<string, number>();
  const disabledRuns = new Set<string>();
  const askControllers = new Map<string, AbortController>();
  const askAdmissions: Array<{ connId: string; admittedAt: number }> = [];
  let disposed = false;

  // Narrow run-identity guard shared by persist paths: a digest may still land
  // while its session is unwatched, but never after a newer run replaces it.
  const runStillCurrent = (runId: string, sessionKey: string) => () =>
    !disposed && !supersededRuns.has(runId) && (states.get(sessionKey)?.runId ?? runId) === runId;

  // Terminal paths that cannot run the model must still retire same-run live
  // health, or idle session rows can display a stale in-progress judgment forever.
  async function synthesizeTerminalDigest(source: {
    event?: AgentEventPayload;
    state?: SessionObserverState;
  }) {
    const runId = source.event?.runId ?? source.state?.runId;
    if (!runId) {
      return;
    }
    const dormant = dormantRuns.get(runId);
    const sessionKey = source.event?.sessionKey ?? source.state?.sessionKey ?? dormant?.sessionKey;
    if (!sessionKey) {
      return;
    }
    const stillCurrent = runStillCurrent(runId, sessionKey);
    if (!stillCurrent()) {
      return;
    }
    try {
      const digest = await synthesizeSessionObserverTerminalDigest({
        source,
        dormant,
        readSession,
        persistDigest,
        now,
        stillCurrent,
      });
      if (digest && stillCurrent()) {
        // Live subscribers already saw the in-progress digest over this event;
        // the synthesized terminal correction must reach them the same way.
        deps.broadcastToConnIds(
          "session.observer",
          digest,
          deps.subscribers.get(digest.sessionKey),
          {
            dropIfSlow: true,
          },
        );
      }
    } catch (error) {
      observerLog.warn("session observer terminal digest synthesis failed", { runId, error });
    }
  }

  const dropState = (state: SessionObserverState) => {
    if (state.timer) {
      clearTimeoutFn(state.timer);
      state.timer = undefined;
    }
    state.activeController?.abort();
    state.activeController = undefined;
    if (states.get(state.sessionKey) === state) {
      states.delete(state.sessionKey);
    }
  };

  const suspendState = (state: SessionObserverState) => {
    if (state.terminalHealth) {
      void synthesizeTerminalDigest({ state });
      dormantRuns.delete(state.runId);
      dropState(state);
      return;
    }
    rememberSessionObserverDormantRun(
      dormantRuns,
      revisionFloors,
      createDormantSessionObserverRun(state),
    );
    dropState(state);
  };

  const disableRun = (state: SessionObserverState) => {
    rememberSessionObserverDisabledRun(disabledRuns, state.runId);
    rememberSessionObserverDormantRun(
      dormantRuns,
      revisionFloors,
      createDormantSessionObserverRun(state),
    );
    dropState(state);
  };

  const hasSubscribers = (sessionKey: string) => deps.subscribers.get(sessionKey).size > 0;

  const markSuperseded = (runId: string, observedAt: number) =>
    markSessionObserverRunSuperseded(supersededRuns, runId, observedAt);

  const unsubscribeChanges = deps.subscribers.onChange((sessionKey) => {
    const state = states.get(sessionKey);
    if (state && !hasSubscribers(sessionKey)) {
      suspendState(state);
    }
  });

  const stateIsCurrent = (state: SessionObserverState) => {
    if (disposed || states.get(state.sessionKey) !== state || !hasSubscribers(state.sessionKey)) {
      return false;
    }
    const cfg = deps.getConfig();
    if (cfg.gateway?.controlUi?.sessionObserver === false) {
      return false;
    }
    return resolveUtilityModelRef({ cfg, agentId: state.agentId }) === state.utilityModelRef;
  };

  const rememberItemStatus = (state: SessionObserverState, itemId: string, status: string) =>
    rememberSessionObserverItemStatus(state.itemStatuses, itemId, status, MAX_ITEM_STATUSES);

  const ensurePrepared = async (state: SessionObserverState): Promise<PreparedModel> => {
    state.preparedPromise ??= prepareModel({
      cfg: deps.getConfig(),
      agentId: state.agentId,
      modelRef: state.utilityModelRef,
      useUtilityModel: true,
      useAsyncModelResolution: true,
      allowMissingApiKeyModes: ["aws-sdk"],
    });
    return await state.preparedPromise;
  };

  const getSnapshot = (sessionKey: string): SessionObserverSnapshot => {
    const state = states.get(sessionKey);
    if (state) {
      flushSessionObserverAssistantNote(state);
      return {
        agentId: state.agentId,
        runId: state.runId,
        ...(state.previousDigest ? { digest: state.previousDigest } : {}),
        // These strings were bounded and sanitized when they entered the note
        // buffer. Copy them verbatim so asks never reopen raw transcript data.
        notes: state.notes.map((note) => note.text),
      };
    }
    const cfg = deps.getConfig();
    const agentId = resolveSessionAgentId({ sessionKey, config: cfg });
    const digest = readSession(sessionKey, agentId)?.observerDigest;
    return {
      agentId,
      ...(digest?.runId ? { runId: digest.runId } : {}),
      ...(digest ? { digest } : {}),
      notes: [],
    };
  };

  const ask = async (params: {
    sessionKey: string;
    question: string;
    connId: string;
  }): Promise<SessionsObserverAskResult> => {
    const sessionKey = params.sessionKey.trim();
    const question = params.question.trim();
    if (!sessionKey || !question || disposed) {
      throw new SessionObserverAskError("model-unavailable", "Session observer is unavailable.");
    }
    if (!deps.subscribers.get(sessionKey).has(params.connId)) {
      throw new SessionObserverAskError(
        "not-subscribed",
        "Subscribe to this session before asking its observer.",
      );
    }
    const cfg = deps.getConfig();
    if (cfg.gateway?.controlUi?.sessionObserver === false) {
      throw new SessionObserverAskError("disabled", "Session observer is disabled.");
    }
    if (askControllers.has(sessionKey)) {
      throw new SessionObserverAskError(
        "busy",
        "The session observer is answering another question.",
      );
    }
    const admittedAt = now();
    const cutoff = admittedAt - ASK_RATE_WINDOW_MS;
    while ((askAdmissions[0]?.admittedAt ?? admittedAt) < cutoff) {
      askAdmissions.shift();
    }
    const connectionAdmissions = askAdmissions.filter(
      (admission) => admission.connId === params.connId,
    );
    const globalRetryAfterMs =
      askAdmissions.length >= MAX_ASKS_PER_RATE_WINDOW
        ? Math.max(
            1,
            (askAdmissions[0]?.admittedAt ?? admittedAt) + ASK_RATE_WINDOW_MS - admittedAt,
          )
        : 0;
    const connectionRetryAfterMs =
      connectionAdmissions.length >= MAX_ASKS_PER_CONNECTION_RATE_WINDOW
        ? Math.max(
            1,
            (connectionAdmissions[0]?.admittedAt ?? admittedAt) + ASK_RATE_WINDOW_MS - admittedAt,
          )
        : 0;
    if (
      askControllers.size >= MAX_CONCURRENT_ASKS ||
      globalRetryAfterMs > 0 ||
      connectionRetryAfterMs > 0
    ) {
      throw new SessionObserverAskError(
        "rate-limited",
        "The session observer has reached its question limit. Try again shortly.",
        Math.max(
          askControllers.size >= MAX_CONCURRENT_ASKS ? MODEL_TIMEOUT_MS : 0,
          globalRetryAfterMs,
          connectionRetryAfterMs,
        ),
      );
    }
    const snapshot = getSnapshot(sessionKey);
    const utilityModelRef = resolveUtilityModelRef({ cfg, agentId: snapshot.agentId });
    if (!utilityModelRef) {
      throw new SessionObserverAskError(
        "utility-model-unavailable",
        "No utility model is configured for this session.",
      );
    }
    // Read-scoped asks can spend utility-model quota. Bound admission across
    // sessions and connections before any provider-backed preparation starts.
    askAdmissions.push({ connId: params.connId, admittedAt });
    const controller = new AbortController();
    askControllers.set(sessionKey, controller);
    const timeout = setTimeoutFn(() => controller.abort(), MODEL_TIMEOUT_MS);
    const aborted = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener(
        "abort",
        () => reject(new Error("session observer ask timed out or was cancelled")),
        { once: true },
      );
    });
    try {
      const execute = async () => {
        const prepared = await prepareModel({
          cfg,
          agentId: snapshot.agentId,
          modelRef: utilityModelRef,
          useUtilityModel: true,
          useAsyncModelResolution: true,
          allowMissingApiKeyModes: ["aws-sdk"],
        });
        if (controller.signal.aborted || disposed) {
          throw new Error("session observer ask is no longer active");
        }
        const currentCfg = deps.getConfig();
        if (
          currentCfg.gateway?.controlUi?.sessionObserver === false ||
          resolveUtilityModelRef({ cfg: currentCfg, agentId: snapshot.agentId }) !== utilityModelRef
        ) {
          throw new Error("session observer utility model changed while answering");
        }
        if ("error" in prepared) {
          throw new Error(prepared.error);
        }
        const result = await completeModel({
          model: prepared.model,
          auth: prepared.auth,
          cfg: currentCfg,
          context: {
            systemPrompt: SESSION_OBSERVER_ASK_SYSTEM_PROMPT,
            messages: [
              {
                role: "user",
                content: buildSessionObserverAskPrompt({
                  digest: snapshot.digest,
                  notes: snapshot.notes,
                  question,
                }),
                timestamp: now(),
              },
            ],
          },
          options: {
            maxTokens: Math.min(
              SESSION_OBSERVER_ASK_MODEL_MAX_TOKENS,
              Math.floor(prepared.model.maxTokens),
            ),
            temperature: 0.2,
            signal: controller.signal,
          },
        });
        if (result.stopReason === "error") {
          throw new Error(result.errorMessage?.trim() || "session observer ask completion failed");
        }
        const finalCfg = deps.getConfig();
        const currentSnapshot = getSnapshot(sessionKey);
        if (
          controller.signal.aborted ||
          disposed ||
          !deps.subscribers.get(sessionKey).has(params.connId) ||
          finalCfg.gateway?.controlUi?.sessionObserver === false ||
          resolveUtilityModelRef({ cfg: finalCfg, agentId: snapshot.agentId }) !==
            utilityModelRef ||
          currentSnapshot.runId !== snapshot.runId ||
          currentSnapshot.digest?.revision !== snapshot.digest?.revision
        ) {
          throw new Error("session observer ask is no longer authorized");
        }
        const rawAnswer = result.content
          .filter((block): block is { type: "text"; text: string } => block.type === "text")
          .map((block) => block.text)
          .join("");
        const answer = sanitizeSessionObserverModelText(
          rawAnswer,
          SESSION_OBSERVER_ASK_ANSWER_MAX_CHARS,
        );
        if (!answer) {
          throw new Error("session observer returned an empty answer");
        }
        return {
          answer,
          ...(snapshot.digest ? { digestRevision: snapshot.digest.revision } : {}),
        };
      };
      return await Promise.race([execute(), aborted]);
    } catch (error) {
      observerLog.warn("session observer ask failed", { sessionKey, error });
      throw new SessionObserverAskError(
        "model-unavailable",
        "The session observer could not answer right now.",
      );
    } finally {
      clearTimeoutFn(timeout);
      if (askControllers.get(sessionKey) === controller) {
        // Clear only the owning call's slot; a stale completion must never
        // release a newer ask admitted after cancellation.
        askControllers.delete(sessionKey);
      }
    }
  };

  const requestModelDigest = async (state: SessionObserverState, notes: readonly string[]) => {
    const controller = new AbortController();
    state.activeController = controller;
    const timeout = setTimeoutFn(() => controller.abort(), MODEL_TIMEOUT_MS);
    const aborted = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener(
        "abort",
        () => reject(new Error("session observer model call timed out or was cancelled")),
        { once: true },
      );
    });
    try {
      const execute = async () => {
        const prepared = await ensurePrepared(state);
        if (!stateIsCurrent(state) || controller.signal.aborted) {
          throw new Error("session observer state is no longer active");
        }
        if ("error" in prepared) {
          throw new Error(prepared.error);
        }
        for (let attempt = 0; attempt < 2; attempt += 1) {
          if (!stateIsCurrent(state) || controller.signal.aborted) {
            throw new Error("session observer state is no longer active");
          }
          const result = await completeModel({
            model: prepared.model,
            auth: prepared.auth,
            cfg: deps.getConfig(),
            context: {
              systemPrompt: SESSION_OBSERVER_SYSTEM_PROMPT,
              messages: [
                {
                  role: "user",
                  content: buildSessionObserverPrompt(state, notes),
                  timestamp: now(),
                },
              ],
            },
            options: {
              maxTokens: Math.min(
                SESSION_OBSERVER_MODEL_MAX_TOKENS,
                Math.floor(prepared.model.maxTokens),
              ),
              temperature: 0.2,
              signal: controller.signal,
            },
          });
          if (result.stopReason === "error") {
            throw new Error(result.errorMessage?.trim() || "session observer completion failed");
          }
          const text = result.content
            .filter((block): block is { type: "text"; text: string } => block.type === "text")
            .map((block) => block.text)
            .join("")
            .trim();
          const parsed = normalizeSessionObserverModelOutput(text);
          if (parsed) {
            return parsed;
          }
        }
        throw new Error("session observer returned invalid JSON twice");
      };
      return await Promise.race([execute(), aborted]);
    } finally {
      clearTimeoutFn(timeout);
      if (state.activeController === controller) {
        state.activeController = undefined;
      }
    }
  };

  const persistAcceptedDigest = async (
    state: SessionObserverState,
    digest: SessionObserverDigest,
    final: boolean,
  ) => {
    const due =
      state.lastPersistedAt === undefined || now() - state.lastPersistedAt >= PERSIST_INTERVAL_MS;
    if (!final && !due) {
      return;
    }
    // Broadcasts remain live while durable writes are throttled; terminal
    // persistence gets one bounded retry so idle rows keep the final judgment.
    const attempts = final ? 2 : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const accepted = await persistDigest({
          sessionKey: state.sessionKey,
          sessionId: state.sessionId,
          agentId: state.agentId,
          digest,
          stillCurrent: runStillCurrent(state.runId, state.sessionKey),
        });
        if (accepted) {
          state.lastPersistedAt = now();
        }
        // A rejection is the store guard firing (rollover, reset, stale
        // revision) — retrying the same candidate can never succeed, but the
        // next valid digest must not inherit the 60s throttle.
        return;
      } catch (error) {
        if (attempt + 1 === attempts) {
          observerLog.warn("session observer digest persistence failed", {
            sessionKey: state.sessionKey,
            runId: state.runId,
            error,
          });
        }
      }
    }
  };

  const pendingNotes = (state: SessionObserverState) =>
    state.notes.filter((note) => note.sequence > state.lastDigestNoteSequence);

  const schedule = (
    state: SessionObserverState,
    run: (state: SessionObserverState, final: boolean) => void,
  ) => {
    if (!stateIsCurrent(state)) {
      if (disposed) {
        dropState(state);
      } else {
        suspendState(state);
      }
      return;
    }
    if (state.inFlight || state.timer || state.terminalHealth) {
      return;
    }
    if (state.digestCount >= MAX_LIVE_DIGESTS_PER_RUN) {
      return;
    }
    if (pendingNotes(state).length < MIN_NOTES_PER_DIGEST) {
      return;
    }
    const delay = Math.max(0, MIN_DIGEST_INTERVAL_MS - (now() - state.lastRunAt));
    if (delay === 0) {
      run(state, false);
      return;
    }
    state.timer = setTimeoutFn(() => {
      state.timer = undefined;
      run(state, false);
    }, delay);
  };

  const runDigest = (state: SessionObserverState, final: boolean) => {
    if (!stateIsCurrent(state)) {
      if (disposed) {
        dropState(state);
      } else {
        suspendState(state);
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
    flushSessionObserverAssistantNote(state);
    const selectedNotes = pendingNotes(state);
    if (!final && selectedNotes.length < MIN_NOTES_PER_DIGEST) {
      return;
    }
    if (!final && now() - state.lastRunAt < MIN_DIGEST_INTERVAL_MS) {
      schedule(state, runDigest);
      return;
    }
    if (state.timer) {
      clearTimeoutFn(state.timer);
      state.timer = undefined;
    }
    state.inFlight = true;
    state.lastRunAt = now();
    const lastSelectedSequence = selectedNotes.at(-1)?.sequence ?? state.lastDigestNoteSequence;
    void (async () => {
      try {
        const modelDigest = await requestModelDigest(
          state,
          selectedNotes.map((note) => note.text),
        );
        if (!stateIsCurrent(state)) {
          return;
        }
        // A session reset swaps sessionId under the same key; a digest accepted
        // for the old session must not reach the replacement session's watchers.
        if (
          state.sessionId &&
          readSession(state.sessionKey, state.agentId)?.sessionId !== state.sessionId
        ) {
          return;
        }
        state.consecutiveFailures = 0;
        state.revision += 1;
        state.digestCount += 1;
        state.lastDigestNoteSequence = lastSelectedSequence;
        const digest: SessionObserverDigest = {
          sessionKey: state.sessionKey,
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
        state.previousDigest = digest;
        deps.broadcastToConnIds(
          "session.observer",
          digest,
          deps.subscribers.get(state.sessionKey),
          { dropIfSlow: true },
        );
        await persistAcceptedDigest(state, digest, final);
        if (final) {
          dormantRuns.delete(state.runId);
        }
      } catch (error) {
        if (!stateIsCurrent(state)) {
          return;
        }
        state.consecutiveFailures += 1;
        if (state.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          observerLog.warn("session observer disabled after consecutive failures", {
            sessionKey: state.sessionKey,
            runId: state.runId,
            error,
          });
          if (final || state.finalPending || state.terminalHealth) {
            void synthesizeTerminalDigest({ state });
            dormantRuns.delete(state.runId);
            dropState(state);
          } else {
            disableRun(state);
          }
        } else if (final) {
          state.finalPending = true;
        }
      } finally {
        if (states.get(state.sessionKey) === state) {
          state.inFlight = false;
          const runFinal = state.finalPending;
          state.finalPending = false;
          if (runFinal) {
            runDigest(state, true);
          } else if (final) {
            dropState(state);
          } else {
            schedule(state, runDigest);
          }
        }
      }
    })();
  };

  const admitState = (event: AgentEventPayload): SessionObserverState | undefined => {
    const sessionKey = event.sessionKey?.trim();
    const agentId = event.agentId?.trim();
    // Watching is the intentional cost gate: read-scope subscribers are the
    // operator's own surfaces, and spend stays bounded by the session cap,
    // digest thresholds, and the sessionObserver/utilityModel kill switches.
    if (!sessionKey || !agentId || !hasSubscribers(sessionKey)) {
      return undefined;
    }
    const cfg = deps.getConfig();
    if (cfg.gateway?.controlUi?.sessionObserver === false) {
      return undefined;
    }
    const utilityModelRef = resolveUtilityModelRef({ cfg, agentId });
    if (!utilityModelRef) {
      return undefined;
    }
    if (states.size >= MAX_CONCURRENT_OBSERVED_SESSIONS) {
      const evicted = [...states.values()].toSorted(
        (left, right) =>
          left.lastActivityAt - right.lastActivityAt ||
          left.sessionKey.localeCompare(right.sessionKey),
      )[0];
      if (evicted) {
        suspendState(evicted);
      }
    }
    const dormant = dormantRuns.get(event.runId);
    if (dormant) {
      dormantRuns.delete(event.runId);
      const state: SessionObserverState = {
        ...dormant,
        utilityModelRef,
        lastActivityAt: event.ts,
        lastRunAt: now(),
        noteSequence: 0,
        lastDigestNoteSequence: 0,
        notes: [],
        noteBytes: 0,
        itemStatuses: new Map(),
        assistantBuffer: "",
        inFlight: false,
        finalPending: false,
      };
      states.set(sessionKey, state);
      return state;
    }
    const session = readSession(sessionKey, agentId);
    const startedAt =
      readFiniteNumber(event.data.startedAt) ?? session?.startedAt ?? event.ts ?? now();
    const state: SessionObserverState = {
      sessionKey,
      sessionId: event.sessionId ?? session?.sessionId,
      runId: event.runId,
      agentId,
      utilityModelRef,
      startedAt,
      lastActivityAt: event.ts,
      lastRunAt: startedAt,
      lastPersistedAt: session?.observerDigest?.updatedAt,
      revision: session?.observerDigest?.revision ?? 0,
      digestCount: 0,
      consecutiveFailures: 0,
      noteSequence: 0,
      lastDigestNoteSequence: 0,
      notes: [],
      noteBytes: 0,
      itemStatuses: new Map(),
      assistantBuffer: "",
      previousDigest: session?.observerDigest,
      inFlight: false,
      finalPending: false,
    };
    states.set(sessionKey, state);
    return state;
  };

  const handleEvent = (event: AgentEventPayload) => {
    if (disposed || getAgentRunContext(event.runId)?.isHeartbeat) {
      return;
    }
    const terminal = isTerminalLifecycleEvent(event);
    if (supersededRuns.has(event.runId)) {
      if (terminal) {
        supersededRuns.delete(event.runId);
        dormantRuns.delete(event.runId);
      }
      return;
    }
    if (disabledRuns.has(event.runId)) {
      if (terminal) {
        void synthesizeTerminalDigest({ event });
        disabledRuns.delete(event.runId);
        dormantRuns.delete(event.runId);
      }
      return;
    }
    const sessionKey = event.sessionKey?.trim();
    if (!sessionKey) {
      return;
    }
    if (terminal && !hasSubscribers(sessionKey)) {
      void synthesizeTerminalDigest({ event, state: states.get(sessionKey) });
      dormantRuns.delete(event.runId);
      return;
    }
    const isRunStart = event.stream === "lifecycle" && event.data.phase === "start";
    let revisionFloor = revisionFloors.get(sessionKey);
    let state = states.get(sessionKey);
    if (state && state.runId !== event.runId) {
      const candidate = { revision: state.revision, previousDigest: state.previousDigest };
      if (!revisionFloor || candidate.revision > revisionFloor.revision) {
        revisionFloor = candidate;
      }
      const supersededRunId = state.runId;
      if (isRunStart) {
        markSuperseded(supersededRunId, event.ts);
      }
      suspendState(state);
      if (isRunStart) {
        dormantRuns.delete(supersededRunId);
      }
      state = undefined;
    }
    if (!state) {
      const superseded = [...dormantRuns.values()]
        .filter((run) => run.sessionKey === sessionKey && run.runId !== event.runId)
        .toSorted(
          (left, right) => right.revision - left.revision || left.runId.localeCompare(right.runId),
        );
      const latest = superseded[0];
      if (latest && (!revisionFloor || latest.revision > revisionFloor.revision)) {
        revisionFloor = { revision: latest.revision, previousDigest: latest.previousDigest };
      }
      if (isRunStart) {
        if (revisionFloor) {
          rememberSessionObserverRevisionFloor(revisionFloors, sessionKey, revisionFloor);
        }
        for (const run of superseded) {
          markSuperseded(run.runId, event.ts);
          dormantRuns.delete(run.runId);
        }
      }
    }
    if (
      state &&
      (!hasSubscribers(sessionKey) ||
        deps.getConfig().gateway?.controlUi?.sessionObserver === false)
    ) {
      suspendState(state);
      state = undefined;
    }
    if (!state) {
      state = admitState(event);
    }
    if (!state) {
      if (terminal) {
        void synthesizeTerminalDigest({ event });
        dormantRuns.delete(event.runId);
      }
      return;
    }
    if (revisionFloor && revisionFloor.revision > state.revision) {
      state.revision = revisionFloor.revision;
      state.previousDigest = revisionFloor.previousDigest;
    }
    revisionFloors.delete(sessionKey);
    state.lastActivityAt = event.ts;
    const eventStartedAt = readFiniteNumber(event.data.startedAt);
    if (eventStartedAt !== undefined) {
      state.startedAt = Math.min(state.startedAt, eventStartedAt);
    }
    noteSessionObserverEvent(state, event, rememberItemStatus);
    if (terminal) {
      state.terminalHealth = terminalHealthFor(event);
      const endedAt = readFiniteNumber(event.data.endedAt) ?? now();
      const hasRunDigest = state.digestCount > 0 || state.previousDigest?.runId === state.runId;
      if (!hasRunDigest && endedAt - state.startedAt < FINAL_DIGEST_MIN_RUN_MS) {
        dormantRuns.delete(state.runId);
        dropState(state);
        return;
      }
      runDigest(state, true);
      return;
    }
    schedule(state, runDigest);
  };

  return {
    handleEvent,
    getSnapshot,
    ask,
    dispose() {
      disposed = true;
      unsubscribeChanges();
      for (const controller of askControllers.values()) {
        controller.abort();
      }
      askControllers.clear();
      for (const state of states.values()) {
        dropState(state);
      }
      dormantRuns.clear();
      revisionFloors.clear();
      supersededRuns.clear();
      disabledRuns.clear();
      askAdmissions.length = 0;
    },
  };
}
