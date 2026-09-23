// Agent job tracking owns terminal run state and `agent.wait` resolution.
// Gateway dedupe retains response payloads only for idempotent RPC replay.
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { readNonBlankString } from "@openclaw/normalization-core/string-coerce";
import { normalizeAgentRunTerminalDeliverySnapshot } from "../../agents/agent-run-terminal-delivery.js";
import {
  AGENT_RUN_TERMINAL_RETRY_GRACE_MS,
  buildAgentRunTerminalOutcome,
  buildAgentRunTerminalOutcomeFromLifecycleEvent,
  hasExecutionSettlement,
  isStickyAgentRunTerminalOutcome,
  mergeAgentRunTerminalOutcome,
  type AgentRunTerminalOutcome,
} from "../../agents/agent-run-terminal-outcome.js";
import { normalizeAgentRunTerminalReceipt } from "../../agents/agent-run-terminal-receipt.js";
import {
  mergeAgentRunTerminalReplySnapshot,
  normalizeAgentRunTerminalReplySnapshot,
} from "../../agents/agent-run-terminal-reply.js";
import { onAgentEvent, type AgentEventPayload } from "../../infra/agent-events.js";
import { getAgentRunLifecycleGeneration } from "../../infra/agent-run-registry.js";
import { formatErrorMessageForDisplay } from "../../infra/error-diagnostics.js";
import { isNonTerminalAgentRunStatus } from "../../shared/agent-run-status.js";
import { getAsyncWorkSignal } from "../../shared/async-work-scope.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { setSafeTimeout } from "../../utils/timer-delay.js";
import type { DedupeEntry } from "../server-shared.js";
import type { AgentJobObservation, AgentJobSession, AgentJobTerminalSnapshot } from "./types.js";

const AGENT_RUN_CACHE_TTL_MS = 10 * 60_000;
const AGENT_RUN_CACHE_MAX_ENTRIES = 5_000;

type AgentJobSource = "agent" | "chat" | "lifecycle";
type AgentRunObservation = AgentJobTerminalSnapshot & {
  session?: AgentJobSession;
  runId: string;
  source: AgentJobSource;
  recordedAt: number;
  version: number;
};
type AgentRunSnapshot = AgentRunObservation & { cachedAt: number };
type PendingAgentRunTerminal = {
  snapshot: AgentRunObservation;
  timer?: NodeJS.Timeout;
};
type AgentJobRecord = {
  cachedAt: number;
  snapshotsBySource: Map<AgentJobSource, AgentRunSnapshot>;
};
type AgentJobWaiter = (lifecycleReset?: boolean) => void;
type DedupeObservation =
  | { state: "active" }
  | { state: "terminal"; snapshot: AgentJobTerminalSnapshot }
  | { state: "untracked" };

type AgentJobState = {
  jobs: Map<string, AgentJobRecord>;
  oldestCachedAt: number;
  runStarts: Map<string, number>;
  pendingErrors: Map<string, PendingAgentRunTerminal>;
  pendingTimeouts: Map<string, PendingAgentRunTerminal>;
  waiters: Map<string, Set<AgentJobWaiter>>;
  version: number;
};

const agentJobState = resolveGlobalSingleton<AgentJobState>(
  Symbol.for("openclaw.agentJobState"),
  () => ({
    jobs: new Map(),
    oldestCachedAt: Infinity,
    runStarts: new Map(),
    pendingErrors: new Map(),
    pendingTimeouts: new Map(),
    waiters: new Map(),
    version: 0,
  }),
  (state) => {
    for (const pending of state.pendingErrors.values()) {
      clearTimeout(pending.timer);
    }
    for (const pending of state.pendingTimeouts.values()) {
      clearTimeout(pending.timer);
    }
    state.jobs.clear();
    state.oldestCachedAt = Infinity;
    state.runStarts.clear();
    state.pendingErrors.clear();
    state.pendingTimeouts.clear();
    const waiters = Array.from(state.waiters.values()).flatMap((entries) => Array.from(entries));
    state.waiters.clear();
    for (const waiter of waiters) {
      waiter(true);
    }
  },
);
const agentJobs = agentJobState.jobs;
const agentRunStarts = agentJobState.runStarts;
const pendingAgentRunErrors = agentJobState.pendingErrors;
const pendingAgentRunTimeouts = agentJobState.pendingTimeouts;
const agentRunWaiters = agentJobState.waiters;
let agentRunListenerStarted = false;

export function captureAgentJobSession(
  routing:
    | Pick<AgentEventPayload, "sessionKey" | "sessionId" | "agentId" | "lifecycleGeneration">
    | undefined,
): AgentJobSession | undefined {
  if (!routing?.sessionKey || !routing.sessionId || !routing.lifecycleGeneration) {
    return undefined;
  }
  return {
    sessionKey: routing.sessionKey,
    sessionId: routing.sessionId,
    agentId: routing.agentId,
    lifecycleGeneration: routing.lifecycleGeneration,
  };
}

/** Retained routing locates a current sharing check; it never keeps execution authority alive. */
export function getAgentJobSession(
  runId: string,
  source?: "chat",
): Readonly<AgentJobSession> | undefined {
  pruneAgentRunCache();
  const job = agentJobs.get(runId);
  const session =
    (job && getCanonicalAgentRunSnapshot(job.snapshotsBySource, source)?.session) ??
    (source
      ? undefined
      : (pendingAgentRunErrors.get(runId)?.snapshot.session ??
        pendingAgentRunTimeouts.get(runId)?.snapshot.session));
  return session?.lifecycleGeneration === getAgentRunLifecycleGeneration() ? session : undefined;
}

function nextAgentRunVersion(): number {
  agentJobState.version += 1;
  return agentJobState.version;
}

function pruneAgentRunCache(now = Date.now()) {
  if (now - agentJobState.oldestCachedAt <= AGENT_RUN_CACHE_TTL_MS) {
    return;
  }
  let oldestCachedAt = Infinity;
  for (const [runId, job] of agentJobs) {
    if (now - job.cachedAt <= AGENT_RUN_CACHE_TTL_MS) {
      oldestCachedAt = Math.min(oldestCachedAt, job.cachedAt);
      continue;
    }
    agentJobs.delete(runId);
  }
  agentJobState.oldestCachedAt = oldestCachedAt;
}

function enforceAgentRunCacheMaxEntries() {
  if (agentJobs.size <= AGENT_RUN_CACHE_MAX_ENTRIES) {
    return;
  }
  const toRemove = agentJobs.size - AGENT_RUN_CACHE_MAX_ENTRIES;
  let removed = 0;
  for (const runId of agentJobs.keys()) {
    if (removed >= toRemove) {
      break;
    }
    if ((agentRunWaiters.get(runId)?.size ?? 0) > 0) {
      continue;
    }
    agentJobs.delete(runId);
    removed += 1;
  }
}

function terminalOutcomeFromSnapshot(
  snapshot: AgentJobTerminalSnapshot,
): AgentRunTerminalOutcome | undefined {
  if (snapshot.pendingError) {
    return undefined;
  }
  return buildAgentRunTerminalOutcome(snapshot);
}

function shouldPreserveTerminalSnapshot(
  existing: AgentJobTerminalSnapshot,
  incoming: AgentJobTerminalSnapshot,
): boolean {
  const existingOutcome = terminalOutcomeFromSnapshot(existing);
  const incomingOutcome = terminalOutcomeFromSnapshot(incoming);
  if (!existingOutcome || !incomingOutcome) {
    return false;
  }
  return mergeAgentRunTerminalOutcome(existingOutcome, incomingOutcome) === existingOutcome;
}

function mergeSnapshot(
  existing: AgentRunSnapshot | undefined,
  incoming: AgentRunSnapshot,
): AgentRunSnapshot {
  if (!existing) {
    return incoming;
  }
  const canonical = shouldPreserveTerminalSnapshot(existing, incoming) ? existing : incoming;
  const sameSession =
    existing.session?.sessionKey === incoming.session?.sessionKey &&
    existing.session?.sessionId === incoming.session?.sessionId &&
    existing.session?.agentId === incoming.session?.agentId &&
    existing.session?.lifecycleGeneration === incoming.session?.lifecycleGeneration;
  if (!sameSession) {
    return canonical;
  }
  const terminalReply = mergeAgentRunTerminalReplySnapshot(
    existing.terminalReply,
    incoming.terminalReply,
  );
  const terminalDelivery = incoming.terminalDelivery ?? existing.terminalDelivery;
  const terminalReceipt = incoming.terminalReceipt ?? existing.terminalReceipt;
  // Terminal status precedence and producer reply evidence are independent;
  // a late sticky timeout must not erase the final reply (or vice versa).
  return {
    ...canonical,
    ...(terminalDelivery ? { terminalDelivery } : {}),
    ...(terminalReceipt ? { terminalReceipt } : {}),
    ...(terminalReply ? { terminalReply } : {}),
    cachedAt: incoming.cachedAt,
    recordedAt: incoming.recordedAt,
    version: incoming.version,
  };
}

function recordAgentRunSnapshot(
  snapshot: Omit<AgentRunObservation, "version">,
  version = nextAgentRunVersion(),
) {
  const entry = { ...snapshot, cachedAt: Date.now(), version };
  pruneAgentRunCache(entry.cachedAt);

  const existing = agentJobs.get(entry.runId);
  const snapshotsBySource =
    existing?.snapshotsBySource ?? new Map<AgentJobSource, AgentRunSnapshot>();
  const sourceSnapshot = mergeSnapshot(snapshotsBySource.get(entry.source), entry);
  snapshotsBySource.set(entry.source, sourceSnapshot);
  agentJobs.set(entry.runId, {
    cachedAt: entry.cachedAt,
    snapshotsBySource,
  });
  // A lower bound remains safe when a write refreshes or eviction removes the oldest job.
  // Recompute only once that bound can expire, without changing insertion-order eviction.
  agentJobState.oldestCachedAt = Math.min(agentJobState.oldestCachedAt, entry.cachedAt);
  enforceAgentRunCacheMaxEntries();
  for (const waiter of agentRunWaiters.get(entry.runId) ?? []) {
    waiter();
  }
}

function clearPendingAgentRunTerminals(runId: string) {
  for (const pendingRuns of [pendingAgentRunErrors, pendingAgentRunTimeouts]) {
    const pending = pendingRuns.get(runId);
    if (pending) {
      clearTimeout(pending.timer);
      pendingRuns.delete(runId);
    }
  }
}

function beginAgentJob(runId: string, startedAt?: number) {
  nextAgentRunVersion();
  clearPendingAgentRunTerminals(runId);
  agentJobs.delete(runId);
  if (startedAt !== undefined) {
    agentRunStarts.set(runId, startedAt);
  }
}

function mergePendingAgentRunTerminal(snapshot: AgentRunObservation): AgentRunObservation {
  // Phase-owned pending maps can both contain sticky cancellations or hard timeouts.
  return [pendingAgentRunErrors, pendingAgentRunTimeouts].reduce((current, pendingRuns) => {
    const pending = pendingRuns.get(snapshot.runId)?.snapshot;
    return pending && shouldPreserveTerminalSnapshot(pending, current) ? pending : current;
  }, snapshot);
}

function schedulePendingAgentRunTerminal(
  pendingRuns: Map<string, PendingAgentRunTerminal>,
  snapshot: AgentRunObservation,
) {
  const terminalSnapshot = mergePendingAgentRunTerminal(snapshot);
  if (terminalSnapshot !== snapshot) {
    // Keep its original retry deadline while exposing the newer event to fresh waiters.
    terminalSnapshot.version = snapshot.version;
    return;
  }
  const replacesPendingTimeout = pendingAgentRunTimeouts.has(snapshot.runId);
  clearPendingAgentRunTerminals(snapshot.runId);
  const timer = setSafeTimeout(() => {
    const pending = pendingRuns.get(snapshot.runId);
    if (!pending || pending.timer !== timer) {
      return;
    }
    if (
      pendingRuns === pendingAgentRunErrors &&
      !replacesPendingTimeout &&
      terminalOutcomeFromSnapshot(pending.snapshot)?.reason === "failed" &&
      agentRunWaiters.has(snapshot.runId)
    ) {
      pending.timer = undefined;
      return;
    }
    pendingRuns.delete(snapshot.runId);
    recordAgentRunSnapshot(pending.snapshot, pending.snapshot.version);
  }, AGENT_RUN_TERMINAL_RETRY_GRACE_MS);
  timer.unref?.();
  pendingRuns.set(snapshot.runId, { snapshot, timer });
}

function createPendingErrorTimeoutSnapshot(snapshot: AgentJobObservation): AgentJobObservation {
  return {
    status: "timeout",
    startedAt: snapshot.startedAt,
    error: snapshot.error,
    pendingError: true,
    session: snapshot.session,
    ...(snapshot.providerStarted !== undefined
      ? { providerStarted: snapshot.providerStarted }
      : {}),
    ...(snapshot.terminalDelivery ? { terminalDelivery: snapshot.terminalDelivery } : {}),
  };
}

function createSnapshotFromLifecycleEvent(params: {
  runId: string;
  phase: "end" | "error";
  data?: Record<string, unknown>;
  session?: AgentJobSession;
}): AgentRunObservation {
  const { runId, phase, data } = params;
  const startedAt =
    typeof data?.startedAt === "number" ? data.startedAt : agentRunStarts.get(runId);
  const endedAt = typeof data?.endedAt === "number" ? data.endedAt : undefined;
  const terminalOutcome = buildAgentRunTerminalOutcomeFromLifecycleEvent({
    phase,
    data,
    startedAt,
    endedAt,
  });
  // agent.wait historically treats a bare abort flag as a retryable timeout.
  // Modern explicit stop reasons keep the canonical cancellation projection.
  const legacyBareAbort =
    !hasExecutionSettlement(data) &&
    terminalOutcome.reason === "aborted" &&
    data?.stopReason == null &&
    data?.status == null;
  const terminalDelivery = normalizeAgentRunTerminalDeliverySnapshot(data?.terminalDelivery);
  const terminalReply = normalizeAgentRunTerminalReplySnapshot(data?.terminalReply);
  const normalizedTerminalReceipt = normalizeAgentRunTerminalReceipt(data?.terminalReceipt);
  const terminalReceipt =
    normalizedTerminalReceipt?.runId === runId ? normalizedTerminalReceipt : undefined;
  return {
    runId,
    source: "lifecycle",
    session: params.session,
    recordedAt: Date.now(),
    status: legacyBareAbort ? "timeout" : terminalOutcome.status,
    startedAt,
    endedAt,
    error: legacyBareAbort ? undefined : terminalOutcome.error,
    stopReason: legacyBareAbort ? undefined : terminalOutcome.stopReason,
    livenessState: terminalOutcome.livenessState,
    ...(data?.yielded === true ? { yielded: true } : {}),
    ...(terminalOutcome.timeoutPhase ? { timeoutPhase: terminalOutcome.timeoutPhase } : {}),
    ...(terminalOutcome.providerStarted !== undefined
      ? { providerStarted: terminalOutcome.providerStarted }
      : {}),
    ...(terminalDelivery ? { terminalDelivery } : {}),
    ...(terminalReply ? { terminalReply } : {}),
    ...(terminalReceipt ? { terminalReceipt } : {}),
    version: nextAgentRunVersion(),
  };
}

function ensureAgentRunListener() {
  if (agentRunListenerStarted) {
    return;
  }
  agentRunListenerStarted = true;
  onAgentEvent((evt) => {
    if (!evt || evt.stream !== "lifecycle") {
      return;
    }
    const phase = evt.data?.phase;
    if (phase === "start") {
      const startedAt = typeof evt.data?.startedAt === "number" ? evt.data.startedAt : Date.now();
      beginAgentJob(evt.runId, startedAt);
      return;
    }
    if (phase !== "end" && phase !== "error") {
      return;
    }
    const snapshot = createSnapshotFromLifecycleEvent({
      runId: evt.runId,
      phase,
      data: evt.data,
      session: captureAgentJobSession(evt),
    });
    agentRunStarts.delete(evt.runId);
    const executionSettled = hasExecutionSettlement(evt.data);
    if (!executionSettled && phase === "error" && evt.data?.fallbackExhaustedFailure !== true) {
      schedulePendingAgentRunTerminal(pendingAgentRunErrors, snapshot);
      return;
    }
    if (!executionSettled && phase === "end" && snapshot.status === "timeout") {
      schedulePendingAgentRunTerminal(pendingAgentRunTimeouts, snapshot);
      return;
    }
    const terminalSnapshot = mergePendingAgentRunTerminal(snapshot);
    clearPendingAgentRunTerminals(evt.runId);
    recordAgentRunSnapshot(terminalSnapshot, snapshot.version);
  });
}

function parseDedupeObservation(entry: DedupeEntry): DedupeObservation {
  const payload = asOptionalRecord(entry.payload);
  const status = typeof payload?.status === "string" ? payload.status : undefined;
  if (isNonTerminalAgentRunStatus(status)) {
    return { state: "active" };
  }

  const terminalStatus =
    status === "completed"
      ? "ok"
      : status === "ok" || status === "timeout" || status === "error"
        ? status
        : entry.ok
          ? undefined
          : "error";
  if (!terminalStatus) {
    return { state: "untracked" };
  }

  const resultMeta = asOptionalRecord(asOptionalRecord(payload?.result)?.meta);
  const terminalReply = normalizeAgentRunTerminalReplySnapshot(
    payload?.terminalReply ?? resultMeta?.terminalReply,
  );
  const startedAt = asFiniteNumber(payload?.startedAt);
  const endedAt = asFiniteNumber(payload?.endedAt) ?? entry.ts;
  const stopReason =
    readNonBlankString(payload?.stopReason) ?? readNonBlankString(resultMeta?.stopReason);
  const livenessState =
    readNonBlankString(payload?.livenessState) ?? readNonBlankString(resultMeta?.livenessState);
  const errorMessage =
    typeof payload?.error === "string"
      ? payload.error
      : typeof payload?.summary === "string"
        ? payload.summary
        : entry.error?.message;
  const terminalOutcome = buildAgentRunTerminalOutcome({
    status: terminalStatus,
    startedAt,
    endedAt,
    // RPC errors stay native for retry policy; agent.wait is an operator-facing projection.
    error:
      errorMessage === undefined
        ? undefined
        : formatErrorMessageForDisplay(entry.error, errorMessage),
    stopReason,
    livenessState,
    timeoutPhase: payload?.timeoutPhase ?? resultMeta?.timeoutPhase,
    providerStarted: payload?.providerStarted ?? resultMeta?.providerStarted,
  });
  return {
    state: "terminal",
    snapshot: {
      status: terminalOutcome.status,
      startedAt,
      endedAt,
      error: terminalOutcome.status === "ok" ? undefined : terminalOutcome.error,
      stopReason,
      livenessState,
      ...(payload?.yielded === true || resultMeta?.yielded === true ? { yielded: true } : {}),
      ...(terminalOutcome.timeoutPhase ? { timeoutPhase: terminalOutcome.timeoutPhase } : {}),
      ...(terminalOutcome.providerStarted !== undefined
        ? { providerStarted: terminalOutcome.providerStarted }
        : {}),
      ...(terminalReply ? { terminalReply } : {}),
    },
  };
}

function parseDedupeKey(key: string): { runId: string; source: "agent" | "chat" } | undefined {
  const separator = key.indexOf(":");
  if (separator === -1) {
    return undefined;
  }
  const source = key.slice(0, separator);
  const runId = key.slice(separator + 1);
  if ((source !== "agent" && source !== "chat") || !runId) {
    return undefined;
  }
  return { runId, source };
}

export function setGatewayDedupeEntry(params: {
  dedupe: Map<string, DedupeEntry>;
  key: string;
  entry: DedupeEntry;
  /** Admission owns a new attempt; retain request identity while retiring its old terminal. */
  startNewAttempt?: true;
  session?: Readonly<AgentJobSession>;
}) {
  const existing = params.dedupe.get(params.key);
  const existingObservation = existing ? parseDedupeObservation(existing) : undefined;
  const incomingObservation = parseDedupeObservation(params.entry);
  const existingOutcome =
    existingObservation?.state === "terminal"
      ? terminalOutcomeFromSnapshot(existingObservation.snapshot)
      : undefined;
  const incomingOutcome =
    incomingObservation.state === "terminal"
      ? terminalOutcomeFromSnapshot(incomingObservation.snapshot)
      : undefined;
  if (
    existingOutcome &&
    isStickyAgentRunTerminalOutcome(existingOutcome) &&
    !(params.startNewAttempt && incomingObservation.state === "active") &&
    (!incomingOutcome ||
      mergeAgentRunTerminalOutcome(existingOutcome, incomingOutcome) === existingOutcome)
  ) {
    return;
  }

  // Terminal writers own outcomes, not request identity; never erase the admission binding.
  const entry = existing?.requestIdentity
    ? { ...params.entry, requestIdentity: existing.requestIdentity }
    : params.entry;
  params.dedupe.set(params.key, entry);
  const key = parseDedupeKey(params.key);
  if (!key) {
    return;
  }
  if (incomingObservation.state === "active") {
    beginAgentJob(key.runId);
    return;
  }
  if (incomingObservation.state === "terminal") {
    const lifecycle = agentJobs.get(key.runId)?.snapshotsBySource.get("lifecycle");
    if (
      key.source === "chat" &&
      incomingObservation.snapshot.status === "ok" &&
      lifecycle?.status === "ok" &&
      lifecycle.yielded === true
    ) {
      // Chat completion closes delivery, not the runtime's yielded execution.
      incomingObservation.snapshot.yielded = true;
      incomingObservation.snapshot.livenessState = lifecycle.livenessState;
    }
    recordAgentRunSnapshot({
      ...incomingObservation.snapshot,
      runId: key.runId,
      source: key.source,
      session: params.session ? { ...params.session } : undefined,
      recordedAt: params.entry.ts,
    });
  }
}

function getFreshestDedupeSnapshot(
  snapshotsBySource: Map<AgentJobSource, AgentRunSnapshot>,
): AgentRunSnapshot | undefined {
  const agent = snapshotsBySource.get("agent");
  const chat = snapshotsBySource.get("chat");
  if (agent && chat) {
    // Dedupe source freshness must not bypass the canonical sticky run outcome.
    return chat.recordedAt > agent.recordedAt
      ? mergeSnapshot(agent, chat)
      : mergeSnapshot(chat, agent);
  }
  return agent ?? chat;
}

function getCanonicalAgentRunSnapshot(
  snapshotsBySource: Map<AgentJobSource, AgentRunSnapshot>,
  source?: "agent" | "chat",
): AgentRunSnapshot | undefined {
  const dedupe = source
    ? snapshotsBySource.get(source)
    : getFreshestDedupeSnapshot(snapshotsBySource);
  // RPC completion includes replay publication, after execution and delivery settle.
  // Lifecycle events and another RPC source cannot close that publication barrier.
  if (source && !dedupe) {
    return undefined;
  }
  const lifecycle = snapshotsBySource.get("lifecycle");
  if (!dedupe || !lifecycle) {
    return dedupe ?? lifecycle;
  }
  return dedupe.version > lifecycle.version
    ? mergeSnapshot(lifecycle, dedupe)
    : mergeSnapshot(dedupe, lifecycle);
}

function getAgentRunSnapshot(params: {
  runId: string;
  source?: "agent" | "chat";
  afterVersion: number;
}): AgentRunSnapshot | undefined {
  pruneAgentRunCache();
  const job = agentJobs.get(params.runId);
  const snapshot = job
    ? getCanonicalAgentRunSnapshot(job.snapshotsBySource, params.source)
    : undefined;
  return snapshot && snapshot.version > params.afterVersion ? snapshot : undefined;
}

function addAgentRunWaiter(runId: string, waiter: AgentJobWaiter): () => void {
  const waiters = agentRunWaiters.get(runId) ?? new Set<AgentJobWaiter>();
  waiters.add(waiter);
  agentRunWaiters.set(runId, waiters);
  return () => {
    waiters.delete(waiter);
    if (waiters.size === 0) {
      agentRunWaiters.delete(runId);
      const pendingError = pendingAgentRunErrors.get(runId);
      if (pendingError && !pendingError.timer) {
        pendingAgentRunErrors.delete(runId);
        recordAgentRunSnapshot(pendingError.snapshot, pendingError.snapshot.version);
      }
    }
  };
}

function selectedSnapshot(snapshot: AgentRunObservation): AgentJobObservation {
  return {
    session: snapshot.session,
    status: snapshot.status,
    startedAt: snapshot.startedAt,
    endedAt: snapshot.endedAt,
    error: snapshot.error,
    stopReason: snapshot.stopReason,
    livenessState: snapshot.livenessState,
    yielded: snapshot.yielded,
    pendingError: snapshot.pendingError,
    timeoutPhase: snapshot.timeoutPhase,
    providerStarted: snapshot.providerStarted,
    ...(snapshot.terminalDelivery ? { terminalDelivery: snapshot.terminalDelivery } : {}),
    terminalReceipt: snapshot.terminalReceipt,
    terminalReply: snapshot.terminalReply,
  };
}

export async function waitForAgentJob(params: {
  runId: string;
  timeoutMs: number;
  ignoreCachedSnapshot?: boolean;
  source?: "agent" | "chat";
}): Promise<AgentJobObservation | null> {
  ensureAgentRunListener();
  const afterVersion = params.ignoreCachedSnapshot ? agentJobState.version : -1;
  const cached = getAgentRunSnapshot({
    runId: params.runId,
    source: params.source,
    afterVersion,
  });
  if (cached) {
    return selectedSnapshot(cached);
  }
  const signal = getAsyncWorkSignal();
  if (params.timeoutMs <= 0 || signal?.aborted) {
    return null;
  }

  return await new Promise((resolve) => {
    let settled = false;
    let removeWaiter = () => {};
    const finish = (snapshot: AgentJobObservation | null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutHandle);
      signal?.removeEventListener("abort", onClose);
      removeWaiter();
      resolve(snapshot);
    };
    // Closing this Gateway retires only its observation, never the run or another waiter.
    const onClose = () => finish(null);
    const onWake = (lifecycleReset = false) => {
      if (lifecycleReset) {
        // The lifecycle interrupted this wait; do not cache it as a terminal run outcome.
        finish({ status: "timeout", timeoutPhase: "gateway_draining" });
        return;
      }
      const snapshot = getAgentRunSnapshot({
        runId: params.runId,
        source: params.source,
        afterVersion,
      });
      if (snapshot) {
        finish(selectedSnapshot(snapshot));
      }
    };
    removeWaiter = addAgentRunWaiter(params.runId, onWake);
    const timeoutHandle = setSafeTimeout(() => {
      if (!params.source) {
        const pending = pendingAgentRunErrors.get(params.runId);
        const pendingError = pending?.snapshot;
        if (pendingError && pendingError.version > afterVersion) {
          finish(
            !pending.timer ||
              isStickyAgentRunTerminalOutcome(terminalOutcomeFromSnapshot(pendingError))
              ? selectedSnapshot(pendingError)
              : createPendingErrorTimeoutSnapshot(pendingError),
          );
          return;
        }
        const pendingTimeout = pendingAgentRunTimeouts.get(params.runId)?.snapshot;
        if (
          pendingTimeout &&
          pendingTimeout.version > afterVersion &&
          terminalOutcomeFromSnapshot(pendingTimeout)?.reason === "hard_timeout"
        ) {
          finish(selectedSnapshot(pendingTimeout));
          return;
        }
      }
      finish(null);
    }, params.timeoutMs);
    timeoutHandle.unref?.();
    signal?.addEventListener("abort", onClose, { once: true });
    if (signal?.aborted) {
      onClose();
    } else {
      onWake();
    }
  });
}

ensureAgentRunListener();
