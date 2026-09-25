import { Buffer } from "node:buffer";
import type {
  WorkerLiveEventErrorDetails,
  WorkerLiveEventParams,
  WorkerLiveEventResult,
} from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { normalizeToolPolicyName } from "../../agents/tool-policy.js";
import { projectAgentToolActivity } from "../../infra/agent-activity-events.js";
import {
  emitAgentEventIfCurrent,
  emitAgentEventForOwner,
  getAgentEventLifecycleGeneration,
} from "../../infra/agent-events.js";
import {
  claimAgentRunContext,
  getAgentRunContext,
  getAgentRunContextOwnership,
  getAgentRunContextOwnerStatus,
} from "../../infra/agent-run-registry.js";
import { pruneMapToMaxSize } from "../../infra/map-size.js";
import type { WorkerConnectionIdentity } from "./connection-identity.js";
import {
  createWorkerLiveTrajectoryRecorder,
  isDefinitiveWorkerTerminalEvent,
  prepareWorkerLiveEventData,
  recordWorkerLiveTrajectoryEvent,
} from "./live-event-projection.js";
import {
  fenceReleasedWorkerLiveRun,
  hasReachableBufferedTerminal,
  releaseWorkerLiveRun,
  rotateWorkerLiveEventCredential,
  type LiveEventWindow,
  type OwnedLiveRun,
  type PendingLiveEvent,
  type WorkerLiveCredentialRotation,
} from "./live-event-window.js";
import {
  captureWorkerTurnFinishing,
  type WorkerTurnTranscriptSource,
} from "./placement-turn-claim-events.js";
import { captureWorkerTurnLiveEventOwner } from "./worker-turn-run-owner.js";

const DEFAULT_WINDOW_SIZE = 128;
const DEFAULT_MAX_PENDING_BYTES = 512 * 1024;
const DEFAULT_MAX_SESSIONS = 128;
const DEFAULT_MAX_ACTIVE_RUNS = 32;
const MAX_FENCED_ENVIRONMENTS = 4096;

export type WorkerLiveEventApplicationResult =
  | { ok: true; result: WorkerLiveEventResult }
  | { ok: false; details: WorkerLiveEventErrorDetails };

type WorkerLiveEventFailure = Extract<WorkerLiveEventApplicationResult, { ok: false }>;
type WorkerLiveEventPublication = Omit<PendingLiveEvent, "sizeBytes">;

type WorkerLiveEventReceiverOptions = {
  maxActiveRuns?: number;
  maxPendingBytes?: number;
  maxSessions?: number;
  windowSize?: number;
};

function invalidEvent(): WorkerLiveEventFailure {
  return { ok: false, details: { reason: "invalid-event" } };
}

function capacityExceeded(): WorkerLiveEventFailure {
  return { ok: false, details: { reason: "capacity-exceeded" } };
}

function isCancelledFinishing(
  request: WorkerLiveEventParams,
  owner: PendingLiveEvent["runOwner"],
): boolean {
  return (
    owner?.isCancelled() === true &&
    request.event.kind === "lifecycle" &&
    request.event.payload.phase === "finishing" &&
    request.event.payload.aborted === true
  );
}

export function createWorkerLiveEventReceiver(options: WorkerLiveEventReceiverOptions = {}) {
  const fencedEnvironmentEpochs = new Map<string, number>();
  const windows = new Map<string, LiveEventWindow>();
  const windowSize = Math.max(1, Math.floor(options.windowSize ?? DEFAULT_WINDOW_SIZE));
  const maxActiveRuns = Math.max(1, Math.floor(options.maxActiveRuns ?? DEFAULT_MAX_ACTIVE_RUNS));
  const maxPendingBytes = Math.max(
    1,
    Math.floor(options.maxPendingBytes ?? DEFAULT_MAX_PENDING_BYTES),
  );
  const maxSessions = Math.max(1, Math.floor(options.maxSessions ?? DEFAULT_MAX_SESSIONS));
  const rotateCredential = (rotation: WorkerLiveCredentialRotation): boolean =>
    rotateWorkerLiveEventCredential(windows.get(rotation.sessionId), rotation);

  const clearWindow = (window: LiveEventWindow): void => {
    windows.delete(window.sessionId);
    for (const runId of window.activeRuns.keys()) {
      releaseWorkerLiveRun(window, runId);
    }
    window.pending.clear();
    window.pendingBytes = 0;
    window.terminalRuns.clear();
  };

  const resyncRequired = (ackedSeq: number): WorkerLiveEventFailure => ({
    ok: false,
    details: { reason: "resync-required", ackedSeq, expectedSeq: ackedSeq + 1 },
  });

  const resyncWindow = (window: LiveEventWindow): WorkerLiveEventFailure => {
    // Resync replays the unacked suffix from expectedSeq. Drop speculative state
    // so stable or renumbered replay sequences cannot collide with stale pending.
    window.pending.clear();
    window.pendingBytes = 0;
    return resyncRequired(window.ackedSeq);
  };

  const resolveOrCreateWindow = (
    sessionId: string,
    params: {
      identity: WorkerConnectionIdentity;
      request: WorkerLiveEventParams;
      source: WorkerTurnTranscriptSource;
      readAckedSeq: () => number;
    },
  ): WorkerLiveEventApplicationResult | LiveEventWindow => {
    let window = windows.get(sessionId);
    if (
      window &&
      (window.environmentId !== params.identity.environmentId ||
        window.runEpoch !== params.request.runEpoch)
    ) {
      if (params.request.runEpoch <= window.runEpoch) {
        return { ok: false, details: { reason: "epoch-mismatch" } };
      }
      clearWindow(window);
      window = undefined;
    }
    if (window) {
      if (params.identity.credentialHash !== window.credentialHash) {
        return { ok: false, details: { reason: "epoch-mismatch" } };
      }
    } else {
      const ackedSeq = params.readAckedSeq();
      if (params.request.lastAckedSeq > ackedSeq) {
        return resyncRequired(ackedSeq);
      }
      if (windows.size >= maxSessions) {
        // Evict the oldest settled, registry-quiescent window; it rebinds via
        // resync. Stale activeRuns entries alone do not imply live ownership.
        let evicted = false;
        for (const candidate of windows.values()) {
          const busy =
            candidate.activeApplications > 0 ||
            [...candidate.activeRuns.entries()].some(
              ([runId, owned]) =>
                getAgentRunContextOwnerStatus(runId, owned.claimId, owned.lifecycleGeneration) ===
                "active",
            );
          if (!busy) {
            clearWindow(candidate);
            evicted = true;
            break;
          }
        }
        if (!evicted) {
          return capacityExceeded();
        }
      }
      window = {
        activeApplications: 0,
        activeRuns: new Map(),
        ackedSeq,
        credentialHash: params.identity.credentialHash,
        environmentId: params.identity.environmentId,
        pending: new Map(),
        pendingBytes: 0,
        trajectoryWrites: new Set(),
        runEpoch: params.request.runEpoch,
        sessionId,
        source: params.source,
        terminalRuns: new Map(),
      };
      windows.set(sessionId, window);
    }
    if (window.source !== params.source) {
      if (window.activeRuns.size > 0 || window.pending.size > 0 || window.activeApplications > 0) {
        return invalidEvent();
      }
      window.source = params.source;
    }
    return window;
  };

  const pruneReleasedRuns = (window: LiveEventWindow): WorkerLiveEventFailure | undefined => {
    for (const [runId, owned] of window.activeRuns) {
      const ownerStatus = getAgentRunContextOwnerStatus(
        runId,
        owned.claimId,
        owned.lifecycleGeneration,
      );
      if (ownerStatus === undefined) {
        clearWindow(window);
        return resyncRequired(0);
      }
      if (ownerStatus !== "active") {
        fenceReleasedWorkerLiveRun(window, runId);
      }
    }
    return undefined;
  };

  const claimRun = (
    window: LiveEventWindow,
    runId: string,
    allowBufferedTerminalCapacity: boolean,
  ): WorkerLiveEventFailure | OwnedLiveRun => {
    if (window.terminalRuns.has(runId)) {
      return invalidEvent();
    }
    const owned = window.activeRuns.get(runId);
    if (owned) {
      const context = getAgentRunContext(runId);
      const ownerStatus = getAgentRunContextOwnerStatus(
        runId,
        owned.claimId,
        owned.lifecycleGeneration,
      );
      if (ownerStatus === undefined) {
        // A process sweep lost sequencing state; restart the transient cursor.
        clearWindow(window);
        return resyncRequired(0);
      }
      if (
        ownerStatus !== "active" ||
        context?.sessionId !== window.sessionId ||
        context.sessionKey !== window.source.sessionTarget.sessionKey ||
        context.agentId !== window.source.sessionTarget.agentId ||
        context.lifecycleGeneration !== owned.lifecycleGeneration ||
        context.isControlUiVisible !== owned.controlUiVisible
      ) {
        fenceReleasedWorkerLiveRun(window, runId);
        return invalidEvent();
      }
      return owned;
    }

    const pruneFailure = pruneReleasedRuns(window);
    if (pruneFailure) {
      return pruneFailure;
    }
    const countedRunIds = new Set<string>();
    for (const activeRunId of window.activeRuns.keys()) {
      if (!window.terminalRuns.has(activeRunId)) {
        countedRunIds.add(activeRunId);
      }
    }
    if (
      countedRunIds.size >= maxActiveRuns &&
      !(
        allowBufferedTerminalCapacity &&
        hasReachableBufferedTerminal(window, runId, countedRunIds, windowSize)
      )
    ) {
      return capacityExceeded();
    }
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const existingContext = getAgentRunContext(runId);
    // Existing dispatch contexts must admit their outer terminal. Ownerless contexts still need
    // worker-owned cleanup so a definitive worker terminal cannot leave the session active.
    const controlUiVisible = existingContext?.isControlUiVisible ?? false;
    if (
      existingContext &&
      (existingContext.sessionId !== window.sessionId ||
        existingContext.sessionKey !== window.source.sessionTarget.sessionKey ||
        (existingContext.agentId !== undefined &&
          existingContext.agentId !== window.source.sessionTarget.agentId) ||
        existingContext.lifecycleGeneration !== lifecycleGeneration)
    ) {
      return invalidEvent();
    }
    const hasExistingTrackedOwner =
      getAgentRunContextOwnership(runId)?.lifecycleGeneration === lifecycleGeneration;
    const emissionMode: OwnedLiveRun["emissionMode"] = existingContext ? "shared" : "exclusive";
    const claimId = claimAgentRunContext(
      runId,
      {
        ...(window.source.sessionTarget.agentId
          ? { agentId: window.source.sessionTarget.agentId }
          : {}),
        isControlUiVisible: controlUiVisible,
        lifecycleGeneration,
        projectSessionActive: true,
        sessionId: window.sessionId,
        sessionKey: window.source.sessionTarget.sessionKey,
      },
      {
        exclusive: existingContext === undefined,
        onClearRequested: (clearedClaimId) => {
          if (window.activeRuns.get(runId)?.claimId === clearedClaimId) {
            fenceReleasedWorkerLiveRun(window, runId);
          }
        },
        ownsContext: !hasExistingTrackedOwner,
        trackOwner: true,
      },
    );
    if (!claimId) {
      return invalidEvent();
    }
    const claimed = {
      claimId,
      controlUiVisible,
      emissionMode,
      lifecycleGeneration,
      trajectoryRecorder: createWorkerLiveTrajectoryRecorder({ runId, source: window.source }),
      toolArgsByCallId: new Map<string, unknown>(),
    };
    window.activeRuns.set(runId, claimed);
    return claimed;
  };

  const publish = (
    window: LiveEventWindow,
    publication: WorkerLiveEventPublication,
    allowBufferedTerminalCapacity: boolean,
  ): WorkerLiveEventFailure | undefined => {
    const { request, recordApplied, runOwner, source } = publication;
    if (runOwner?.isCancelled()) {
      if (!isCancelledFinishing(request, runOwner)) {
        return invalidEvent();
      }
      // Cancellation retires live publication before the worker finishes.
      // Its exact owner can still settle the ACK without recreating a run claim.
      window.terminalRuns.set(request.runId, request.seq);
      releaseWorkerLiveRun(window, request.runId);
      return undefined;
    }
    try {
      source.receiptAuthority();
    } catch {
      return invalidEvent();
    }
    const owned = claimRun(window, request.runId, allowBufferedTerminalCapacity);
    if ("ok" in owned) {
      return owned;
    }
    const definitiveTerminal = isDefinitiveWorkerTerminalEvent(request.event);
    if (definitiveTerminal) {
      // Emission runs synchronous listeners that can clear this claim reentrantly.
      // Fence first so terminal delivery cannot reopen the run ID.
      window.terminalRuns.set(request.runId, request.seq);
    }
    const event = {
      runId: request.runId,
      stream: request.event.kind,
      data: prepareWorkerLiveEventData(request.event),
    };
    let activity;
    if (request.event.kind === "tool") {
      const tool = request.event.payload;
      if (tool.phase === "start") {
        owned.toolArgsByCallId.set(tool.toolCallId, tool.args);
      }
      activity = projectAgentToolActivity({
        ...tool,
        name: normalizeToolPolicyName(tool.name),
        args: owned.toolArgsByCallId.get(tool.toolCallId),
      });
      if (tool.phase === "result") {
        owned.toolArgsByCallId.delete(tool.toolCallId);
      }
    }
    const itemEvent = activity
      ? { runId: request.runId, stream: "item", data: activity }
      : undefined;
    const emissions = itemEvent
      ? activity?.phase === "start"
        ? [itemEvent, event]
        : [event, itemEvent]
      : [event];
    const ownsPublication = () => {
      try {
        source.receiptAuthority();
      } catch {
        return false;
      }
      return (
        window.activeRuns.get(request.runId) === owned &&
        getAgentRunContextOwnerStatus(request.runId, owned.claimId, owned.lifecycleGeneration) ===
          "active"
      );
    };
    for (const emission of emissions) {
      if (!ownsPublication()) {
        return invalidEvent();
      }
      if (owned.emissionMode === "shared") {
        if (!emitAgentEventIfCurrent(emission)) {
          if (definitiveTerminal) {
            window.terminalRuns.delete(request.runId);
          }
          return invalidEvent();
        }
      } else {
        emitAgentEventForOwner(emission, owned.claimId);
      }
    }
    if (activity && !ownsPublication()) {
      return invalidEvent();
    }
    const write = recordWorkerLiveTrajectoryEvent(owned.trajectoryRecorder, request.event);
    if (write) {
      window.trajectoryWrites.add(write);
      void write.then(() => window.trajectoryWrites.delete(write));
    }
    recordApplied?.(request.event);
    // Gateway handler owns cleanup so detach can revoke deferred terminal delivery.
    return undefined;
  };

  const drain = (
    window: LiveEventWindow,
    first: WorkerLiveEventPublication,
    firstPending?: PendingLiveEvent,
  ): WorkerLiveEventApplicationResult => {
    let publication: WorkerLiveEventPublication = firstPending ?? first;
    let buffered = firstPending;
    let publishedPrefix = false;
    while (true) {
      const { request } = publication;
      const failed = publish(window, publication, buffered !== undefined);
      if (failed) {
        if (failed.details.reason === "capacity-exceeded" && buffered) {
          // Keep the ordered tail retryable while the active prefix claim drains.
          // Later gaps still hit windowSize/maxPendingBytes and force normal resync.
          return { ok: true, result: { ackedSeq: window.ackedSeq } };
        }
        if (buffered && window.pending.delete(request.seq)) {
          window.pendingBytes -= buffered.sizeBytes;
        }
        if (failed.details.reason === "capacity-exceeded" && !publishedPrefix) {
          // A fresh head cannot advance. Reset its cursor and release every claim.
          clearWindow(window);
          return failed;
        }
        return publishedPrefix ? { ok: true, result: { ackedSeq: window.ackedSeq } } : failed;
      }
      if (buffered && window.pending.delete(request.seq)) {
        window.pendingBytes -= buffered.sizeBytes;
      }
      window.ackedSeq = request.seq;
      publishedPrefix = true;
      const oldestRetainedSeq = window.ackedSeq - windowSize;
      for (const [runId, terminalSeq] of window.terminalRuns) {
        // Active terminal claims stay fenced until owner cleanup. Released run IDs
        // age out after windowSize later events and may then start a fresh claim.
        if (!window.activeRuns.has(runId) && terminalSeq <= oldestRetainedSeq) {
          window.terminalRuns.delete(runId);
        }
      }
      const next = window.pending.get(window.ackedSeq + 1);
      if (!next) {
        break;
      }
      publication = next;
      buffered = next;
    }
    return { ok: true, result: { ackedSeq: window.ackedSeq } };
  };

  const applyToWindow = (
    window: LiveEventWindow,
    params: {
      identity: WorkerConnectionIdentity;
      request: WorkerLiveEventParams;
      source: WorkerTurnTranscriptSource;
    },
  ): WorkerLiveEventApplicationResult => {
    if (params.request.seq <= window.ackedSeq) {
      return { ok: true, result: { ackedSeq: window.ackedSeq } };
    }
    if (params.request.lastAckedSeq > window.ackedSeq) {
      return resyncWindow(window);
    }
    const runOwner = captureWorkerTurnLiveEventOwner(params.identity);
    const recordFinishing = captureWorkerTurnFinishing(params.identity, params.request);
    const recordApplied: PendingLiveEvent["recordApplied"] = (event) => {
      runOwner?.record(event);
      recordFinishing?.();
    };
    const publication = { request: params.request, recordApplied, runOwner, source: params.source };
    const { seq } = params.request;
    const expectedSeq = window.ackedSeq + 1;
    if (seq > window.ackedSeq + windowSize) {
      return resyncWindow(window);
    }
    if (seq === expectedSeq) {
      return drain(window, publication, window.pending.get(seq));
    }
    if (window.pending.has(seq)) {
      return { ok: true, result: { ackedSeq: window.ackedSeq } };
    }
    const sizeBytes = Buffer.byteLength(JSON.stringify(params.request.event), "utf8");
    if (window.pendingBytes + sizeBytes > maxPendingBytes) {
      return resyncWindow(window);
    }
    window.pending.set(seq, {
      ...publication,
      sizeBytes,
    });
    window.pendingBytes += sizeBytes;
    return { ok: true, result: { ackedSeq: window.ackedSeq } };
  };

  const apply = async (params: {
    identity: WorkerConnectionIdentity;
    request: WorkerLiveEventParams;
    source: WorkerTurnTranscriptSource;
    readAckedSeq: () => number;
  }): Promise<WorkerLiveEventApplicationResult> => {
    if (!params.identity.sessionId) {
      return { ok: false, details: { reason: "session-not-attached" } };
    }
    if (params.request.runEpoch !== params.identity.ownerEpoch) {
      return { ok: false, details: { reason: "epoch-mismatch" } };
    }
    if (
      params.request.runEpoch <= (fencedEnvironmentEpochs.get(params.identity.environmentId) ?? -1)
    ) {
      return invalidEvent();
    }
    const sessionId = params.identity.sessionId;
    const window = resolveOrCreateWindow(sessionId, params);
    if ("ok" in window) {
      return window;
    }
    window.activeApplications += 1;
    try {
      let result: WorkerLiveEventApplicationResult;
      try {
        result = applyToWindow(window, params);
      } finally {
        // Snapshot this accepted prefix, including duplicate ACKs, even if a later
        // callback throws. Later requests own their own writes.
        await Promise.all(window.trajectoryWrites);
      }
      if (result.ok) {
        if (
          !isCancelledFinishing(params.request, captureWorkerTurnLiveEventOwner(params.identity))
        ) {
          try {
            params.source.receiptAuthority();
          } catch {
            return invalidEvent();
          }
        }
        if (windows.get(sessionId) !== window) {
          return { ok: false, details: { reason: "session-not-attached" } };
        }
        if (window.credentialHash !== params.identity.credentialHash) {
          return { ok: false, details: { reason: "epoch-mismatch" } };
        }
      }
      return result;
    } finally {
      window.activeApplications -= 1;
    }
  };

  const clearEnvironment = (environmentId: string, ownerEpoch: number): void => {
    let fencedEpoch = Math.max(fencedEnvironmentEpochs.get(environmentId) ?? -1, ownerEpoch);
    for (const window of windows.values()) {
      if (window.environmentId === environmentId) {
        fencedEpoch = Math.max(fencedEpoch, window.runEpoch);
        clearWindow(window);
      }
    }
    if (fencedEpoch >= 0) {
      // Oldest tombstones may expire because service/store ownership stays authoritative.
      // Refresh recency first so a re-fenced environment keeps its newest stale-owner epoch.
      fencedEnvironmentEpochs.delete(environmentId);
      fencedEnvironmentEpochs.set(environmentId, fencedEpoch);
      pruneMapToMaxSize(fencedEnvironmentEpochs, MAX_FENCED_ENVIRONMENTS);
    }
  };

  const clear = (): void => {
    for (const window of windows.values()) {
      clearWindow(window);
    }
    fencedEnvironmentEpochs.clear();
  };

  return { apply, clear, clearEnvironment, rotateCredential };
}

export type WorkerLiveEventReceiver = ReturnType<typeof createWorkerLiveEventReceiver>;
