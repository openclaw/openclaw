// Gateway shutdown and restart close orchestration.
// Coordinates hooks, drains, sockets, sidecars, plugins, and runtime cleanup.
import type { Server as HttpServer } from "node:http";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { WebSocketServer } from "ws";
import { disposeAllSessionMcpRuntimes } from "../agents/agent-bundle-mcp-tools.js";
import { disposeRegisteredAgentHarnesses } from "../agents/harness/registry.js";
import { createAgentRunRestartAbortError } from "../agents/run-termination.js";
import { clearSessionSuspensionTimers } from "../agents/session-suspension.js";
import { type ChannelId, listChannelPlugins } from "../channels/plugins/index.js";
import { createInternalHookEvent, triggerInternalHook } from "../hooks/internal-hooks.js";
import type { HeartbeatRunner } from "../infra/heartbeat-runner.js";
import { parseStrictPositiveInteger } from "../infra/parse-finite-number.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { closePluginStateDatabase } from "../plugin-state/plugin-state-store.js";
import type { PluginServicesHandle } from "../plugins/services.js";
import {
  abortTrackedChatRunById,
  type ChatAbortControllerEntry,
  isChatAbortControllerEntryAbortable,
  removeChatAbortControllerEntry,
  type RestartRecoveryCandidate,
} from "./chat-abort.js";
import { abortQueuedChatTurns, type QueuedChatTurnMap } from "./chat-queued-turns.js";
import {
  collectGatewayProcessMemoryUsageMb,
  measureGatewayRestartTrace,
  recordGatewayRestartTrace,
} from "./restart-trace.js";
import {
  createChatAbortMarker,
  type ChatRunEntry,
  type ChatRunState,
} from "./server-chat-state.js";
import type { GatewayPostReadySidecarHandle } from "./server-startup-post-attach.js";

const shutdownLog = createSubsystemLogger("gateway/shutdown");
const GATEWAY_SHUTDOWN_HOOK_TIMEOUT_MS = 5_000;
const GATEWAY_PRE_RESTART_HOOK_TIMEOUT_MS = 10_000;
const ACTIVE_SESSIONS_SHUTDOWN_DRAIN_TIMEOUT_MS = 2_000;
const WEBSOCKET_CLOSE_GRACE_MS = 1_000;
const WEBSOCKET_CLOSE_FORCE_CONTINUE_MS = 250;
const HTTP_CLOSE_GRACE_MS = 1_000;
const HTTP_CLOSE_FORCE_WAIT_MS = 5_000;
const MCP_RUNTIME_CLOSE_GRACE_MS = 5_000;
const LSP_RUNTIME_CLOSE_GRACE_MS = 5_000;
const RESTART_REPLY_DRAIN_POLL_MS = 100;
const RESTART_REPLY_POST_ABORT_DRAIN_TIMEOUT_MS = 1_000;
const RESTART_REPLY_POST_ABORT_DRAIN_POLL_MS = 50;
const RESTART_TERMINAL_PERSISTENCE_WAIT_TIMEOUT_MS = 1_000;
const RESTART_MARKER_SLOW_WARNING_MS = 1_000;
const DEFAULT_POST_SHUTDOWN_EXIT_TIMEOUT_MS = 5_000;
const POST_SHUTDOWN_EXIT_TIMEOUT_ENV = "OPENCLAW_GATEWAY_POST_SHUTDOWN_EXIT_TIMEOUT_MS";

// Tracks whether a shutdown is in progress so /healthz can flip to 503 before the
// HTTP listener actually unbinds. Without this, a zombie node process that finished
// shutdown but failed to exit still answers 200 on /healthz, which makes the
// supervised lock-recovery path defer to it and leaves the bot offline. Module-level
// because the close handler in this file is the canonical owner; readers (HTTP probe
// handler) import the accessor below.
let gatewayShuttingDownState: "running" | "shutting_down" = "running";

export function markGatewayShuttingDown(): void {
  gatewayShuttingDownState = "shutting_down";
}

export function isGatewayShuttingDown(): boolean {
  return gatewayShuttingDownState === "shutting_down";
}

// Used by gateway startup (and in-process restart) to flip the state back to
// running before /healthz starts answering 200 again. Tests use the same path
// so isolation is guaranteed across runs.
export function resetGatewayShuttingDownState(): void {
  gatewayShuttingDownState = "running";
}

export function resetGatewayShuttingDownForTest(): void {
  resetGatewayShuttingDownState();
}

function resolvePostShutdownExitTimeoutMs(): number {
  const raw = process.env[POST_SHUTDOWN_EXIT_TIMEOUT_ENV]?.trim();
  if (!raw) {
    return DEFAULT_POST_SHUTDOWN_EXIT_TIMEOUT_MS;
  }
  const parsed = parseStrictPositiveInteger(raw);
  return parsed ?? DEFAULT_POST_SHUTDOWN_EXIT_TIMEOUT_MS;
}

function summarizeActiveHandlesForZombieReport(): string {
  const processWithResourceAccess = process as NodeJS.Process & {
    _getActiveHandles?: () => unknown[];
    getActiveResourcesInfo?: () => string[];
  };
  // Prefer constructor names from internal handles for actionable detail, then fall
  // back to getActiveResourcesInfo for newer Node where _getActiveHandles is removed.
  const handles = processWithResourceAccess["_getActiveHandles"]?.();
  if (handles && handles.length > 0) {
    const counts = new Map<string, number>();
    for (const handle of handles) {
      if (typeof handle !== "object" || handle === null) {
        continue;
      }
      const name = (handle as { constructor?: { name?: string } }).constructor?.name ?? "Unknown";
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    const parts = Array.from(counts.entries())
      .toSorted((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([name, count]) => `${name}=${count}`);
    return `handles[${handles.length}] ${parts.join(",")}`;
  }
  const resources = processWithResourceAccess.getActiveResourcesInfo?.();
  if (resources && resources.length > 0) {
    const counts = new Map<string, number>();
    for (const name of resources) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    const parts = Array.from(counts.entries())
      .toSorted((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([name, count]) => `${name}=${count}`);
    return `resources[${resources.length}] ${parts.join(",")}`;
  }
  return "no handle/resource detail available";
}

// Force the node process to exit after a clean shutdown if some library held a
// stray handle (HTTP keep-alive, telegram fetch, plugin native handle). Without
// this, the parent supervisor (launchd/systemd) sees the lock dropped but the
// PID never reaps, the HTTP listener stays bound, and the next gateway probe
// returns 200 from the zombie. Tests inject `exitProcess` to avoid killing the
// vitest worker.
export function armGatewayPostShutdownExitWatchdog(opts?: {
  timeoutMs?: number;
  exitProcess?: (code: number) => void;
  reason?: string;
  shutdownDurationMs?: number;
}): { cancel: () => void } {
  // Skip in vitest workers: any test that exercises the production close path
  // without mocking this dep would otherwise trip the watchdog and call
  // process.exit() on the worker, killing the whole shard. Tests that want to
  // exercise the watchdog itself (the explicit zombie-detected coverage) inject
  // a mock exitProcess via opts. Production gateways have no VITEST set.
  if (process.env.VITEST !== undefined && opts?.exitProcess === undefined) {
    return { cancel: () => {} };
  }
  const timeoutMs = Math.max(0, Math.floor(opts?.timeoutMs ?? resolvePostShutdownExitTimeoutMs()));
  const exit = opts?.exitProcess ?? ((code: number) => process.exit(code));
  const reason = opts?.reason ?? "gateway stopping";
  const shutdownDurationMs = opts?.shutdownDurationMs;
  const timer = setTimeout(() => {
    const handleSummary = summarizeActiveHandlesForZombieReport();
    shutdownLog.warn(
      `gateway shutdown completed but node process still alive after ${timeoutMs}ms; forcing process.exit(0). Likely an unreleased handle (HTTP keep-alive, telegram fetch, plugin native handle). ${handleSummary}`,
    );
    const metrics: Array<readonly [string, string | number]> = [
      ["reason", reason],
      ["forcedExitAfterMs", timeoutMs],
      ["handleSummary", handleSummary],
    ];
    if (typeof shutdownDurationMs === "number" && Number.isFinite(shutdownDurationMs)) {
      metrics.push(["shutdownDurationMs", shutdownDurationMs]);
    }
    recordGatewayRestartTrace("gateway.shutdown.zombie_detected", timeoutMs, metrics);
    exit(0);
  }, timeoutMs);
  // unref so this watchdog never blocks a healthy natural exit; we only want
  // it to fire when something else is keeping the loop alive.
  timer.unref?.();
  return {
    cancel: () => {
      clearTimeout(timer);
    },
  };
}

export type ShutdownResult = {
  durationMs: number;
  warnings: string[];
};

/** Create a timeout promise plus cleanup hook for shutdown races. */
function createTimeoutRace<T>(timeoutMs: number, onTimeout: () => T) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  timer = setTimeout(() => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    resolve(onTimeout());
  }, timeoutMs);
  timer.unref?.();

  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });

  return {
    promise,
    clear() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

/** Run one shutdown step and record a warning instead of aborting the whole close. */
async function shutdownStep(
  name: string,
  fn: () => Promise<void> | void,
  warnings: string[],
): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    shutdownLog.warn(`${name}: ${detail}`);
    recordShutdownWarning(warnings, name);
    return false;
  }
}

/** Record a shutdown warning once. */
function recordShutdownWarning(warnings: string[], name: string): void {
  if (!warnings.includes(name)) {
    warnings.push(name);
  }
}

/** Count pending replies and active runs that must drain before restart shutdown. */
function getRestartReplyDrainCounts(params: {
  getPendingReplyCount: () => number;
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
  chatQueuedTurns: QueuedChatTurnMap;
}) {
  const pendingReplyCount = params.getPendingReplyCount();
  const activeRuns = listRestartDrainRuns(params.chatAbortControllers).length;
  const queuedTurns = Array.from(
    params.chatQueuedTurns.values(),
    (entry) => entry.controller.signal.aborted,
  ).filter((aborted) => !aborted).length;
  return {
    pendingReplies:
      Number.isFinite(pendingReplyCount) && pendingReplyCount > 0
        ? Math.floor(pendingReplyCount)
        : 0,
    activeRuns,
    queuedTurns,
  };
}

/** List unaborted runs still owned by the restart lifecycle. */
function listUnabortedRestartRuns(
  chatAbortControllers: Map<string, ChatAbortControllerEntry>,
): Array<[string, ChatAbortControllerEntry]> {
  return Array.from(chatAbortControllers.entries()).filter(
    ([, entry]) => !entry.controller.signal.aborted,
  );
}

/** List runtime-active runs participating in restart drain. */
function listRestartDrainRuns(
  chatAbortControllers: Map<string, ChatAbortControllerEntry>,
): Array<[string, ChatAbortControllerEntry]> {
  return listUnabortedRestartRuns(chatAbortControllers).filter(
    ([, entry]) => entry.registrationCleanupRequested !== true,
  );
}

/** List active runs whose session lifecycle still needs restart recovery. */
function listRestartRecoveryRuns(
  chatAbortControllers: Map<string, ChatAbortControllerEntry>,
): Array<[string, ChatAbortControllerEntry]> {
  return listUnabortedRestartRuns(chatAbortControllers).filter(
    ([, entry]) =>
      entry.controlUiVisible !== false &&
      (entry.registrationCleanupRequested !== true ||
        entry.projectSessionTerminalPersisted !== true),
  );
}

/** Format drain counts for shutdown logs. */
function formatRestartReplyDrainDetails(counts: {
  pendingReplies: number;
  activeRuns: number;
  queuedTurns: number;
}): string {
  const details: string[] = [];
  if (counts.pendingReplies > 0) {
    details.push(`${counts.pendingReplies} pending reply(ies)`);
  }
  if (counts.activeRuns > 0) {
    details.push(`${counts.activeRuns} active run(s)`);
  }
  if (counts.queuedTurns > 0) {
    details.push(`${counts.queuedTurns} queued turn(s)`);
  }
  return details.length > 0 ? details.join(", ") : "no pending reply work";
}

/** Sleep helper with unref'd timer for restart drain polling. */
async function sleepForRestartReplyDrain(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    timer.unref?.();
  });
}

type RestartRunAbortParams = {
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
  chatQueuedTurns: QueuedChatTurnMap;
  restartRecoveryCandidates?: Map<string, RestartRecoveryCandidate>;
  chatRunState: ChatRunState;
  removeChatRun: (
    sessionId: string,
    clientRunId: string,
    sessionKey?: string,
  ) => ChatRunEntry | undefined;
  agentRunSeq: Map<string, number>;
  broadcast: (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
  nodeSendToSession: (sessionKey: string, event: string, payload: unknown) => void;
  markMainSessionsAbortedForRestart?: (params: {
    sessionKeys: Set<string>;
    sessionIds: Set<string>;
    activeRuns: Array<{
      runId: string;
      lifecycleGeneration: string;
      sessionKey: string;
      sessionId: string;
      observedAt?: number;
    }>;
    reason: string;
    isActiveRun: (run: {
      runId: string;
      lifecycleGeneration: string;
      sessionKey: string;
      sessionId: string;
      observedAt?: number;
    }) => boolean;
  }) => Promise<void> | void;
  resolveActiveSessionIdForKey?: (sessionKey: string) => string | undefined;
};

/** Wait for pending replies and active runs to drain before restart shutdown. */
async function waitForRestartReplyDrain(params: {
  getPendingReplyCount: () => number;
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
  chatQueuedTurns: QueuedChatTurnMap;
  timeoutMs: number;
  pollMs?: number;
}): Promise<{
  drained: boolean;
  elapsedMs: number;
  counts: { pendingReplies: number; activeRuns: number; queuedTurns: number };
}> {
  const timeoutMs = Math.max(0, Math.floor(params.timeoutMs));
  const pollMs = Math.max(25, Math.floor(params.pollMs ?? RESTART_REPLY_DRAIN_POLL_MS));
  let counts = getRestartReplyDrainCounts(params);
  if (counts.pendingReplies <= 0 && counts.activeRuns <= 0 && counts.queuedTurns <= 0) {
    return { drained: true, elapsedMs: 0, counts };
  }
  if (timeoutMs <= 0) {
    return { drained: false, elapsedMs: 0, counts };
  }

  const startedAt = Date.now();
  for (;;) {
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= timeoutMs) {
      return { drained: false, elapsedMs, counts };
    }
    await sleepForRestartReplyDrain(Math.min(pollMs, timeoutMs - elapsedMs));
    counts = getRestartReplyDrainCounts(params);
    if (counts.pendingReplies <= 0 && counts.activeRuns <= 0 && counts.queuedTurns <= 0) {
      return { drained: true, elapsedMs: Date.now() - startedAt, counts };
    }
  }
}

function collectActiveRestartSessionRefs(
  params: Pick<
    RestartRunAbortParams,
    "chatAbortControllers" | "resolveActiveSessionIdForKey" | "restartRecoveryCandidates"
  >,
): {
  sessionKeys: Set<string>;
  sessionIds: Set<string>;
  activeRuns: Array<{
    runId: string;
    lifecycleGeneration: string;
    sessionKey: string;
    sessionId: string;
    observedAt?: number;
  }>;
} {
  const sessionKeys = new Set<string>();
  const sessionIds = new Set<string>();
  const activeRuns = new Map<string, RestartRecoveryCandidate>();
  const observedAt = Date.now();
  const addRun = (run: RestartRecoveryCandidate) => {
    sessionKeys.add(run.sessionKey);
    sessionIds.add(run.sessionId);
    activeRuns.set(`${run.runId}\u0000${run.lifecycleGeneration}`, {
      ...run,
      observedAt: run.observedAt ?? observedAt,
    });
  };
  for (const [runId, entry] of listRestartRecoveryRuns(params.chatAbortControllers)) {
    const sessionKey = entry.sessionKey.trim();
    if (sessionKey) {
      sessionKeys.add(sessionKey);
    }
    // Registration metadata can predate a reset or compaction session-id rotation.
    const resolvedSessionId =
      entry.kind === "agent" || !sessionKey
        ? undefined
        : params.resolveActiveSessionIdForKey?.(sessionKey);
    const sessionId = resolvedSessionId || entry.sessionId.trim();
    if (sessionId) {
      sessionIds.add(sessionId);
    }
    if (runId && entry.lifecycleGeneration && sessionKey && sessionId) {
      addRun({
        runId,
        lifecycleGeneration: entry.lifecycleGeneration,
        sessionKey,
        sessionId,
        observedAt: entry.projectSessionTerminalObservedAt,
      });
    }
  }
  for (const candidate of params.restartRecoveryCandidates?.values() ?? []) {
    const resolvedSessionId = params.resolveActiveSessionIdForKey?.(candidate.sessionKey);
    addRun({
      ...candidate,
      sessionId: resolvedSessionId || candidate.sessionId,
    });
  }
  return { sessionKeys, sessionIds, activeRuns: [...activeRuns.values()] };
}

async function settleTerminalSessionPersistenceForRestart(
  chatAbortControllers: Map<string, ChatAbortControllerEntry>,
): Promise<void> {
  const pending = listUnabortedRestartRuns(chatAbortControllers).flatMap(([, entry]) => {
    const persistence = entry.projectSessionTerminalPersistence;
    if (entry.projectSessionActive !== false || !persistence) {
      return [];
    }
    return [{ entry, persistence }];
  });
  if (pending.length === 0) {
    return;
  }
  const timeout = createTimeoutRace(RESTART_TERMINAL_PERSISTENCE_WAIT_TIMEOUT_MS, () => null);
  const results = await Promise.race([
    Promise.allSettled(pending.map(({ persistence }) => persistence)),
    timeout.promise,
  ]);
  timeout.clear();
  if (!results) {
    shutdownLog.warn(
      `terminal session persistence did not settle within ${RESTART_TERMINAL_PERSISTENCE_WAIT_TIMEOUT_MS}ms; preserving restart recovery`,
    );
    return;
  }
  for (const [index, result] of results.entries()) {
    const tracked = pending[index];
    if (!tracked || tracked.entry.projectSessionTerminalPersistence !== tracked.persistence) {
      continue;
    }
    tracked.entry.projectSessionTerminalPersistence = undefined;
    if (result.status === "fulfilled") {
      tracked.entry.projectSessionTerminalPersisted = true;
    }
  }
}

async function markActiveRunsForRestartRecovery(
  params: RestartRunAbortParams & {
    reason: string;
    warnings: string[];
  },
): Promise<void> {
  if (!params.markMainSessionsAbortedForRestart) {
    return;
  }
  await settleTerminalSessionPersistenceForRestart(params.chatAbortControllers);
  const refs = collectActiveRestartSessionRefs(params);
  if (refs.sessionKeys.size === 0 && refs.sessionIds.size === 0) {
    return;
  }
  try {
    const markerTimeout = createTimeoutRace(
      RESTART_MARKER_SLOW_WARNING_MS,
      () => "timeout" as const,
    );
    const markerOutcome = Promise.resolve(
      params.markMainSessionsAbortedForRestart({
        ...refs,
        reason: params.reason,
        isActiveRun: (run) => {
          const entry = params.chatAbortControllers.get(run.runId);
          const candidate = params.restartRecoveryCandidates?.get(run.runId);
          return (
            (entry &&
              !entry.controller.signal.aborted &&
              (entry.registrationCleanupRequested !== true ||
                entry.projectSessionTerminalPersisted !== true) &&
              entry.lifecycleGeneration === run.lifecycleGeneration) ||
            candidate?.lifecycleGeneration === run.lifecycleGeneration
          );
        },
      }),
    ).then(
      () => ({ status: "completed" as const }),
      (error: unknown) => ({ status: "failed" as const, error }),
    );
    const firstOutcome = await Promise.race([markerOutcome, markerTimeout.promise]);
    markerTimeout.clear();
    if (firstOutcome === "timeout") {
      shutdownLog.warn(
        `restart session marker did not settle within ${RESTART_MARKER_SLOW_WARNING_MS}ms; waiting before shutdown`,
      );
      recordShutdownWarning(params.warnings, "restart-main-session-marker");
      const delayedOutcome = await markerOutcome;
      if (delayedOutcome.status === "failed") {
        throw delayedOutcome.error;
      }
    } else if (firstOutcome.status === "failed") {
      throw firstOutcome.error;
    }
    for (const run of refs.activeRuns) {
      params.restartRecoveryCandidates?.delete(run.runId);
    }
  } catch (err) {
    shutdownLog.warn(`failed to mark active main session(s) for restart recovery: ${String(err)}`);
    recordShutdownWarning(params.warnings, "restart-main-session-marker");
  }
}

/** Abort active chat runs that did not drain before restart shutdown. */
function abortActiveRunsForRestart(params: RestartRunAbortParams): number {
  let aborted = 0;
  for (const [runId, entry] of listUnabortedRestartRuns(params.chatAbortControllers)) {
    if (!isChatAbortControllerEntryAbortable(entry)) {
      continue;
    }
    if (entry.projectSessionActive === false) {
      entry.abortStopReason = "restart";
      entry.controller.abort(createAgentRunRestartAbortError());
      removeChatAbortControllerEntry(params.chatAbortControllers, runId, entry);
      params.chatRunState.abortedRuns.set(runId, createChatAbortMarker());
      params.chatRunState.clearRun(runId);
      const removed = params.removeChatRun(runId, runId, entry.sessionKey);
      params.agentRunSeq.delete(runId);
      if (removed?.clientRunId) {
        params.agentRunSeq.delete(removed.clientRunId);
      }
      aborted += 1;
      continue;
    }
    const result = abortTrackedChatRunById(
      { ...params, chatRunBuffers: params.chatRunState.buffers },
      {
        runId,
        sessionKey: entry.sessionKey,
        stopReason: "restart",
      },
    );
    if (result.aborted) {
      aborted += 1;
    }
  }
  return aborted;
}

/** Abort queued owners before active teardown can promote them into the closing runtime. */
function abortQueuedTurnsForRestart(params: RestartRunAbortParams): number {
  const matches = Array.from(params.chatQueuedTurns, ([runId, entry]) => ({ runId, entry }));
  return abortQueuedChatTurns(params.chatQueuedTurns, matches, "restart").length;
}

/** Drain or abort pending reply work before restart shutdown proceeds. */
async function drainRestartPendingRepliesForShutdown(
  params: {
    getPendingReplyCount: () => number;
    timeoutMs: number;
    warnings: string[];
  } & RestartRunAbortParams,
): Promise<void> {
  const initialCounts = getRestartReplyDrainCounts(params);
  if (
    initialCounts.pendingReplies <= 0 &&
    initialCounts.activeRuns <= 0 &&
    initialCounts.queuedTurns <= 0
  ) {
    abortQueuedTurnsForRestart(params);
    await markActiveRunsForRestartRecovery({
      ...params,
      reason: "gateway restart shutdown",
    });
    abortActiveRunsForRestart(params);
    return;
  }

  const timeoutMs = Math.max(0, Math.floor(params.timeoutMs));
  if (timeoutMs > 0) {
    shutdownLog.info(
      `waiting for ${formatRestartReplyDrainDetails(initialCounts)} before restart shutdown (timeout ${timeoutMs}ms)`,
    );
  }

  const drainResult = await waitForRestartReplyDrain({
    getPendingReplyCount: params.getPendingReplyCount,
    chatAbortControllers: params.chatAbortControllers,
    chatQueuedTurns: params.chatQueuedTurns,
    timeoutMs,
  });
  if (drainResult.drained) {
    abortQueuedTurnsForRestart(params);
    await markActiveRunsForRestartRecovery({
      ...params,
      reason: "gateway restart shutdown",
    });
    abortActiveRunsForRestart(params);
    shutdownLog.info(`restart reply drain completed after ${drainResult.elapsedMs}ms`);
    return;
  }

  shutdownLog.warn(
    `restart reply drain timed out after ${drainResult.elapsedMs}ms with ${formatRestartReplyDrainDetails(drainResult.counts)} still active; continuing shutdown`,
  );
  recordShutdownWarning(params.warnings, "restart-reply-drain");

  const abortedQueuedTurns = abortQueuedTurnsForRestart(params);
  if (abortedQueuedTurns > 0) {
    shutdownLog.warn(`aborted ${abortedQueuedTurns} queued turn(s) during restart shutdown`);
  }

  if (
    drainResult.counts.activeRuns <= 0 &&
    (params.restartRecoveryCandidates?.size ?? 0) === 0 &&
    listRestartRecoveryRuns(params.chatAbortControllers).length === 0
  ) {
    return;
  }

  await markActiveRunsForRestartRecovery({
    ...params,
    reason: "gateway restart shutdown",
  });
  const abortedRuns = abortActiveRunsForRestart(params);
  if (abortedRuns <= 0) {
    return;
  }

  shutdownLog.warn(`aborted ${abortedRuns} active run(s) during restart shutdown`);
  const postAbortDrain = await waitForRestartReplyDrain({
    getPendingReplyCount: params.getPendingReplyCount,
    chatAbortControllers: params.chatAbortControllers,
    chatQueuedTurns: params.chatQueuedTurns,
    timeoutMs: RESTART_REPLY_POST_ABORT_DRAIN_TIMEOUT_MS,
    pollMs: RESTART_REPLY_POST_ABORT_DRAIN_POLL_MS,
  });
  if (postAbortDrain.drained) {
    shutdownLog.info("restart reply drain completed after abort cleanup");
  }
}

async function triggerGatewayLifecycleHookWithTimeout(params: {
  event: ReturnType<typeof createInternalHookEvent>;
  hookName: "gateway:shutdown" | "gateway:pre-restart";
  timeoutMs: number;
}): Promise<"completed" | "timeout"> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const hookPromise = triggerInternalHook(params.event);
  void hookPromise.catch(() => undefined);
  try {
    const result = await Promise.race([
      hookPromise.then(() => "completed" as const),
      new Promise<"timeout">((resolve) => {
        timeout = setTimeout(() => resolve("timeout"), params.timeoutMs);
        timeout.unref?.();
      }),
    ]);
    if (result === "timeout") {
      shutdownLog.warn(
        `${params.hookName} hook timed out after ${params.timeoutMs}ms; continuing shutdown`,
      );
    }
    return result;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function disposeRuntimeWithShutdownGrace(params: {
  label: "bundle-mcp" | "bundle-lsp";
  dispose: () => Promise<void>;
  graceMs: number;
  warnings: string[];
}): Promise<void> {
  const disposePromise = Promise.resolve()
    .then(params.dispose)
    .catch((err: unknown) => {
      shutdownLog.warn(`${params.label} runtime disposal failed during shutdown: ${String(err)}`);
      recordShutdownWarning(params.warnings, params.label);
    });
  const disposeTimeout = createTimeoutRace(params.graceMs, () => {
    shutdownLog.warn(
      `${params.label} runtime disposal exceeded ${params.graceMs}ms; continuing shutdown`,
    );
    recordShutdownWarning(params.warnings, params.label);
  });
  await Promise.race([disposePromise, disposeTimeout.promise]);
  disposeTimeout.clear();
}

async function disposeAllBundleLspRuntimesOnDemand(): Promise<void> {
  const { disposeAllBundleLspRuntimes } = await import("../agents/agent-bundle-lsp-runtime.js");
  await disposeAllBundleLspRuntimes();
}

async function stopGmailWatcherOnDemand(): Promise<void> {
  const { stopGmailWatcher } = await import("../hooks/gmail-watcher.js");
  await stopGmailWatcher();
}

export async function runGatewayClosePrelude(params: {
  stopDiagnostics?: () => void;
  clearSkillsRefreshTimer?: () => void;
  skillsChangeUnsub?: () => void;
  disposeAuthRateLimiter?: () => void;
  disposeBrowserAuthRateLimiter: () => void;
  stopModelPricingRefresh?: () => void;
  stopChannelHealthMonitor?: () => Promise<void>;
  stopReadinessEventLoopHealth?: () => void;
  clearSecretsRuntimeSnapshot?: () => void;
  closeMcpServer?: () => Promise<void>;
}): Promise<void> {
  params.stopDiagnostics?.();
  params.clearSkillsRefreshTimer?.();
  params.skillsChangeUnsub?.();
  params.disposeAuthRateLimiter?.();
  params.disposeBrowserAuthRateLimiter();
  params.stopModelPricingRefresh?.();
  await params.stopChannelHealthMonitor?.();
  params.stopReadinessEventLoopHealth?.();
  params.clearSecretsRuntimeSnapshot?.();
  await params.closeMcpServer?.().catch(() => {});
}

function isServerNotRunningError(err: unknown): boolean {
  return Boolean(
    err &&
    typeof err === "object" &&
    "code" in err &&
    (err as { code?: unknown }).code === "ERR_SERVER_NOT_RUNNING",
  );
}

async function waitForHttpClose(params: {
  closePromise: Promise<void>;
  timeoutMs: number;
  label: string;
  warnings: string[];
}): Promise<boolean> {
  const timeout = createTimeoutRace(params.timeoutMs, () => false as const);
  try {
    return await Promise.race([
      params.closePromise.then(
        () => true,
        (err: unknown) => {
          throw err;
        },
      ),
      timeout.promise,
    ]).catch((err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err);
      shutdownLog.warn(`${params.label}: ${detail}`);
      recordShutdownWarning(params.warnings, params.label);
      return true;
    });
  } finally {
    timeout.clear();
  }
}

export function createGatewayCloseHandler(
  params: {
    bonjourStop: (() => Promise<void>) | null;
    tailscaleCleanup: (() => Promise<void>) | null;
    releasePluginRouteRegistry?: (() => void) | null;
    channelIds?: readonly ChannelId[];
    stopChannel: (name: ChannelId, accountId?: string) => Promise<void>;
    pluginServices: PluginServicesHandle | null;
    postReadySidecars?: readonly GatewayPostReadySidecarHandle[];
    disposeSessionMcpRuntimes?: () => Promise<void>;
    disposeBundleLspRuntimes?: () => Promise<void>;
    cron: { stop: () => void; stopAndDrain?: () => Promise<void> };
    heartbeatRunner: HeartbeatRunner;
    updateCheckStop?: (() => void) | null;
    stopTaskRegistryMaintenance?: (() => Promise<void> | void) | null;
    nodePresenceTimers: Map<string, ReturnType<typeof setInterval>>;
    tickInterval: ReturnType<typeof setInterval>;
    healthInterval: ReturnType<typeof setInterval>;
    dedupeCleanup: ReturnType<typeof setInterval>;
    mediaCleanup: ReturnType<typeof setInterval> | null;
    worktreeCleanup: ReturnType<typeof setInterval> | null;
    skillCuratorCleanup: () => void;
    agentUnsub: (() => Promise<void> | void) | null;
    heartbeatUnsub: (() => void) | null;
    transcriptUnsub: (() => void) | null;
    lifecycleUnsub: (() => void) | null;
    taskUnsub: (() => void) | null;
    getPendingReplyCount?: () => number;
    clients: Set<{
      connectionKind?: "gateway" | "worker";
      socket: { close: (code: number, reason: string) => void };
    }>;
    configReloader: { stop: () => Promise<void> };
    wss: WebSocketServer;
    httpServer: HttpServer;
    httpServers?: HttpServer[];
    drainActiveSessionsForShutdown?: (params: {
      reason: "shutdown" | "restart";
      totalTimeoutMs?: number;
    }) => Promise<{ emittedSessionIds: string[]; timedOut: boolean }>;
    // Test seam: vitest workers replace this with a no-op so the watchdog
    // cannot exit the worker mid-suite. Production callers leave it undefined
    // so the canonical `armGatewayPostShutdownExitWatchdog` runs.
    armPostShutdownExitWatchdog?: (opts: {
      reason: string;
      shutdownDurationMs: number;
    }) => { cancel: () => void } | null;
  } & RestartRunAbortParams,
) {
  return async (opts?: {
    reason?: string;
    restartExpectedMs?: number | null;
    drainTimeoutMs?: number | null;
  }): Promise<ShutdownResult> => {
    const start = Date.now();
    const warnings: string[] = [];
    const reasonRaw = normalizeOptionalString(opts?.reason) ?? "";
    const reason = reasonRaw || "gateway stopping";
    const restartExpectedMs =
      typeof opts?.restartExpectedMs === "number" && Number.isFinite(opts.restartExpectedMs)
        ? Math.max(0, Math.floor(opts.restartExpectedMs))
        : null;
    const measureCloseStep = <T>(name: string, run: () => Promise<T> | T) =>
      measureGatewayRestartTrace(`restart.close.${name}`, run, [["reason", reason]]);
    // Flip the shutdown flag before any await so /healthz starts returning 503
    // immediately. Lock-recovery preflight uses that 503 to distinguish "live"
    // gateway from a zombie that still holds the port.
    markGatewayShuttingDown();
    try {
      // Fence lane auto-resume timers before the first awaited shutdown step;
      // later teardown can stall long enough for a TTL callback to mutate queues.
      clearSessionSuspensionTimers();
      // Debug-level: the signal handler already announced the stop/restart at
      // info, and the completion line below reports duration and outcome.
      shutdownLog.debug(`shutdown started: ${reason}`);

      await measureCloseStep("config-reloader", () =>
        shutdownStep("config-reloader", () => params.configReloader.stop(), warnings),
      );
      await measureCloseStep("gateway-shutdown-hook", () =>
        shutdownStep(
          "gateway:shutdown",
          async () => {
            const shutdownEvent = createInternalHookEvent(
              "gateway",
              "shutdown",
              "gateway:shutdown",
              {
                reason,
                restartExpectedMs,
              },
            );
            const result = await triggerGatewayLifecycleHookWithTimeout({
              event: shutdownEvent,
              hookName: "gateway:shutdown",
              timeoutMs: GATEWAY_SHUTDOWN_HOOK_TIMEOUT_MS,
            });
            if (result === "timeout") {
              recordShutdownWarning(warnings, "gateway:shutdown");
            }
          },
          warnings,
        ),
      );
      if (restartExpectedMs !== null) {
        await measureCloseStep("gateway-pre-restart-hook", () =>
          shutdownStep(
            "gateway:pre-restart",
            async () => {
              const preRestartEvent = createInternalHookEvent(
                "gateway",
                "pre-restart",
                "gateway:pre-restart",
                {
                  reason,
                  restartExpectedMs,
                },
              );
              const result = await triggerGatewayLifecycleHookWithTimeout({
                event: preRestartEvent,
                hookName: "gateway:pre-restart",
                timeoutMs: GATEWAY_PRE_RESTART_HOOK_TIMEOUT_MS,
              });
              if (result === "timeout") {
                recordShutdownWarning(warnings, "gateway:pre-restart");
              }
            },
            warnings,
          ),
        );
      }
      if (restartExpectedMs !== null && params.getPendingReplyCount) {
        const drainTimeoutMs =
          typeof opts?.drainTimeoutMs === "number" && Number.isFinite(opts.drainTimeoutMs)
            ? Math.max(0, Math.floor(opts.drainTimeoutMs))
            : 0;
        await measureCloseStep("reply-drain", () =>
          shutdownStep(
            "restart-reply-drain",
            () =>
              drainRestartPendingRepliesForShutdown({
                getPendingReplyCount: params.getPendingReplyCount!,
                chatAbortControllers: params.chatAbortControllers,
                chatQueuedTurns: params.chatQueuedTurns,
                restartRecoveryCandidates: params.restartRecoveryCandidates,
                chatRunState: params.chatRunState,
                removeChatRun: params.removeChatRun,
                agentRunSeq: params.agentRunSeq,
                broadcast: params.broadcast,
                nodeSendToSession: params.nodeSendToSession,
                markMainSessionsAbortedForRestart: params.markMainSessionsAbortedForRestart,
                resolveActiveSessionIdForKey: params.resolveActiveSessionIdForKey,
                timeoutMs: drainTimeoutMs,
                warnings,
              }),
            warnings,
          ),
        );
      }
      if (params.drainActiveSessionsForShutdown) {
        await measureCloseStep("session-end-drain", () =>
          shutdownStep(
            "session-end-drain",
            async () => {
              const drainReason: "shutdown" | "restart" =
                restartExpectedMs !== null ? "restart" : "shutdown";
              const result = await params.drainActiveSessionsForShutdown!({
                reason: drainReason,
                totalTimeoutMs: ACTIVE_SESSIONS_SHUTDOWN_DRAIN_TIMEOUT_MS,
              });
              if (result.timedOut) {
                shutdownLog.warn(
                  `session-end-drain timed out after ${ACTIVE_SESSIONS_SHUTDOWN_DRAIN_TIMEOUT_MS}ms after ${result.emittedSessionIds.length} sessions; continuing shutdown`,
                );
                recordShutdownWarning(warnings, "session-end-drain");
              }
            },
            warnings,
          ),
        );
      }
      if (params.bonjourStop) {
        await shutdownStep("bonjour", () => params.bonjourStop!(), warnings);
      }
      if (params.tailscaleCleanup) {
        await shutdownStep("tailscale", () => params.tailscaleCleanup!(), warnings);
      }
      if (params.postReadySidecars?.length) {
        await measureCloseStep("post-ready-sidecars", async () => {
          for (const [index, sidecar] of params.postReadySidecars!.entries()) {
            await shutdownStep(`post-ready-sidecar/${index}`, () => sidecar.stop(), warnings);
          }
        });
      }
      if (params.pluginServices) {
        await measureCloseStep("plugin-services", () =>
          shutdownStep("plugin-services", () => params.pluginServices!.stop(), warnings),
        );
      }
      await measureCloseStep("channels", async () => {
        const channelIds = params.channelIds ?? listChannelPlugins().map((plugin) => plugin.id);
        for (const channelId of channelIds) {
          await shutdownStep(`channel/${channelId}`, () => params.stopChannel(channelId), warnings);
        }
      });
      await shutdownStep("agent-harnesses", () => disposeRegisteredAgentHarnesses(), warnings);
      await measureCloseStep("bundle-runtimes", async () => {
        await Promise.all([
          disposeRuntimeWithShutdownGrace({
            label: "bundle-mcp",
            dispose: params.disposeSessionMcpRuntimes ?? disposeAllSessionMcpRuntimes,
            graceMs: MCP_RUNTIME_CLOSE_GRACE_MS,
            warnings,
          }),
          disposeRuntimeWithShutdownGrace({
            label: "bundle-lsp",
            dispose: params.disposeBundleLspRuntimes ?? disposeAllBundleLspRuntimesOnDemand,
            graceMs: LSP_RUNTIME_CLOSE_GRACE_MS,
            warnings,
          }),
        ]);
      });
      await shutdownStep("plugin-state-store", () => closePluginStateDatabase(), warnings);
      await measureCloseStep("gmail-watcher", () =>
        shutdownStep("gmail-watcher", () => stopGmailWatcherOnDemand(), warnings),
      );
      if (params.cron.stopAndDrain) {
        await params.cron.stopAndDrain();
      } else {
        params.cron.stop();
      }
      params.heartbeatRunner.stop();
      await shutdownStep(
        "task-registry-maintenance",
        () => params.stopTaskRegistryMaintenance?.(),
        warnings,
      );
      await shutdownStep("update-check", () => params.updateCheckStop?.(), warnings);
      for (const timer of params.nodePresenceTimers.values()) {
        clearInterval(timer);
      }
      params.nodePresenceTimers.clear();
      params.broadcast("shutdown", {
        reason,
        restartExpectedMs,
      });
      clearInterval(params.tickInterval);
      clearInterval(params.healthInterval);
      clearInterval(params.dedupeCleanup);
      if (params.mediaCleanup) {
        clearInterval(params.mediaCleanup);
      }
      if (params.worktreeCleanup) {
        clearInterval(params.worktreeCleanup);
      }
      params.skillCuratorCleanup();
      if (params.agentUnsub) {
        await shutdownStep("agent-unsub", () => params.agentUnsub!(), warnings);
      }
      if (params.heartbeatUnsub) {
        await shutdownStep("heartbeat-unsub", () => params.heartbeatUnsub!(), warnings);
      }
      if (params.transcriptUnsub) {
        await shutdownStep("transcript-unsub", () => params.transcriptUnsub!(), warnings);
      }
      if (params.lifecycleUnsub) {
        await shutdownStep("lifecycle-unsub", () => params.lifecycleUnsub!(), warnings);
      }
      if (params.taskUnsub) {
        await shutdownStep("task-unsub", () => params.taskUnsub!(), warnings);
      }
      params.chatRunState.clear();
      let clientCloseFailures = 0;
      for (const c of params.clients) {
        try {
          c.socket.close(
            1012,
            c.connectionKind === "worker" ? "gateway-shutdown" : "service restart",
          );
        } catch {
          clientCloseFailures++;
        }
      }
      if (clientCloseFailures > 0) {
        shutdownLog.warn(`failed to close ${clientCloseFailures} WebSocket client(s)`);
        recordShutdownWarning(warnings, "ws-clients");
      }
      params.clients.clear();
      await measureCloseStep("websocket-server", async () => {
        const wsClients = params.wss.clients ?? new Set();
        const closePromise = new Promise<void>((resolve) => {
          params.wss.close(() => resolve());
        });
        const websocketGraceTimeout = createTimeoutRace(
          WEBSOCKET_CLOSE_GRACE_MS,
          () => false as const,
        );
        const closedWithinGrace = await Promise.race([
          closePromise.then(() => true),
          websocketGraceTimeout.promise,
        ]);
        websocketGraceTimeout.clear();
        if (!closedWithinGrace) {
          shutdownLog.warn(
            `websocket server close exceeded ${WEBSOCKET_CLOSE_GRACE_MS}ms; forcing shutdown continuation with ${wsClients.size} tracked client(s)`,
          );
          recordShutdownWarning(warnings, "websocket-server");
          for (const client of wsClients) {
            try {
              client.terminate();
            } catch {
              /* ignore */
            }
          }
          const websocketForceTimeout = createTimeoutRace(WEBSOCKET_CLOSE_FORCE_CONTINUE_MS, () => {
            shutdownLog.warn(
              `websocket server close still pending after ${WEBSOCKET_CLOSE_FORCE_CONTINUE_MS}ms force window; continuing shutdown`,
            );
          });
          await Promise.race([closePromise, websocketForceTimeout.promise]);
          websocketForceTimeout.clear();
        }
      });
      await measureCloseStep("http-server", async () => {
        const servers =
          params.httpServers && params.httpServers.length > 0
            ? params.httpServers
            : [params.httpServer];
        for (let i = 0; i < servers.length; i++) {
          const httpServer = servers[i] as HttpServer & {
            closeAllConnections?: () => void;
            closeIdleConnections?: () => void;
          };
          const label = servers.length > 1 ? `http-server[${i}]` : "http-server";
          if (typeof httpServer.closeIdleConnections === "function") {
            httpServer.closeIdleConnections();
          }
          const closePromise = new Promise<void>((resolve, reject) => {
            httpServer.close((err) => {
              if (!err || isServerNotRunningError(err)) {
                resolve();
                return;
              }
              reject(err);
            });
          });
          void closePromise.catch(() => undefined);
          const closedWithinGrace = await waitForHttpClose({
            closePromise,
            timeoutMs: HTTP_CLOSE_GRACE_MS,
            label,
            warnings,
          });
          if (!closedWithinGrace) {
            shutdownLog.warn(
              `${label} close exceeded ${HTTP_CLOSE_GRACE_MS}ms; forcing connection shutdown and waiting for close`,
            );
            recordShutdownWarning(warnings, label);
            httpServer.closeAllConnections?.();
            const closedAfterForce = await waitForHttpClose({
              closePromise,
              timeoutMs: HTTP_CLOSE_FORCE_WAIT_MS,
              label,
              warnings,
            });
            if (!closedAfterForce) {
              throw new Error(
                `${label} close still pending after forced connection shutdown (${HTTP_CLOSE_FORCE_WAIT_MS}ms)`,
              );
            }
          }
        }
      });
    } finally {
      try {
        params.releasePluginRouteRegistry?.();
      } catch {
        /* ignore */
      }
    }

    const durationMs = Date.now() - start;
    if (warnings.length > 0) {
      shutdownLog.warn(
        `shutdown completed in ${durationMs}ms with warnings: ${warnings.join(", ")}`,
      );
    } else {
      shutdownLog.info(`shutdown completed cleanly in ${durationMs}ms`);
    }

    recordGatewayRestartTrace("restart.close.total", durationMs, [
      ["reason", reason],
      ["restartExpectedMs", restartExpectedMs ?? "none"],
      ...collectGatewayProcessMemoryUsageMb(),
    ]);
    // Arm a process-wide watchdog so a stray handle cannot keep the node
    // process (and its HTTP listener) alive after every owned subsystem has
    // closed. The unref'd timer is a no-op when natural exit wins, and exits
    // with the canonical zombie warn + trace event when it does not.
    const armWatchdog = params.armPostShutdownExitWatchdog ?? armGatewayPostShutdownExitWatchdog;
    armWatchdog({ reason, shutdownDurationMs: durationMs });
    return { durationMs, warnings };
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
