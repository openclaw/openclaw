import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { readNonBlankString } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  normalizeAgentRunTerminalDeliverySnapshot,
  type AgentRunTerminalDeliverySnapshot,
} from "../../agents/agent-run-terminal-delivery.js";
import {
  buildAgentRunTerminalOutcome,
  type AgentRunTerminalOutcome,
} from "../../agents/agent-run-terminal-outcome.js";
import {
  AGENT_RUN_TERMINAL_LINK_MAX_ITEMS,
  normalizeAgentRunApprovalReceipts,
  normalizeAgentRunTerminalReceipt,
  type AgentRunApprovalReceipt,
  type AgentRunTerminalReceipt,
} from "../../agents/agent-run-terminal-receipt.js";
import type { AgentRunTerminalReplySnapshot } from "../../agents/agent-run-terminal-reply.js";
import { getAgentRunContext } from "../../infra/agent-run-registry.js";
import { redactSensitiveText } from "../../logging/redact.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { isIncognitoSessionKey } from "../../shared/incognito-session-key.js";
import {
  AgentRunTerminalReceiptValidationError,
  deleteAgentRunTerminalReceipt,
  readAgentRunTerminalReceipt,
  writeAgentRunTerminalReceiptWithResult,
  type AgentRunTerminalReceiptOwner,
} from "../../state/agent-run-terminal-receipts.js";
import { setSafeTimeout } from "../../utils/timer-delay.js";

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

export type AgentJobSource = "agent" | "chat" | "lifecycle";
export type AgentRunObservation = AgentJobTerminalSnapshot & {
  runId: string;
  source: AgentJobSource;
  recordedAt: number;
  version: number;
};
export type AgentRunSnapshot = AgentRunObservation & { cachedAt: number };
export type PendingDurableAgentRunTerminal = {
  snapshot: AgentRunObservation;
  owner: AgentRunTerminalReceiptOwner;
  timer?: NodeJS.Timeout;
};
export type AgentRunApprovalReceiptMap = Map<string, AgentRunApprovalReceipt>;

type AgentJobDurabilityParams = {
  pendingTerminals: Map<string, PendingDurableAgentRunTerminal>;
  runOwners: Map<string, AgentRunTerminalReceiptOwner>;
  durabilityFences: Set<string>;
  approvalReceipts: Map<string, AgentRunApprovalReceiptMap>;
  mergeSnapshot: (
    existing: AgentRunSnapshot | undefined,
    incoming: AgentRunSnapshot,
  ) => AgentRunSnapshot;
  publishSnapshot: (snapshot: Omit<AgentRunObservation, "version">, version?: number) => void;
  publicSnapshot: (snapshot: AgentRunObservation) => AgentJobTerminalSnapshot;
};

const log = createSubsystemLogger("gateway/agent-job");
const PERSISTENCE_RETRY_MS = 250;

export function createAgentJobDurability(params: AgentJobDurabilityParams) {
  let forcePersistenceFailureForTest = false;

  function normalizePersistedSnapshot(value: unknown): AgentJobTerminalSnapshot | undefined {
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
      ...(outcome.providerStarted !== undefined
        ? { providerStarted: outcome.providerStarted }
        : {}),
      ...(terminalDelivery ? { terminalDelivery } : {}),
      ...(terminalReceipt ? { terminalReceipt } : {}),
    };
  }

  function readReceipt(
    runId: string,
    owner?: AgentRunTerminalReceiptOwner,
  ): { owner: AgentRunTerminalReceiptOwner; terminal: AgentJobTerminalSnapshot } | undefined {
    if (params.durabilityFences.has(runId) || isIncognitoSessionKey(owner?.sessionKey)) {
      return undefined;
    }
    const receipt = readAgentRunTerminalReceipt({ runId, ...(owner ? { owner } : {}) });
    if (!receipt || isIncognitoSessionKey(receipt.owner.sessionKey)) {
      return undefined;
    }
    try {
      const terminal = normalizePersistedSnapshot(JSON.parse(receipt.terminalJson));
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

  function readSnapshot(
    runId: string,
    owner?: AgentRunTerminalReceiptOwner,
  ): AgentJobTerminalSnapshot | undefined {
    return readReceipt(runId, owner)?.terminal;
  }

  function projectSnapshot(
    snapshot: AgentRunObservation,
    terminal: AgentJobTerminalSnapshot,
  ): AgentRunObservation {
    return { ...snapshot, ...terminal, runId: snapshot.runId, source: snapshot.source };
  }

  function scheduleRetry(runId: string, pending: PendingDurableAgentRunTerminal): void {
    const timer = setSafeTimeout(() => {
      if (params.pendingTerminals.get(runId) !== pending) {
        return;
      }
      pending.timer = undefined;
      attemptWrite(runId, pending);
    }, PERSISTENCE_RETRY_MS);
    timer.unref?.();
    pending.timer = timer;
  }

  function mergeApprovalReceipts(
    runId: string,
    receipt: AgentRunTerminalReceipt | undefined,
  ): AgentRunTerminalReceipt | undefined {
    if (!receipt || receipt.runId !== runId) {
      return receipt;
    }
    const approvals = normalizeAgentRunApprovalReceipts([
      ...(receipt.approvalReceipts ?? []),
      ...Array.from(params.approvalReceipts.get(runId)?.values() ?? []),
    ]);
    return approvals ? { ...receipt, approvalReceipts: approvals } : receipt;
  }

  function durableControlPlaneText(
    value: string | undefined,
    maxLength: number,
  ): string | undefined {
    if (!value) {
      return undefined;
    }
    const normalized = redactSensitiveText(value, { mode: "tools" }).replace(/\s+/gu, " ").trim();
    return normalized ? truncateUtf16Safe(normalized, maxLength) : undefined;
  }

  function durableSnapshot(snapshot: AgentRunObservation): AgentJobTerminalSnapshot {
    const terminal = params.publicSnapshot(snapshot);
    const { terminalReply: _terminalReply, pendingError: _pendingError, ...durable } = terminal;
    return {
      ...durable,
      executionSettled: snapshot.executionSettled === true,
      error: durableControlPlaneText(durable.error, 2_048),
      stopReason: durableControlPlaneText(durable.stopReason, 128),
      livenessState: durableControlPlaneText(durable.livenessState, 128),
    };
  }

  function completeWrite(
    runId: string,
    pending: PendingDurableAgentRunTerminal,
    durable: AgentJobTerminalSnapshot,
  ): void {
    params.pendingTerminals.delete(runId);
    params.publishSnapshot(projectSnapshot(pending.snapshot, durable), pending.snapshot.version);
    if (durable.executionSettled === true) {
      params.runOwners.delete(runId);
      params.approvalReceipts.delete(runId);
    }
  }

  function retireOwnerConflict(runId: string, pending: PendingDurableAgentRunTerminal): void {
    if (pending.timer) {
      clearTimeout(pending.timer);
    }
    params.pendingTerminals.delete(runId);
    params.runOwners.delete(runId);
    params.approvalReceipts.delete(runId);
    params.durabilityFences.add(runId);
    params.publishSnapshot(
      {
        ...pending.snapshot,
        status: "error",
        executionSettled: true,
        error: "durable terminal receipt owner conflict",
        stopReason: undefined,
        timeoutPhase: undefined,
        providerStarted: undefined,
      },
      pending.snapshot.version,
    );
    log.warn(`durable terminal receipt owner conflict for run ${runId}`);
  }

  function retireValidationFailure(
    runId: string,
    pending: PendingDurableAgentRunTerminal,
    error: AgentRunTerminalReceiptValidationError,
  ): void {
    if (pending.timer) {
      clearTimeout(pending.timer);
    }
    params.pendingTerminals.delete(runId);
    params.runOwners.delete(runId);
    params.approvalReceipts.delete(runId);
    params.durabilityFences.add(runId);
    params.publishSnapshot(
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
    log.warn(`durable terminal receipt validation failed for run ${runId}: ${error.message}`);
  }

  function mergeRetained(runId: string, pending: PendingDurableAgentRunTerminal): void {
    if (pending.snapshot.executionSettled !== true) {
      return;
    }
    const retained = readSnapshot(runId, pending.owner);
    if (!retained) {
      return;
    }
    pending.snapshot = params.mergeSnapshot(
      { ...projectSnapshot(pending.snapshot, retained), cachedAt: 0 },
      { ...pending.snapshot, cachedAt: 0 },
    );
  }

  function attemptWrite(runId: string, pending: PendingDurableAgentRunTerminal): void {
    try {
      if (forcePersistenceFailureForTest) {
        throw new Error("forced terminal receipt persistence failure");
      }
      if (params.durabilityFences.has(runId)) {
        deleteAgentRunTerminalReceipt({ runId });
        params.durabilityFences.delete(runId);
      }
      mergeRetained(runId, pending);
      const candidate = durableSnapshot(pending.snapshot);
      const result = writeAgentRunTerminalReceiptWithResult({
        runId,
        owner: pending.owner,
        terminalJson: JSON.stringify(candidate),
        replaceProvisionalDelivery: pending.snapshot.executionSettled === true,
      });
      if (result.state === "owner-conflict") {
        retireOwnerConflict(runId, pending);
        return;
      }
      const durable = result.state === "written" ? candidate : readSnapshot(runId, pending.owner);
      if (
        !durable ||
        (pending.snapshot.executionSettled === true && durable.executionSettled !== true)
      ) {
        throw new Error("terminal receipt persistence did not settle");
      }
      completeWrite(runId, pending, durable);
    } catch (error) {
      if (error instanceof AgentRunTerminalReceiptValidationError) {
        retireValidationFailure(runId, pending, error);
        return;
      }
      try {
        const durable = readSnapshot(runId, pending.owner);
        if (durable) {
          if (pending.snapshot.executionSettled !== true || durable.executionSettled === true) {
            completeWrite(runId, pending, durable);
            return;
          }
        } else if (readSnapshot(runId)) {
          retireOwnerConflict(runId, pending);
          return;
        }
      } catch {
        // An unreadable write outcome remains transient and follows the bounded retry path.
      }
      log.warn(`terminal receipt persistence pending for run ${runId}: ${String(error)}`);
      scheduleRetry(runId, pending);
    }
  }

  function recordSnapshot(snapshot: Omit<AgentRunObservation, "version">, version: number): void {
    const observation = { ...snapshot, version };
    const owner = params.runOwners.get(snapshot.runId);
    if (!owner) {
      const durable =
        params.durabilityFences.has(snapshot.runId) || snapshot.source === "chat"
          ? undefined
          : readSnapshot(snapshot.runId);
      params.publishSnapshot(
        durable ? projectSnapshot(observation, durable) : observation,
        version,
      );
      return;
    }
    observation.terminalReceipt = mergeApprovalReceipts(
      snapshot.runId,
      observation.terminalReceipt,
    );
    const existingPending = params.pendingTerminals.get(snapshot.runId);
    if (existingPending) {
      existingPending.snapshot = params.mergeSnapshot(
        { ...existingPending.snapshot, cachedAt: 0 },
        { ...observation, cachedAt: 0 },
      );
      return;
    }
    const pending = { snapshot: observation, owner };
    params.pendingTerminals.set(snapshot.runId, pending);
    attemptWrite(snapshot.runId, pending);
  }

  function beginRun(runId: string): void {
    const pending = params.pendingTerminals.get(runId);
    if (pending?.timer) {
      clearTimeout(pending.timer);
    }
    params.pendingTerminals.delete(runId);
    params.approvalReceipts.delete(runId);
    const context = getAgentRunContext(runId);
    const sessionKey = readNonBlankString(context?.sessionKey);
    const explicitAgentId = readNonBlankString(context?.agentId);
    const agentId = explicitAgentId ?? /^agent:([^:]+):/u.exec(sessionKey ?? "")?.[1];
    if (agentId && !isIncognitoSessionKey(sessionKey)) {
      const sessionId = readNonBlankString(context?.sessionId);
      params.runOwners.set(runId, {
        agentId,
        ...(sessionKey ? { sessionKey } : {}),
        ...(sessionId ? { sessionId } : {}),
      });
    } else {
      params.runOwners.delete(runId);
    }
    const isIncognitoRun = isIncognitoSessionKey(sessionKey);
    try {
      if (forcePersistenceFailureForTest) {
        throw new Error("forced terminal receipt persistence failure");
      }
      deleteAgentRunTerminalReceipt({ runId });
      if (isIncognitoRun) {
        params.durabilityFences.add(runId);
      } else {
        params.durabilityFences.delete(runId);
      }
    } catch (error) {
      params.durabilityFences.add(runId);
      log.warn(`terminal receipt ownership fence pending for run ${runId}: ${String(error)}`);
    }
  }

  function recordApprovalReceipt(runId: string, data: Record<string, unknown>): void {
    const approvalId = readNonBlankString(data.approvalId);
    const phase = data.phase;
    if (!approvalId || approvalId.length > 256 || (phase !== "requested" && phase !== "resolved")) {
      return;
    }
    const existing = params.approvalReceipts.get(runId) ?? new Map();
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
    params.approvalReceipts.set(runId, existing);
    const pending = params.pendingTerminals.get(runId);
    if (pending?.snapshot.terminalReceipt) {
      pending.snapshot.terminalReceipt = mergeApprovalReceipts(
        runId,
        pending.snapshot.terminalReceipt,
      );
    }
  }

  function reset(): void {
    for (const pending of params.pendingTerminals.values()) {
      clearTimeout(pending.timer);
    }
    params.pendingTerminals.clear();
    params.runOwners.clear();
    params.durabilityFences.clear();
    params.approvalReceipts.clear();
  }

  return {
    beginRun,
    durabilityFences: params.durabilityFences,
    pendingTerminals: params.pendingTerminals,
    readReceipt,
    readSnapshot,
    recordApprovalReceipt,
    recordSnapshot,
    reset,
    runOwners: params.runOwners,
    setFailureForTest(fail: boolean): void {
      forcePersistenceFailureForTest = fail;
    },
  };
}
