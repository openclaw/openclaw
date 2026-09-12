// Agent job tracking owns terminal run state and `agent.wait` resolution.
// Gateway dedupe retains response payloads only for idempotent RPC replay.
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { readNonBlankString } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  normalizeAgentRunTerminalDeliverySnapshot,
  type AgentRunTerminalDeliverySnapshot,
} from "../../agents/agent-run-terminal-delivery.js";
import {
  AGENT_RUN_TERMINAL_RETRY_GRACE_MS,
  buildAgentRunTerminalOutcome,
  buildAgentRunTerminalOutcomeFromLifecycleEvent,
  hasExecutionSettlement,
  isStickyAgentRunTerminalOutcome,
  mergeAgentRunTerminalOutcome,
  type AgentRunTerminalOutcome,
} from "../../agents/agent-run-terminal-outcome.js";
import {
  AGENT_RUN_TERMINAL_LINK_MAX_ITEMS,
  normalizeAgentRunApprovalReceipts,
  normalizeAgentRunTerminalReceipt,
  type AgentRunApprovalReceipt,
  type AgentRunTerminalReceipt,
} from "../../agents/agent-run-terminal-receipt.js";
import {
  mergeAgentRunTerminalReplySnapshot,
  normalizeAgentRunTerminalReplySnapshot,
  type AgentRunTerminalReplySnapshot,
} from "../../agents/agent-run-terminal-reply.js";
import { onAgentEvent } from "../../infra/agent-events.js";
import { getAgentRunContext } from "../../infra/agent-run-registry.js";
import { formatErrorMessageForDisplay } from "../../infra/error-diagnostics.js";
import { redactSensitiveText } from "../../logging/redact.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { isNonTerminalAgentRunStatus } from "../../shared/agent-run-status.js";
import { getAsyncWorkSignal } from "../../shared/async-work-scope.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { isIncognitoSessionKey } from "../../shared/incognito-session-key.js";
import {
  AgentRunTerminalReceiptValidationError,
  deleteAgentRunTerminalReceipt,
  readAgentRunTerminalReceipt,
  writeAgentRunTerminalReceiptWithResult,
  type AgentRunTerminalReceiptOwner,
} from "../../state/agent-run-terminal-receipts.js";
import { setSafeTimeout } from "../../utils/timer-delay.js";
import type { DedupeEntry } from "../server-shared.js";

const AGENT_RUN_CACHE_TTL_MS = 10 * 60_000;
const AGENT_RUN_CACHE_MAX_ENTRIES = 5_000;

export type AgentJobTerminalSnapshot = {
  status: "ok" | "error" | "timeout";
  /** Internal durable arbitration fact; public projections omit it. */
  executionSettled?: boolean;
  startedAt?: number;
  endedAt?: number;
  error?: string;
  stopReason?: string;
  livenessState?: string;
  yielded?: boolean;
  pendingError?: boolean;
  timeoutPhase?: AgentRunTerminalOutcome["timeoutPhase"];
  providerStarted?: boolean;
  terminalDelivery?: AgentRunTerminalDeliverySnapshot;
  terminalReceipt?: AgentRunTerminalReceipt;
  terminalReply?: AgentRunTerminalReplySnapshot;
};

type AgentJobSource = "agent" | "chat" | "lifecycle";
type AgentRunObservation = AgentJobTerminalSnapshot & {
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

type PendingDurableAgentRunTerminal = {
  snapshot: AgentRunObservation;
  owner: AgentRunTerminalReceiptOwner;
  timer?: NodeJS.Timeout;
};

type AgentRunApprovalReceiptMap = Map<string, AgentRunApprovalReceipt>;
type AgentJobState = {
  jobs: Map<string, AgentJobRecord>;
  runStarts: Map<string, number>;
  pendingErrors: Map<string, PendingAgentRunTerminal>;
  pendingTimeouts: Map<string, PendingAgentRunTerminal>;
  pendingDurableTerminals: Map<string, PendingDurableAgentRunTerminal>;
  runOwners: Map<string, AgentRunTerminalReceiptOwner>;
  durabilityFences: Set<string>;
  approvalReceipts: Map<string, AgentRunApprovalReceiptMap>;
  waiters: Map<string, Set<AgentJobWaiter>>;
  version: number;
};

const agentJobState = resolveGlobalSingleton<AgentJobState>(
  Symbol.for("openclaw.agentJobState"),
  () => ({
    jobs: new Map(),
    runStarts: new Map(),
    pendingErrors: new Map(),
    pendingTimeouts: new Map(),
    pendingDurableTerminals: new Map(),
    runOwners: new Map(),
    durabilityFences: new Set(),
    approvalReceipts: new Map(),
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
    for (const pending of state.pendingDurableTerminals?.values() ?? []) {
      clearTimeout(pending.timer);
    }
    state.jobs.clear();
    state.runStarts.clear();
    state.pendingErrors.clear();
    state.pendingTimeouts.clear();
    state.pendingDurableTerminals?.clear();
    state.runOwners?.clear();
    state.durabilityFences?.clear();
    state.approvalReceipts?.clear();
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
const pendingDurableAgentRunTerminals = (agentJobState.pendingDurableTerminals ??= new Map());
const agentRunOwners = (agentJobState.runOwners ??= new Map());
const agentRunDurabilityFences = (agentJobState.durabilityFences ??= new Set());
const agentRunApprovalReceipts = (agentJobState.approvalReceipts ??= new Map());
const agentRunWaiters = agentJobState.waiters;
let agentRunListenerStarted = false;
let forceTerminalPersistenceFailureForTest = false;
const agentJobLog = createSubsystemLogger("gateway/agent-job");
const AGENT_RUN_TERMINAL_PERSISTENCE_RETRY_MS = 250;

function nextAgentRunVersion(): number {
  agentJobState.version += 1;
  return agentJobState.version;
}

function pruneAgentRunCache(now = Date.now()) {
  for (const [runId, job] of agentJobs) {
    if (now - job.cachedAt <= AGENT_RUN_CACHE_TTL_MS) {
      continue;
    }
    agentJobs.delete(runId);
  }
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
  const terminalReply = mergeAgentRunTerminalReplySnapshot(
    existing.terminalReply,
    incoming.terminalReply,
  );
  const terminalDelivery = incoming.terminalDelivery ?? existing.terminalDelivery;
  const terminalReceipt = incoming.terminalReceipt ?? existing.terminalReceipt;
  const existingOutcome = terminalOutcomeFromSnapshot(existing);
  const incomingOutcome = terminalOutcomeFromSnapshot(incoming);
  const preservesProvisionalFailure =
    existing.executionSettled !== true &&
    incoming.executionSettled === true &&
    existingOutcome !== undefined &&
    existingOutcome.status !== "ok" &&
    incomingOutcome?.reason === "completed";
  const incomingSettlesAfterProvisional =
    existing.executionSettled !== true && incoming.executionSettled === true;
  const canonical =
    existing.executionSettled === true ||
    (incomingSettlesAfterProvisional
      ? preservesProvisionalFailure
      : shouldPreserveTerminalSnapshot(existing, incoming))
      ? existing
      : incoming;
  // Terminal status, execution settlement, and producer evidence are independent.
  return {
    ...canonical,
    executionSettled: existing.executionSettled === true || incoming.executionSettled === true,
    ...(terminalDelivery ? { terminalDelivery } : {}),
    ...(terminalReceipt ? { terminalReceipt } : {}),
    ...(terminalReply ? { terminalReply } : {}),
    cachedAt: incoming.cachedAt,
    recordedAt: incoming.recordedAt,
    version: incoming.version,
  };
}

function publishAgentRunSnapshot(
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
  enforceAgentRunCacheMaxEntries();
  for (const waiter of agentRunWaiters.get(entry.runId) ?? []) {
    waiter();
  }
}

function normalizePersistedAgentJobSnapshot(value: unknown): AgentJobTerminalSnapshot | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  // SAFETY: the object/non-array guard above narrows the persisted payload to an indexable record.
  const record = value as Record<string, unknown>;
  if (record.status !== "ok" && record.status !== "error" && record.status !== "timeout") {
    return undefined;
  }
  const outcome = buildAgentRunTerminalOutcome({
    status: record.status,
    startedAt: asFiniteNumber(record.startedAt),
    endedAt: asFiniteNumber(record.endedAt),
    error: typeof record.error === "string" ? record.error : undefined,
    stopReason: readNonBlankString(record.stopReason),
    livenessState: readNonBlankString(record.livenessState),
    timeoutPhase: record.timeoutPhase,
    providerStarted: record.providerStarted,
  });
  const terminalDelivery = normalizeAgentRunTerminalDeliverySnapshot(record.terminalDelivery);
  const terminalReceipt = normalizeAgentRunTerminalReceipt(record.terminalReceipt);
  return {
    status: outcome.status,
    // Receipts written before settlement-kind tracking were execution-authoritative.
    executionSettled: record.executionSettled !== false,
    startedAt: asFiniteNumber(record.startedAt),
    endedAt: asFiniteNumber(record.endedAt),
    error: outcome.status === "ok" ? undefined : outcome.error,
    stopReason: outcome.stopReason,
    livenessState: outcome.livenessState,
    ...(record.yielded === true ? { yielded: true } : {}),
    ...(record.pendingError === true ? { pendingError: true } : {}),
    ...(outcome.timeoutPhase ? { timeoutPhase: outcome.timeoutPhase } : {}),
    ...(outcome.providerStarted !== undefined ? { providerStarted: outcome.providerStarted } : {}),
    ...(terminalDelivery ? { terminalDelivery } : {}),
    ...(terminalReceipt ? { terminalReceipt } : {}),
  };
}

export function readDurableAgentJobTerminalReceipt(
  runId: string,
  owner?: AgentRunTerminalReceiptOwner,
): { owner: AgentRunTerminalReceiptOwner; terminal: AgentJobTerminalSnapshot } | undefined {
  if (agentRunDurabilityFences.has(runId) || isIncognitoSessionKey(owner?.sessionKey)) {
    return undefined;
  }
  const receipt = readAgentRunTerminalReceipt({ runId, ...(owner ? { owner } : {}) });
  if (!receipt || isIncognitoSessionKey(receipt.owner.sessionKey)) {
    return undefined;
  }
  try {
    const terminal = normalizePersistedAgentJobSnapshot(JSON.parse(receipt.terminalJson));
    if (terminal) {
      return { owner: receipt.owner, terminal };
    }
  } catch {
    // The store already rejects malformed JSON; this protects mixed-version rows.
  }
  try {
    deleteAgentRunTerminalReceipt({ runId });
  } catch {
    // Invalid canonical receipts are misses even if opportunistic pruning is blocked.
  }
  return undefined;
}

function readDurableAgentRunSnapshot(
  runId: string,
  owner?: AgentRunTerminalReceiptOwner,
): AgentJobTerminalSnapshot | undefined {
  return readDurableAgentJobTerminalReceipt(runId, owner)?.terminal;
}

function projectDurableSnapshot(
  snapshot: AgentRunObservation,
  terminal: AgentJobTerminalSnapshot,
): AgentRunObservation {
  return { ...snapshot, ...terminal, runId: snapshot.runId, source: snapshot.source };
}

function scheduleDurableAgentRunTerminalRetry(
  runId: string,
  pending: PendingDurableAgentRunTerminal,
): void {
  const timer = setSafeTimeout(() => {
    if (pendingDurableAgentRunTerminals.get(runId) !== pending) {
      return;
    }
    pending.timer = undefined;
    attemptDurableAgentRunTerminalWrite(runId, pending);
  }, AGENT_RUN_TERMINAL_PERSISTENCE_RETRY_MS);
  timer.unref?.();
  pending.timer = timer;
}

function mergeApprovalReceiptsIntoTerminalReceipt(
  runId: string,
  receipt: AgentRunTerminalReceipt | undefined,
): AgentRunTerminalReceipt | undefined {
  if (!receipt || receipt.runId !== runId) {
    return receipt;
  }
  const approvals = normalizeAgentRunApprovalReceipts([
    ...(receipt.approvalReceipts ?? []),
    ...Array.from(agentRunApprovalReceipts.get(runId)?.values() ?? []),
  ]);
  return approvals ? { ...receipt, approvalReceipts: approvals } : receipt;
}

function durableControlPlaneText(value: string | undefined, maxLength: number): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = redactSensitiveText(value, { mode: "tools" }).replace(/\s+/gu, " ").trim();
  return normalized ? truncateUtf16Safe(normalized, maxLength) : undefined;
}

function durableSnapshot(snapshot: AgentRunObservation): AgentJobTerminalSnapshot {
  const terminal = publicSnapshot(snapshot);
  const { terminalReply: _terminalReply, pendingError: _pendingError, ...durable } = terminal;
  return {
    ...durable,
    executionSettled: snapshot.executionSettled === true,
    error: durableControlPlaneText(durable.error, 2_048),
    stopReason: durableControlPlaneText(durable.stopReason, 128),
    livenessState: durableControlPlaneText(durable.livenessState, 128),
  };
}

function completeDurableAgentRunTerminalWrite(
  runId: string,
  pending: PendingDurableAgentRunTerminal,
  durable: AgentJobTerminalSnapshot,
): void {
  pendingDurableAgentRunTerminals.delete(runId);
  publishAgentRunSnapshot(
    projectDurableSnapshot(pending.snapshot, durable),
    pending.snapshot.version,
  );
  if (durable.executionSettled === true) {
    agentRunOwners.delete(runId);
    agentRunApprovalReceipts.delete(runId);
  }
}

function retireDurableAgentRunTerminalOwnerConflict(
  runId: string,
  pending: PendingDurableAgentRunTerminal,
): void {
  if (pending.timer) {
    clearTimeout(pending.timer);
  }
  pendingDurableAgentRunTerminals.delete(runId);
  agentRunOwners.delete(runId);
  agentRunApprovalReceipts.delete(runId);
  agentRunDurabilityFences.add(runId);
  const failure: AgentRunObservation = {
    ...pending.snapshot,
    status: "error",
    executionSettled: true,
    error: "durable terminal receipt owner conflict",
    stopReason: undefined,
    timeoutPhase: undefined,
    providerStarted: undefined,
  };
  publishAgentRunSnapshot(failure, pending.snapshot.version);
  agentJobLog.warn(`durable terminal receipt owner conflict for run ${runId}`);
}

function retireDurableAgentRunTerminalValidationFailure(
  runId: string,
  pending: PendingDurableAgentRunTerminal,
  error: AgentRunTerminalReceiptValidationError,
): void {
  if (pending.timer) {
    clearTimeout(pending.timer);
  }
  pendingDurableAgentRunTerminals.delete(runId);
  agentRunOwners.delete(runId);
  agentRunApprovalReceipts.delete(runId);
  agentRunDurabilityFences.add(runId);
  publishAgentRunSnapshot(
    {
      ...pending.snapshot,
      status: "error",
      executionSettled: true,
      error: "durable terminal receipt validation failed",
      stopReason: undefined,
      timeoutPhase: undefined,
      providerStarted: undefined,
    },
    pending.snapshot.version,
  );
  agentJobLog.warn(`durable terminal receipt validation failed for run ${runId}: ${error.message}`);
}

function mergeRetainedDurableAgentRunTerminal(
  runId: string,
  pending: PendingDurableAgentRunTerminal,
): void {
  if (pending.snapshot.executionSettled !== true) {
    return;
  }
  const retained = readDurableAgentRunSnapshot(runId, pending.owner);
  if (!retained) {
    return;
  }
  pending.snapshot = mergeSnapshot(
    { ...projectDurableSnapshot(pending.snapshot, retained), cachedAt: 0 },
    { ...pending.snapshot, cachedAt: 0 },
  );
}

function attemptDurableAgentRunTerminalWrite(
  runId: string,
  pending: PendingDurableAgentRunTerminal,
): void {
  try {
    if (forceTerminalPersistenceFailureForTest) {
      throw new Error("forced terminal receipt persistence failure");
    }
    if (agentRunDurabilityFences.has(runId)) {
      deleteAgentRunTerminalReceipt({ runId });
      agentRunDurabilityFences.delete(runId);
    }
    mergeRetainedDurableAgentRunTerminal(runId, pending);
    const candidate = durableSnapshot(pending.snapshot);
    const result = writeAgentRunTerminalReceiptWithResult({
      runId,
      owner: pending.owner,
      terminalJson: JSON.stringify(candidate),
      replaceProvisionalDelivery: pending.snapshot.executionSettled === true,
    });
    if (result.state === "owner-conflict") {
      retireDurableAgentRunTerminalOwnerConflict(runId, pending);
      return;
    }
    const durable =
      result.state === "written" ? candidate : readDurableAgentRunSnapshot(runId, pending.owner);
    if (
      !durable ||
      (pending.snapshot.executionSettled === true && durable.executionSettled !== true)
    ) {
      throw new Error("terminal receipt persistence did not settle");
    }
    completeDurableAgentRunTerminalWrite(runId, pending, durable);
  } catch (error) {
    if (error instanceof AgentRunTerminalReceiptValidationError) {
      retireDurableAgentRunTerminalValidationFailure(runId, pending, error);
      return;
    }
    try {
      const durable = readDurableAgentRunSnapshot(runId, pending.owner);
      if (durable) {
        if (pending.snapshot.executionSettled !== true || durable.executionSettled === true) {
          completeDurableAgentRunTerminalWrite(runId, pending, durable);
          return;
        }
      } else if (readDurableAgentRunSnapshot(runId)) {
        retireDurableAgentRunTerminalOwnerConflict(runId, pending);
        return;
      }
    } catch {
      // An unreadable write outcome remains transient and follows the bounded retry path.
    }
    agentJobLog.warn(`terminal receipt persistence pending for run ${runId}: ${String(error)}`);
    scheduleDurableAgentRunTerminalRetry(runId, pending);
  }
}

function recordAgentRunSnapshot(
  snapshot: Omit<AgentRunObservation, "version">,
  version = nextAgentRunVersion(),
) {
  const observation = { ...snapshot, version };
  const owner = agentRunOwners.get(snapshot.runId);
  if (!owner) {
    const durable =
      agentRunDurabilityFences.has(snapshot.runId) || snapshot.source === "chat"
        ? undefined
        : readDurableAgentRunSnapshot(snapshot.runId);
    publishAgentRunSnapshot(
      durable ? projectDurableSnapshot(observation, durable) : observation,
      version,
    );
    return;
  }
  observation.terminalReceipt = mergeApprovalReceiptsIntoTerminalReceipt(
    snapshot.runId,
    observation.terminalReceipt,
  );
  const existingPending = pendingDurableAgentRunTerminals.get(snapshot.runId);
  if (existingPending) {
    const merged = mergeSnapshot(
      { ...existingPending.snapshot, cachedAt: 0 },
      { ...observation, cachedAt: 0 },
    );
    existingPending.snapshot = merged;
    return;
  }
  const pending = { snapshot: observation, owner };
  pendingDurableAgentRunTerminals.set(snapshot.runId, pending);
  attemptDurableAgentRunTerminalWrite(snapshot.runId, pending);
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

function resolveAgentRunReceiptOwner(runId: string): AgentRunTerminalReceiptOwner | undefined {
  const context = getAgentRunContext(runId);
  const sessionKey = readNonBlankString(context?.sessionKey);
  if (isIncognitoSessionKey(sessionKey)) {
    return undefined;
  }
  const explicitAgentId = readNonBlankString(context?.agentId);
  const agentId = explicitAgentId ?? /^agent:([^:]+):/u.exec(sessionKey ?? "")?.[1];
  if (!agentId) {
    return undefined;
  }
  const sessionId = readNonBlankString(context?.sessionId);
  return {
    agentId,
    ...(sessionKey ? { sessionKey } : {}),
    ...(sessionId ? { sessionId } : {}),
  };
}

function beginAgentJob(runId: string, startedAt?: number) {
  nextAgentRunVersion();
  clearPendingAgentRunTerminals(runId);
  const pendingDurable = pendingDurableAgentRunTerminals.get(runId);
  if (pendingDurable?.timer) {
    clearTimeout(pendingDurable.timer);
  }
  pendingDurableAgentRunTerminals.delete(runId);
  agentJobs.delete(runId);
  agentRunApprovalReceipts.delete(runId);
  const owner = resolveAgentRunReceiptOwner(runId);
  if (owner) {
    agentRunOwners.set(runId, owner);
  } else {
    agentRunOwners.delete(runId);
  }
  const isIncognitoRun = isIncognitoSessionKey(getAgentRunContext(runId)?.sessionKey);
  try {
    if (forceTerminalPersistenceFailureForTest) {
      throw new Error("forced terminal receipt persistence failure");
    }
    deleteAgentRunTerminalReceipt({ runId });
    if (isIncognitoRun) {
      agentRunDurabilityFences.add(runId);
    } else {
      agentRunDurabilityFences.delete(runId);
    }
  } catch (error) {
    agentRunDurabilityFences.add(runId);
    agentJobLog.warn(`terminal receipt ownership fence pending for run ${runId}: ${String(error)}`);
  }
  agentRunStarts.set(runId, startedAt ?? Date.now());
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

function createPendingErrorTimeoutSnapshot(
  snapshot: AgentJobTerminalSnapshot,
): AgentJobTerminalSnapshot {
  return {
    status: "timeout",
    startedAt: snapshot.startedAt,
    error: snapshot.error,
    pendingError: true,
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
    executionSettled: hasExecutionSettlement(data),
    version: nextAgentRunVersion(),
  };
}

function recordAgentRunApprovalReceipt(runId: string, data: Record<string, unknown>): void {
  const approvalId = readNonBlankString(data.approvalId);
  const phase = data.phase;
  if (!approvalId || approvalId.length > 256 || (phase !== "requested" && phase !== "resolved")) {
    return;
  }
  const existing = agentRunApprovalReceipts.get(runId) ?? new Map();
  if (!existing.has(approvalId) && existing.size >= AGENT_RUN_TERMINAL_LINK_MAX_ITEMS) {
    return;
  }
  const previous = existing.get(approvalId);
  const toolCallId = readNonBlankString(data.toolCallId);
  existing.set(approvalId, {
    approvalId,
    ...((toolCallId?.length ?? 0) <= 256 && toolCallId
      ? { toolCallId }
      : previous?.toolCallId
        ? { toolCallId: previous.toolCallId }
        : {}),
    state: previous?.state === "resolved" || phase === "resolved" ? "resolved" : "waiting",
  });
  agentRunApprovalReceipts.set(runId, existing);
  const pending = pendingDurableAgentRunTerminals.get(runId);
  if (pending?.snapshot.terminalReceipt) {
    pending.snapshot.terminalReceipt = mergeApprovalReceiptsIntoTerminalReceipt(
      runId,
      pending.snapshot.terminalReceipt,
    );
  }
}

function ensureAgentRunListener() {
  if (agentRunListenerStarted) {
    return;
  }
  agentRunListenerStarted = true;
  onAgentEvent((evt) => {
    if (!evt) {
      return;
    }
    if (evt.stream === "approval") {
      recordAgentRunApprovalReceipt(evt.runId, evt.data);
      return;
    }
    if (evt.stream !== "lifecycle") {
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
  // SAFETY: dedupe payloads are JSON-like records by DedupeEntry contract; every field is rechecked below.
  const payload = entry.payload as
    | {
        status?: unknown;
        startedAt?: unknown;
        endedAt?: unknown;
        error?: unknown;
        summary?: unknown;
        stopReason?: unknown;
        livenessState?: unknown;
        yielded?: unknown;
        timeoutPhase?: unknown;
        providerStarted?: unknown;
        result?: unknown;
        terminalReply?: unknown;
      }
    | undefined;
  const status = typeof payload?.status === "string" ? payload.status : undefined;
  if (isNonTerminalAgentRunStatus(status)) {
    return { state: "active" };
  }

  const terminalStatus =
    status === "ok" || status === "timeout" || status === "error"
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
    agentRunStarts.delete(key.runId);
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
      recordedAt: params.entry.ts,
      executionSettled: false,
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
): AgentRunSnapshot | undefined {
  const dedupe = getFreshestDedupeSnapshot(snapshotsBySource);
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
  source?: "chat";
  afterVersion: number;
}): AgentRunSnapshot | undefined {
  pruneAgentRunCache();
  const job = agentJobs.get(params.runId);
  const snapshot = params.source
    ? job?.snapshotsBySource.get(params.source)
    : job
      ? getCanonicalAgentRunSnapshot(job.snapshotsBySource)
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

function publicSnapshot(snapshot: AgentRunObservation): AgentJobTerminalSnapshot {
  return {
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

function isAgentRunCurrent(runId: string): boolean {
  return (
    agentRunStarts.has(runId) ||
    pendingAgentRunErrors.has(runId) ||
    pendingAgentRunTimeouts.has(runId) ||
    pendingDurableAgentRunTerminals.has(runId)
  );
}

function readAvailableAgentRunTerminal(params: {
  runId: string;
  source?: "chat";
  afterVersion: number;
  allowDurable: boolean;
}): AgentJobTerminalSnapshot | undefined {
  if (isAgentRunCurrent(params.runId)) {
    return undefined;
  }
  const cached = getAgentRunSnapshot(params);
  if (cached) {
    return publicSnapshot(cached);
  }
  if (!params.allowDurable || params.source || agentRunDurabilityFences.has(params.runId)) {
    return undefined;
  }
  try {
    const durable = readDurableAgentRunSnapshot(params.runId, agentRunOwners.get(params.runId));
    if (!durable) {
      return undefined;
    }
    const { executionSettled: _executionSettled, ...publicDurable } = durable;
    return publicDurable;
  } catch (error) {
    agentJobLog.warn(`terminal receipt read failed for run ${params.runId}: ${String(error)}`);
    return undefined;
  }
}

export async function waitForAgentJob(params: {
  runId: string;
  timeoutMs: number;
  ignoreCachedSnapshot?: boolean;
  source?: "chat";
}): Promise<AgentJobTerminalSnapshot | null> {
  ensureAgentRunListener();
  const afterVersion = params.ignoreCachedSnapshot ? agentJobState.version : -1;
  const initial = readAvailableAgentRunTerminal({
    runId: params.runId,
    source: params.source,
    afterVersion,
    allowDurable: params.ignoreCachedSnapshot !== true,
  });
  if (initial) {
    return initial;
  }
  const signal = getAsyncWorkSignal();
  if (params.timeoutMs <= 0 || signal?.aborted) {
    return null;
  }

  return await new Promise((resolve) => {
    let settled = false;
    let removeWaiter = () => {};
    const finish = (snapshot: AgentJobTerminalSnapshot | null) => {
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
      const snapshot = readAvailableAgentRunTerminal({
        runId: params.runId,
        source: params.source,
        afterVersion,
        allowDurable: params.ignoreCachedSnapshot !== true,
      });
      if (snapshot) {
        finish(snapshot);
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
              ? publicSnapshot(pendingError)
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
          finish(publicSnapshot(pendingTimeout));
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

/** Test-only failure injection for proving persistence gates hot success publication. */
export function setAgentJobTerminalPersistenceFailureForTest(fail: boolean): void {
  forceTerminalPersistenceFailureForTest = fail;
}

/** Clears process-local projections while deliberately retaining durable SQLite receipts. */
export function resetAgentJobStateForTest(): void {
  for (const pending of pendingAgentRunErrors.values()) {
    clearTimeout(pending.timer);
  }
  for (const pending of pendingAgentRunTimeouts.values()) {
    clearTimeout(pending.timer);
  }
  for (const pending of pendingDurableAgentRunTerminals.values()) {
    clearTimeout(pending.timer);
  }
  agentJobs.clear();
  agentRunStarts.clear();
  pendingAgentRunErrors.clear();
  pendingAgentRunTimeouts.clear();
  pendingDurableAgentRunTerminals.clear();
  agentRunOwners.clear();
  agentRunDurabilityFences.clear();
  agentRunApprovalReceipts.clear();
}

ensureAgentRunListener();
