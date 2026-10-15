import {
  finiteSecondsToTimerSafeMilliseconds,
  MAX_TIMER_TIMEOUT_MS,
} from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { createTypingKeepaliveLoop } from "../../channels/typing-lifecycle.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import { isSilentReplyPrefixText, isSilentReplyText, SILENT_REPLY_TOKEN } from "../tokens.js";
import {
  createTypingAudienceOwnership,
  type TypingAudienceOwnership,
} from "./typing-audience-lifecycle.js";

const DEFAULT_TYPING_INTERVAL_SECONDS = 6;
const DEFAULT_TYPING_TTL_MS = 2 * 60_000;
const MAX_TYPING_INTERVAL_MS = Math.floor(MAX_TIMER_TIMEOUT_MS / 2);

type BackgroundWorkState = "active" | "waiting" | "none";
type BackgroundWorkObserver = { currentState: () => BackgroundWorkState; dispose: () => void };
type ParentWaitObserver = {
  waiting: boolean;
  resumeRequired: boolean;
  onChange?: (snapshot: { waiting: boolean; resumeRequired: boolean }) => void;
  markExecutionResumed: () => void;
  dispose: () => void;
};

const backgroundWorkRuntimeLoader = createLazyImportLoader(
  () => import("./typing-background-work.runtime.js"),
);
const parentWaitRuntimeLoader = createLazyImportLoader(
  () => import("../../agents/agent-run-approval-wait.js"),
);

export function resolveTypingIntervalMs(seconds: number | undefined): number {
  if (Number.isFinite(seconds) && (seconds ?? 0) <= 0) {
    return 0;
  }
  const intervalMs =
    finiteSecondsToTimerSafeMilliseconds(seconds ?? DEFAULT_TYPING_INTERVAL_SECONDS) ??
    DEFAULT_TYPING_INTERVAL_SECONDS * 1000;
  return Math.min(intervalMs, MAX_TYPING_INTERVAL_MS);
}

export type TypingController = {
  onReplyStart: () => Promise<void>;
  startTypingLoop: () => Promise<void>;
  startTypingOnText: (text?: string) => Promise<void>;
  refreshTypingTtl: () => void;
  isActive: () => boolean;
  markRunComplete: () => void;
  markDispatchIdle: () => void;
  cleanup: () => void;
  bindRunIdentity?: (runId: string, sessionKey?: string, sessionId?: string) => void;
  setBackgroundWorkPause?: (pause?: () => void, audienceKey?: string) => void;
  markExecutionResumed?: () => void;
  shouldRetainChannelCallbacks?: () => boolean;
};

/** Creates a typing controller that seals itself after run and dispatch completion. */
export function createTypingController(params: {
  onReplyStart?: () => Promise<void> | void;
  onCleanup?: () => void;
  typingIntervalSeconds?: number;
  keepalive?: boolean;
  silentToken?: string;
  log?: (message: string) => void;
}): TypingController {
  const {
    onReplyStart,
    onCleanup,
    keepalive = true,
    silentToken = SILENT_REPLY_TOKEN,
    log,
  } = params;
  if (!onReplyStart && !onCleanup) {
    return {
      onReplyStart: async () => {},
      startTypingLoop: async () => {},
      startTypingOnText: async () => {},
      refreshTypingTtl: () => {},
      isActive: () => false,
      markRunComplete: () => {},
      markDispatchIdle: () => {},
      cleanup: () => {},
      bindRunIdentity: () => {},
      setBackgroundWorkPause: () => {},
      shouldRetainChannelCallbacks: () => false,
    };
  }
  let started = false;
  let active = false;
  let runComplete = false;
  let dispatchIdle = false;
  let triggerInFlight = false;
  let runId: string | undefined;
  let sessionKey: string | undefined;
  let sessionId: string | undefined;
  let backgroundObserverStarted = false;
  let backgroundObserverReady = false;
  let parentWaitObserverStarted = false;
  let parentWaitObserverFailed = false;
  let parentWaitObserver: ParentWaitObserver | undefined;
  let parentWaitObserverLoad: Promise<void> | undefined;
  let parentWaitActive = false;
  let parentAwaitingExecutionResume = false;
  let backgroundObserverFailed = false;
  let backgroundObserver: BackgroundWorkObserver | undefined;
  let backgroundWorkState: BackgroundWorkState = "none";
  let backgroundWorkPause: (() => void) | undefined;
  let backgroundWorkAudienceKey: string | undefined;
  let audienceOwnership: TypingAudienceOwnership | undefined;
  let channelPaused = false;
  let initialTypingStarted = false;
  let observerLoad: Promise<void> | undefined;
  // Late streaming callbacks must not restart a completed controller.
  let sealed = false;
  let typingTtlTimer: NodeJS.Timeout | undefined;
  const typingIntervalMs = resolveTypingIntervalMs(params.typingIntervalSeconds);
  // Leave one full cadence for a keepalive call to settle before safety cleanup.
  const typingTtlMs = Math.max(DEFAULT_TYPING_TTL_MS, typingIntervalMs * 2);

  const formatTypingTtl = (ms: number) => {
    if (ms % 60_000 === 0) {
      return `${ms / 60_000}m`;
    }
    return `${Math.round(ms / 1000)}s`;
  };

  const disposeBackgroundObserver = (observer?: BackgroundWorkObserver) => {
    try {
      observer?.dispose();
    } catch {
      log?.("typing background-work observer cleanup failed");
    }
  };

  const readBackgroundWorkState = (observer: BackgroundWorkObserver): BackgroundWorkState => {
    try {
      return observer.currentState();
    } catch {
      log?.("typing background-work owner read failed; failing closed");
      backgroundObserverFailed = true;
      backgroundObserverReady = false;
      disposeBackgroundObserver(observer);
      if (backgroundObserver === observer) {
        backgroundObserver = undefined;
      }
      applyBackgroundWorkState("none");
      return "none";
    }
  };

  const cleanup = () => {
    if (sealed) {
      return;
    }
    sealed = true;
    audienceOwnership?.release();
    audienceOwnership = undefined;
    try {
      parentWaitObserver?.dispose();
    } catch {
      log?.("typing parent-wait observer cleanup failed");
    }
    parentWaitObserver = undefined;
    disposeBackgroundObserver(backgroundObserver);
    backgroundObserver = undefined;
    backgroundObserverReady = false;
    if (typingTtlTimer) {
      clearTimeout(typingTtlTimer);
      typingTtlTimer = undefined;
    }
    if (dispatchIdleTimer) {
      clearTimeout(dispatchIdleTimer);
      dispatchIdleTimer = undefined;
    }
    typingLoop.stop();
    // Notify the channel to stop its typing indicator (e.g., on NO_REPLY).
    // This fires only once (sealed prevents re-entry).
    if (active) {
      onCleanup?.();
    }
  };

  const refreshTypingTtl = () => {
    if (sealed || typingIntervalMs <= 0) {
      return;
    }
    clearTimeout(typingTtlTimer);
    typingTtlTimer = setTimeout(() => {
      if (!typingLoop.isRunning()) {
        return;
      }
      log?.(`typing TTL reached (${formatTypingTtl(typingTtlMs)}); stopping typing indicator`);
      cleanup();
    }, typingTtlMs);
  };

  const isActive = () => active && !sealed && (!runComplete || backgroundWorkState === "active");

  const triggerTyping = async () => {
    if (triggerInFlight || sealed || (audienceOwnership && !audienceOwnership.isOwner())) {
      return;
    }
    triggerInFlight = true;
    try {
      if (runComplete) {
        const observer = backgroundObserver;
        if (!observer) {
          return;
        }
        const current = readBackgroundWorkState(observer);
        if (current !== backgroundWorkState) {
          applyBackgroundWorkState(current);
        }
        if (current !== "active") {
          return;
        }
      }
      await onReplyStart?.();
      initialTypingStarted = true;
      refreshTypingTtl();
      if (!backgroundObserverStarted) {
        void startBackgroundWorkObserver();
      }
      if (!parentWaitObserverStarted) {
        void startParentWaitObserver();
      }
    } catch (err) {
      log?.(`typing start failed: ${String(err)}`);
    } finally {
      triggerInFlight = false;
    }
  };

  const scheduleTyping = async () => {
    void triggerTyping();
    await Promise.resolve();
  };

  const typingLoop = createTypingKeepaliveLoop({
    intervalMs: typingIntervalMs,
    onTick: triggerTyping,
  });

  const isAudienceWorkActive = () =>
    !sealed &&
    ((active && !runComplete && !parentWaitActive && !parentAwaitingExecutionResume) ||
      backgroundWorkState === "active");

  const updateAudienceOwnership = () => {
    if (!backgroundWorkPause || !backgroundWorkAudienceKey || !keepalive || typingIntervalMs <= 0) {
      audienceOwnership?.setActive(false);
      return;
    }
    if (!audienceOwnership && isAudienceWorkActive()) {
      audienceOwnership = createTypingAudienceOwnership({
        audienceKey: backgroundWorkAudienceKey,
        onOwnershipChange: (owns) => {
          if (!owns) {
            if (typingLoop.isRunning()) {
              typingLoop.stop();
            }
            if (typingTtlTimer) {
              clearTimeout(typingTtlTimer);
              typingTtlTimer = undefined;
            }
            if (!channelPaused) {
              channelPaused = true;
              try {
                backgroundWorkPause?.();
              } catch {
                log?.("typing background-work pause failed");
              }
            }
            return;
          }
          channelPaused = false;
          if (started && keepalive && typingIntervalMs > 0) {
            void triggerTyping();
            typingLoop.start();
          }
        },
      });
    }
    audienceOwnership?.setActive(isAudienceWorkActive());
  };

  const ensureStart = async () => {
    // Late callbacks after a run completed should never restart typing.
    if (sealed || runComplete) {
      return;
    }
    active = true;
    if (started) {
      updateAudienceOwnership();
      return;
    }
    started = true;
    updateAudienceOwnership();

    await scheduleTyping();
  };

  let dispatchIdleTimer: NodeJS.Timeout | undefined;
  const DISPATCH_IDLE_GRACE_MS = 10_000;

  const clearDispatchIdleTimer = () => {
    if (dispatchIdleTimer) {
      clearTimeout(dispatchIdleTimer);
      dispatchIdleTimer = undefined;
    }
  };

  const hasValidatedBackgroundWorkObserver = () =>
    backgroundObserverReady && !backgroundObserverFailed && backgroundObserver !== undefined;

  const armDispatchIdleTimer = () => {
    if (sealed) {
      return;
    }
    if (backgroundWorkState === "waiting" && hasValidatedBackgroundWorkObserver()) {
      clearDispatchIdleTimer();
      return;
    }
    if (dispatchIdleTimer || (dispatchIdle && backgroundWorkState !== "waiting")) {
      return;
    }
    dispatchIdleTimer = setTimeout(() => {
      dispatchIdleTimer = undefined;
      if (
        !sealed &&
        backgroundWorkState !== "active" &&
        (!dispatchIdle || backgroundWorkState === "waiting")
      ) {
        log?.("typing: dispatch idle not received after run complete; forcing cleanup");
        cleanup();
      }
    }, DISPATCH_IDLE_GRACE_MS);
  };

  const pauseForBackgroundWait = () => {
    if (typingLoop.isRunning()) {
      typingLoop.stop();
    }
    if (typingTtlTimer) {
      clearTimeout(typingTtlTimer);
      typingTtlTimer = undefined;
    }
    if (!channelPaused) {
      channelPaused = true;
      try {
        backgroundWorkPause?.();
      } catch {
        log?.("typing background-work pause failed");
      }
    }
  };

  const maybeStopOnIdle = () => {
    // Keep the request-owned controller only while a current work owner exists
    // or is waiting for an execution event; an empty owner set seals it normally.
    if (active && runComplete && dispatchIdle && backgroundWorkState === "none") {
      cleanup();
    }
  };

  const applyBackgroundWorkState = (next: BackgroundWorkState) => {
    if (sealed) {
      return;
    }
    const previous = backgroundWorkState;
    backgroundWorkState = next;
    updateAudienceOwnership();
    if (!runComplete) {
      return;
    }
    if (next === "active") {
      clearDispatchIdleTimer();
      const resume = channelPaused || previous !== "active";
      channelPaused = false;
      if (resume) {
        void triggerTyping();
      }
      if (keepalive && typingIntervalMs > 0 && !typingLoop.isRunning()) {
        if (!resume) {
          void triggerTyping();
        }
        typingLoop.start();
      }
      refreshTypingTtl();
      return;
    }
    if (next === "waiting") {
      pauseForBackgroundWait();
      if (hasValidatedBackgroundWorkObserver()) {
        clearDispatchIdleTimer();
      } else {
        armDispatchIdleTimer();
      }
      return;
    }
    if (next === "none") {
      channelPaused = false;
      if (typingLoop.isRunning()) {
        typingLoop.stop();
      }
      if (typingTtlTimer) {
        clearTimeout(typingTtlTimer);
        typingTtlTimer = undefined;
      }
    }
    maybeStopOnIdle();
    armDispatchIdleTimer();
  };

  const applyParentWaitSnapshot = (snapshot: {
    waiting: boolean;
    resumeRequired: boolean;
  }): void => {
    if (sealed) {
      return;
    }
    parentWaitActive = snapshot.waiting;
    parentAwaitingExecutionResume = !snapshot.waiting && snapshot.resumeRequired;
    updateAudienceOwnership();
  };

  async function startParentWaitObserver(): Promise<void> {
    const boundRunId = runId;
    const boundSessionKey = sessionKey;
    const boundSessionId = sessionId;
    if (
      parentWaitObserverStarted ||
      sealed ||
      !backgroundWorkPause ||
      !backgroundWorkAudienceKey ||
      !boundRunId ||
      !boundSessionKey ||
      !keepalive ||
      typingIntervalMs <= 0
    ) {
      return;
    }
    parentWaitObserverStarted = true;
    parentWaitObserverLoad = parentWaitRuntimeLoader
      .load()
      .then(({ observeAgentRunHumanWait }) =>
        observeAgentRunHumanWait({
          runId: boundRunId,
          sessionKey: boundSessionKey,
          ...(boundSessionId ? { sessionId: boundSessionId } : {}),
        }),
      )
      .then((observer) => {
        if (sealed) {
          observer.dispose();
          return;
        }
        parentWaitObserver = observer;
        observer.onChange = applyParentWaitSnapshot;
        applyParentWaitSnapshot({
          waiting: observer.waiting,
          resumeRequired: observer.resumeRequired,
        });
      })
      .catch(() => {
        if (sealed) {
          return;
        }
        parentWaitObserverFailed = true;
        log?.("typing parent-wait owner unavailable; continuing only known active work");
      });
    await parentWaitObserverLoad;
  }

  async function startBackgroundWorkObserver(): Promise<void> {
    const boundRunId = runId;
    const boundSessionKey = sessionKey;
    if (
      backgroundObserverStarted ||
      sealed ||
      !active ||
      !initialTypingStarted ||
      !backgroundWorkPause ||
      !boundRunId ||
      !boundSessionKey ||
      !keepalive ||
      typingIntervalMs <= 0
    ) {
      return;
    }
    backgroundObserverStarted = true;
    if (runComplete) {
      applyBackgroundWorkState("waiting");
    }
    let observerReady = false;
    const onChange = (state: BackgroundWorkState) => {
      if (backgroundObserverFailed || !observerReady) {
        return;
      }
      applyBackgroundWorkState(state);
    };
    const load = backgroundWorkRuntimeLoader.load().then(({ createReplyBackgroundWorkObserver }) =>
      createReplyBackgroundWorkObserver({
        sessionKey: boundSessionKey,
        runId: boundRunId,
        onChange,
      }),
    );
    observerLoad = load
      .then((observer) => {
        if (sealed) {
          disposeBackgroundObserver(observer);
          return;
        }
        backgroundObserver = observer;
        const initialState = observer.currentState();
        backgroundObserverReady = true;
        observerReady = true;
        applyBackgroundWorkState(initialState);
      })
      .catch(() => {
        log?.("typing background-work owner unavailable; failing closed");
        observerReady = true;
        backgroundObserverFailed = true;
        backgroundObserverReady = false;
        disposeBackgroundObserver(backgroundObserver);
        backgroundObserver = undefined;
        applyBackgroundWorkState("none");
      });
    await observerLoad;
  }

  const startTypingLoop = async () => {
    if (sealed) {
      return;
    }
    if (runComplete) {
      if (backgroundWorkState === "active" && keepalive && typingIntervalMs > 0) {
        if (!typingLoop.isRunning()) {
          void triggerTyping();
          typingLoop.start();
        }
      }
      return;
    }
    // Always refresh TTL when called, even if loop already running.
    // This keeps typing alive during long tool executions.
    refreshTypingTtl();
    if (!onReplyStart) {
      return;
    }
    if (keepalive && typingLoop.isRunning()) {
      return;
    }
    await ensureStart();
    // Cleanup or completion can run while the start callback yields. The loop
    // must not acquire a timer after its owning controller has closed.
    if (keepalive && !sealed && !runComplete) {
      typingLoop.start();
    }
  };

  const startTypingOnText = async (text?: string) => {
    if (sealed) {
      return;
    }
    const trimmed = normalizeOptionalString(text);
    if (!trimmed) {
      return;
    }
    if (
      silentToken &&
      (isSilentReplyText(trimmed, silentToken) || isSilentReplyPrefixText(trimmed, silentToken))
    ) {
      return;
    }
    // Visible text, not silent control tokens, is what should start typing.
    refreshTypingTtl();
    await startTypingLoop();
  };

  const markRunComplete = () => {
    runComplete = true;
    if (backgroundObserverStarted && !backgroundObserver && !backgroundObserverFailed) {
      applyBackgroundWorkState("waiting");
    } else if (backgroundObserver) {
      applyBackgroundWorkState(readBackgroundWorkState(backgroundObserver));
    } else {
      updateAudienceOwnership();
    }
    maybeStopOnIdle();
    armDispatchIdleTimer();
  };

  const markDispatchIdle = () => {
    dispatchIdle = true;
    clearDispatchIdleTimer();
    if (backgroundObserver) {
      applyBackgroundWorkState(readBackgroundWorkState(backgroundObserver));
    }

    maybeStopOnIdle();
    // The dispatcher can become idle while the lazy observer is still loading.
    // Keep the existing bounded fallback until a validated observer takes custody.
    armDispatchIdleTimer();
  };

  const bindRunIdentity = (nextRunId: string, nextSessionKey?: string, nextSessionId?: string) => {
    const normalizedRunId = normalizeOptionalString(nextRunId);
    const normalizedSessionKey = normalizeOptionalString(nextSessionKey);
    const normalizedSessionId = normalizeOptionalString(nextSessionId);
    if (sealed || !normalizedRunId || !normalizedSessionKey) {
      return;
    }
    if (
      (runId !== undefined && runId !== normalizedRunId) ||
      (sessionKey !== undefined && sessionKey !== normalizedSessionKey) ||
      (sessionId !== undefined &&
        normalizedSessionId !== undefined &&
        sessionId !== normalizedSessionId)
    ) {
      cleanup();
      return;
    }
    runId = normalizedRunId;
    sessionKey = normalizedSessionKey;
    sessionId = normalizedSessionId;
    void startParentWaitObserver();
    if (initialTypingStarted) {
      void startBackgroundWorkObserver();
      void startParentWaitObserver();
    }
  };

  const setBackgroundWorkPause = (pause?: () => void, audienceKey?: string) => {
    backgroundWorkPause = pause;
    backgroundWorkAudienceKey = normalizeOptionalString(audienceKey);
    void startParentWaitObserver();
    if (initialTypingStarted) {
      updateAudienceOwnership();
      void startBackgroundWorkObserver();
      void startParentWaitObserver();
    }
  };

  const markExecutionResumed = () => {
    parentWaitObserver?.markExecutionResumed();
    if (parentWaitObserver) {
      parentWaitActive = parentWaitObserver.waiting;
      parentAwaitingExecutionResume = parentWaitObserver.resumeRequired;
    } else if (!parentWaitObserverFailed) {
      parentWaitActive = false;
      parentAwaitingExecutionResume = false;
    }
    updateAudienceOwnership();
  };

  const shouldRetainChannelCallbacks = () => {
    const retain =
      !sealed &&
      ((runComplete && !dispatchIdle) ||
        (!backgroundObserverFailed && backgroundObserverStarted && !runComplete) ||
        (!backgroundObserverFailed && backgroundObserverStarted && backgroundWorkState !== "none"));
    return retain;
  };

  return {
    onReplyStart: ensureStart,
    startTypingLoop,
    startTypingOnText,
    refreshTypingTtl,
    isActive,
    markRunComplete,
    markDispatchIdle,
    cleanup,
    bindRunIdentity,
    setBackgroundWorkPause,
    markExecutionResumed,
    shouldRetainChannelCallbacks,
  };
}
