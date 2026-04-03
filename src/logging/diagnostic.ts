import type { TurnLatencyStageInfo } from "../auto-reply/types.js";
import { loadConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/config.js";
import { emitDiagnosticEvent, isDiagnosticsEnabled } from "../infra/diagnostic-events.js";
import {
  diagnosticSessionStates,
  getDiagnosticSessionState,
  getDiagnosticSessionStateCountForTest as getDiagnosticSessionStateCountForTestImpl,
  pruneDiagnosticSessionStates,
  resetDiagnosticSessionStateForTest,
  type SessionRef,
  type SessionStateValue,
} from "./diagnostic-session-state.js";
import { createSubsystemLogger } from "./subsystem.js";

const diag = createSubsystemLogger("diagnostic");

function shouldLogDiagnosticTimelineInfo(): boolean {
  try {
    return isDiagnosticsEnabled(loadConfig());
  } catch {
    return false;
  }
}

const webhookStats = {
  received: 0,
  processed: 0,
  errors: 0,
  lastReceived: 0,
};
const FIRST_VISIBLE_SAMPLE_LIMIT = 50;
const LATENCY_SAMPLE_LIMIT = 50;
const FIRST_VISIBLE_TIMEOUT_MS = 4_000;
const MIN_FIRST_VISIBLE_WARN_MS = 250;
const MAX_FIRST_VISIBLE_WARN_MS = 10 * 60 * 1000;
const firstVisibleSamples: number[] = [];
const firstVisibleSamplesByKind: Record<"tool" | "block" | "status" | "final", number[]> = {
  tool: [],
  block: [],
  status: [],
  final: [],
};
let firstVisibleTimeoutCount = 0;
type LatencySegmentName =
  | "dispatchToQueue"
  | "queueToRun"
  | "acpEnsureToRun"
  | "runToFirstEvent"
  | "firstEventToFirstVisible"
  | "runToFirstVisible"
  | "firstVisibleToFinal"
  | "endToEnd";
type TurnLatencySnapshot = Partial<Record<TurnLatencyStageInfo["stage"], number>>;
const latencySamples: Record<LatencySegmentName, number[]> = {
  dispatchToQueue: [],
  queueToRun: [],
  acpEnsureToRun: [],
  runToFirstEvent: [],
  firstEventToFirstVisible: [],
  runToFirstVisible: [],
  firstVisibleToFinal: [],
  endToEnd: [],
};
const latencyDominantCounts: Partial<Record<LatencySegmentName, number>> = {};
const turnLatencySnapshots = new Map<string, TurnLatencySnapshot>();
const EARLY_STATUS_SAMPLE_LIMIT = 50;
const earlyStatusSamples: Array<{
  category: "eligible" | "semantic_gate" | "latency_gate";
  queueMode: string;
  activationReason: string;
}> = [];
const earlyStatusReasonCounts: Record<string, number> = {};

let lastActivityAt = 0;
const DEFAULT_STUCK_SESSION_WARN_MS = 120_000;
const MIN_STUCK_SESSION_WARN_MS = 1_000;
const MAX_STUCK_SESSION_WARN_MS = 24 * 60 * 60 * 1000;
let commandPollBackoffRuntimePromise: Promise<
  typeof import("../agents/command-poll-backoff.runtime.js")
> | null = null;

function loadCommandPollBackoffRuntime() {
  commandPollBackoffRuntimePromise ??= import("../agents/command-poll-backoff.runtime.js");
  return commandPollBackoffRuntimePromise;
}

function markActivity() {
  lastActivityAt = Date.now();
}

function recordFirstVisibleSample(kind: "tool" | "block" | "status" | "final", durationMs: number) {
  firstVisibleSamples.push(durationMs);
  if (firstVisibleSamples.length > FIRST_VISIBLE_SAMPLE_LIMIT) {
    firstVisibleSamples.splice(0, firstVisibleSamples.length - FIRST_VISIBLE_SAMPLE_LIMIT);
  }
  const byKindBucket = firstVisibleSamplesByKind[kind];
  byKindBucket.push(durationMs);
  if (byKindBucket.length > FIRST_VISIBLE_SAMPLE_LIMIT) {
    byKindBucket.splice(0, byKindBucket.length - FIRST_VISIBLE_SAMPLE_LIMIT);
  }
}

function buildFirstVisibleSummary():
  | {
      sampleCount: number;
      avgMs: number;
      p95Ms: number;
      maxMs: number;
      timeoutCount: number;
    }
  | undefined {
  if (firstVisibleSamples.length === 0) {
    return undefined;
  }
  const ordered = [...firstVisibleSamples].toSorted((left, right) => left - right);
  const total = ordered.reduce((sum, value) => sum + value, 0);
  const p95Index = Math.min(ordered.length - 1, Math.max(0, Math.ceil(ordered.length * 0.95) - 1));
  return {
    sampleCount: ordered.length,
    avgMs: Math.round(total / ordered.length),
    p95Ms: ordered[p95Index] ?? ordered[ordered.length - 1] ?? 0,
    maxMs: ordered[ordered.length - 1] ?? 0,
    timeoutCount: firstVisibleTimeoutCount,
  };
}

function recordLatencySample(segment: LatencySegmentName, durationMs: number) {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return;
  }
  const bucket = latencySamples[segment];
  bucket.push(Math.round(durationMs));
  if (bucket.length > LATENCY_SAMPLE_LIMIT) {
    bucket.splice(0, bucket.length - LATENCY_SAMPLE_LIMIT);
  }
}

function buildLatencySummary():
  | {
      sampleCount: number;
      dominant?: Array<{
        segment: LatencySegmentName;
        count: number;
      }>;
      segments: Partial<
        Record<
          LatencySegmentName,
          {
            avgMs: number;
            p95Ms: number;
            maxMs: number;
          }
        >
      >;
    }
  | undefined {
  const segments = Object.entries(latencySamples).reduce<
    Partial<Record<LatencySegmentName, { avgMs: number; p95Ms: number; maxMs: number }>>
  >((acc, [name, samples]) => {
    if (samples.length === 0) {
      return acc;
    }
    const ordered = [...samples].toSorted((left, right) => left - right);
    const total = ordered.reduce((sum, value) => sum + value, 0);
    const p95Index = Math.min(
      ordered.length - 1,
      Math.max(0, Math.ceil(ordered.length * 0.95) - 1),
    );
    acc[name as LatencySegmentName] = {
      avgMs: Math.round(total / ordered.length),
      p95Ms: ordered[p95Index] ?? ordered[ordered.length - 1] ?? 0,
      maxMs: ordered[ordered.length - 1] ?? 0,
    };
    return acc;
  }, {});
  const dominant = Object.entries(latencyDominantCounts)
    .filter((entry): entry is [LatencySegmentName, number] => typeof entry[1] === "number")
    .toSorted((left, right) => right[1] - left[1])
    .slice(0, 3)
    .map(([segment, count]) => ({ segment, count }));
  const sampleCount = latencySamples.endToEnd.length;
  if (sampleCount === 0 && Object.keys(segments).length === 0 && dominant.length === 0) {
    return undefined;
  }
  return {
    sampleCount,
    ...(dominant.length > 0 ? { dominant } : {}),
    segments,
  };
}

function formatLatencyHeartbeatSummary(
  latency:
    | {
        sampleCount: number;
        dominant?: Array<{
          segment: LatencySegmentName;
          count: number;
        }>;
        segments: Partial<
          Record<
            LatencySegmentName,
            {
              avgMs: number;
              p95Ms: number;
              maxMs: number;
            }
          >
        >;
      }
    | undefined,
): string {
  if (!latency) {
    return "";
  }
  const parts: string[] = [];
  const append = (
    label: string,
    segment:
      | {
          avgMs: number;
          p95Ms: number;
          maxMs: number;
        }
      | undefined,
  ) => {
    if (!segment) {
      return;
    }
    parts.push(`${label}=${segment.avgMs}/${segment.p95Ms}/${segment.maxMs}ms`);
  };
  append("queue", latency.segments.dispatchToQueue);
  append("queue->run", latency.segments.queueToRun);
  append("ensure->run", latency.segments.acpEnsureToRun);
  append("run->event", latency.segments.runToFirstEvent);
  append("event->visible", latency.segments.firstEventToFirstVisible);
  append("run->visible", latency.segments.runToFirstVisible);
  append("visible->final", latency.segments.firstVisibleToFinal);
  append("endToEnd", latency.segments.endToEnd);
  if (latency.dominant && latency.dominant.length > 0) {
    parts.push(
      `dominant=${latency.dominant.map((entry) => `${entry.segment}x${entry.count}`).join(",")}`,
    );
  }
  if (parts.length === 0) {
    return "";
  }
  return ` latency=${latency.sampleCount} ${parts.join(" | ")}`;
}

function recordEarlyStatusPolicySample(params: {
  decisionShouldEmit: boolean;
  activationShouldEmit: boolean;
  queueMode: string;
  activationReason: string;
}) {
  const category = params.activationShouldEmit
    ? "eligible"
    : params.decisionShouldEmit
      ? "latency_gate"
      : "semantic_gate";
  earlyStatusSamples.push({
    category,
    queueMode: params.queueMode,
    activationReason: params.activationReason,
  });
  if (earlyStatusSamples.length > EARLY_STATUS_SAMPLE_LIMIT) {
    earlyStatusSamples.splice(0, earlyStatusSamples.length - EARLY_STATUS_SAMPLE_LIMIT);
  }
  earlyStatusReasonCounts[params.activationReason] =
    (earlyStatusReasonCounts[params.activationReason] ?? 0) + 1;
}

function buildEarlyStatusSummary():
  | {
      sampleCount: number;
      eligibleCount: number;
      semanticGateCount: number;
      latencyGateCount: number;
      topReasons?: Array<{
        reason: string;
        count: number;
      }>;
      phase2Supplements?: {
        sampleCount: number;
        eligibleCount: number;
        hitRatePct: number;
        topSkipReasons?: Array<{
          reason: string;
          count: number;
        }>;
        statusFirstVisibleAvgMs?: number;
        statusFirstVisibleP95Ms?: number;
      };
    }
  | undefined {
  if (earlyStatusSamples.length === 0) {
    return undefined;
  }
  const summary = {
    sampleCount: earlyStatusSamples.length,
    eligibleCount: earlyStatusSamples.filter((value) => value.category === "eligible").length,
    semanticGateCount: earlyStatusSamples.filter((value) => value.category === "semantic_gate")
      .length,
    latencyGateCount: earlyStatusSamples.filter((value) => value.category === "latency_gate")
      .length,
  };
  const topReasons = Object.entries(earlyStatusReasonCounts)
    .toSorted((left, right) => right[1] - left[1])
    .slice(0, 3)
    .map(([reason, count]) => ({ reason, count }));
  const supplementSamples = earlyStatusSamples.filter(
    (value) => value.queueMode === "collect" || value.queueMode === "followup",
  );
  const supplementEligibleCount = supplementSamples.filter(
    (value) => value.category === "eligible",
  ).length;
  const supplementSkipReasons = supplementSamples
    .filter((value) => value.category !== "eligible")
    .reduce<Record<string, number>>((acc, value) => {
      acc[value.activationReason] = (acc[value.activationReason] ?? 0) + 1;
      return acc;
    }, {});
  const topSkipReasons = Object.entries(supplementSkipReasons)
    .toSorted((left, right) => right[1] - left[1])
    .slice(0, 3)
    .map(([reason, count]) => ({ reason, count }));
  const statusVisibleOrdered = [...firstVisibleSamplesByKind.status].toSorted(
    (left, right) => left - right,
  );
  const statusVisibleP95Index = Math.min(
    statusVisibleOrdered.length - 1,
    Math.max(0, Math.ceil(statusVisibleOrdered.length * 0.95) - 1),
  );

  return {
    ...summary,
    ...(topReasons.length > 0 ? { topReasons } : {}),
    ...(supplementSamples.length > 0
      ? {
          phase2Supplements: {
            sampleCount: supplementSamples.length,
            eligibleCount: supplementEligibleCount,
            hitRatePct: Math.round((supplementEligibleCount / supplementSamples.length) * 100),
            ...(topSkipReasons.length > 0 ? { topSkipReasons } : {}),
            ...(statusVisibleOrdered.length > 0
              ? {
                  statusFirstVisibleAvgMs: Math.round(
                    statusVisibleOrdered.reduce((sum, value) => sum + value, 0) /
                      statusVisibleOrdered.length,
                  ),
                  statusFirstVisibleP95Ms:
                    statusVisibleOrdered[statusVisibleP95Index] ??
                    statusVisibleOrdered[statusVisibleOrdered.length - 1],
                }
              : {}),
          },
        }
      : {}),
  };
}

function formatEarlyStatusHeartbeatSummary(
  earlyStatus:
    | {
        sampleCount: number;
        eligibleCount: number;
        semanticGateCount: number;
        latencyGateCount: number;
        topReasons?: Array<{
          reason: string;
          count: number;
        }>;
        phase2Supplements?: {
          sampleCount: number;
          eligibleCount: number;
          hitRatePct: number;
          topSkipReasons?: Array<{
            reason: string;
            count: number;
          }>;
          statusFirstVisibleAvgMs?: number;
          statusFirstVisibleP95Ms?: number;
        };
      }
    | undefined,
): string {
  if (!earlyStatus) {
    return "";
  }
  const parts = [
    `earlyStatus=${earlyStatus.sampleCount}`,
    `eligible=${earlyStatus.eligibleCount}`,
    `semanticGate=${earlyStatus.semanticGateCount}`,
    `latencyGate=${earlyStatus.latencyGateCount}`,
  ];
  if (earlyStatus.topReasons && earlyStatus.topReasons.length > 0) {
    parts.push(
      `reasons=${earlyStatus.topReasons
        .map((entry) => `${entry.reason}x${entry.count}`)
        .join(",")}`,
    );
  }
  if (earlyStatus.phase2Supplements) {
    parts.push(
      `phase2=${earlyStatus.phase2Supplements.eligibleCount}/${earlyStatus.phase2Supplements.sampleCount}(${earlyStatus.phase2Supplements.hitRatePct}%)`,
    );
    if (typeof earlyStatus.phase2Supplements.statusFirstVisibleAvgMs === "number") {
      parts.push(
        `statusVisible=${earlyStatus.phase2Supplements.statusFirstVisibleAvgMs}/${earlyStatus.phase2Supplements.statusFirstVisibleP95Ms}ms`,
      );
    }
  }
  return ` ${parts.join(" | ")}`;
}

function recordTurnLatencyStageSample(params: {
  turnLatencyId: string;
  stage: TurnLatencyStageInfo["stage"];
  durationMs?: number;
}) {
  if (typeof params.durationMs !== "number" || !Number.isFinite(params.durationMs)) {
    return;
  }
  const snapshot = turnLatencySnapshots.get(params.turnLatencyId) ?? {};
  snapshot[params.stage] = params.durationMs;
  turnLatencySnapshots.set(params.turnLatencyId, snapshot);
  if (params.stage !== "completed") {
    return;
  }
  const queueAt = snapshot.queue_arbitrated;
  const runAt = snapshot.run_started;
  const acpEnsureAt = snapshot.acp_ensure_session_completed;
  const acpFirstEventAt = snapshot.acp_first_event;
  const acpFirstVisibleAt = snapshot.acp_first_visible_output;
  const firstVisibleAt = snapshot.first_visible_emitted;
  const finalAt = snapshot.final_dispatched;
  const completedAt = snapshot.completed;
  const turnSegments: Partial<Record<LatencySegmentName, number>> = {};

  if (typeof queueAt === "number") {
    recordLatencySample("dispatchToQueue", queueAt);
    turnSegments.dispatchToQueue = queueAt;
  }
  if (typeof runAt === "number") {
    const value = runAt - (queueAt ?? 0);
    recordLatencySample("queueToRun", value);
    turnSegments.queueToRun = value;
  }
  if (typeof runAt === "number" && typeof acpEnsureAt === "number") {
    const value = runAt - acpEnsureAt;
    recordLatencySample("acpEnsureToRun", value);
    turnSegments.acpEnsureToRun = value;
  }
  if (typeof runAt === "number" && typeof acpFirstEventAt === "number") {
    const value = acpFirstEventAt - runAt;
    recordLatencySample("runToFirstEvent", value);
    turnSegments.runToFirstEvent = value;
  }
  if (typeof acpFirstEventAt === "number" && typeof acpFirstVisibleAt === "number") {
    const value = acpFirstVisibleAt - acpFirstEventAt;
    recordLatencySample("firstEventToFirstVisible", value);
    turnSegments.firstEventToFirstVisible = value;
  }
  if (typeof runAt === "number" && typeof firstVisibleAt === "number") {
    const value = firstVisibleAt - runAt;
    recordLatencySample("runToFirstVisible", value);
    turnSegments.runToFirstVisible = value;
  }
  if (typeof firstVisibleAt === "number" && typeof finalAt === "number") {
    const value = finalAt - firstVisibleAt;
    recordLatencySample("firstVisibleToFinal", value);
    turnSegments.firstVisibleToFinal = value;
  }
  if (typeof completedAt === "number") {
    recordLatencySample("endToEnd", completedAt);
  }
  const dominant = Object.entries(turnSegments)
    .filter((entry): entry is [LatencySegmentName, number] => typeof entry[1] === "number")
    .toSorted((left, right) => right[1] - left[1])[0];
  if (dominant) {
    latencyDominantCounts[dominant[0]] = (latencyDominantCounts[dominant[0]] ?? 0) + 1;
  }
  turnLatencySnapshots.delete(params.turnLatencyId);
}

export function resolveStuckSessionWarnMs(config?: OpenClawConfig): number {
  const raw = config?.diagnostics?.stuckSessionWarnMs;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return DEFAULT_STUCK_SESSION_WARN_MS;
  }
  const rounded = Math.floor(raw);
  if (rounded < MIN_STUCK_SESSION_WARN_MS || rounded > MAX_STUCK_SESSION_WARN_MS) {
    return DEFAULT_STUCK_SESSION_WARN_MS;
  }
  return rounded;
}

export function resolveFirstVisibleWarnMs(config?: OpenClawConfig): number {
  const raw = config?.diagnostics?.firstVisibleWarnMs;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return FIRST_VISIBLE_TIMEOUT_MS;
  }
  const rounded = Math.floor(raw);
  if (rounded < MIN_FIRST_VISIBLE_WARN_MS || rounded > MAX_FIRST_VISIBLE_WARN_MS) {
    return FIRST_VISIBLE_TIMEOUT_MS;
  }
  return rounded;
}

export function logWebhookReceived(params: {
  channel: string;
  updateType?: string;
  chatId?: number | string;
}) {
  webhookStats.received += 1;
  webhookStats.lastReceived = Date.now();
  if (diag.isEnabled("debug")) {
    diag.debug(
      `webhook received: channel=${params.channel} type=${params.updateType ?? "unknown"} chatId=${
        params.chatId ?? "unknown"
      } total=${webhookStats.received}`,
    );
  }
  emitDiagnosticEvent({
    type: "webhook.received",
    channel: params.channel,
    updateType: params.updateType,
    chatId: params.chatId,
  });
  markActivity();
}

export function logWebhookProcessed(params: {
  channel: string;
  updateType?: string;
  chatId?: number | string;
  durationMs?: number;
}) {
  webhookStats.processed += 1;
  if (diag.isEnabled("debug")) {
    diag.debug(
      `webhook processed: channel=${params.channel} type=${
        params.updateType ?? "unknown"
      } chatId=${params.chatId ?? "unknown"} duration=${params.durationMs ?? 0}ms processed=${
        webhookStats.processed
      }`,
    );
  }
  emitDiagnosticEvent({
    type: "webhook.processed",
    channel: params.channel,
    updateType: params.updateType,
    chatId: params.chatId,
    durationMs: params.durationMs,
  });
  markActivity();
}

export function logWebhookError(params: {
  channel: string;
  updateType?: string;
  chatId?: number | string;
  error: string;
}) {
  webhookStats.errors += 1;
  diag.error(
    `webhook error: channel=${params.channel} type=${params.updateType ?? "unknown"} chatId=${
      params.chatId ?? "unknown"
    } error="${params.error}" errors=${webhookStats.errors}`,
  );
  emitDiagnosticEvent({
    type: "webhook.error",
    channel: params.channel,
    updateType: params.updateType,
    chatId: params.chatId,
    error: params.error,
  });
  markActivity();
}

export function logMessageQueued(params: {
  sessionId?: string;
  sessionKey?: string;
  channel?: string;
  source: string;
}) {
  const state = getDiagnosticSessionState(params);
  state.queueDepth += 1;
  state.lastActivity = Date.now();
  if (diag.isEnabled("debug")) {
    diag.debug(
      `message queued: sessionId=${state.sessionId ?? "unknown"} sessionKey=${
        state.sessionKey ?? "unknown"
      } source=${params.source} queueDepth=${state.queueDepth} sessionState=${state.state}`,
    );
  }
  emitDiagnosticEvent({
    type: "message.queued",
    sessionId: state.sessionId,
    sessionKey: state.sessionKey,
    channel: params.channel,
    source: params.source,
    queueDepth: state.queueDepth,
  });
  markActivity();
}

export function logMessageProcessed(params: {
  channel: string;
  messageId?: number | string;
  chatId?: number | string;
  sessionId?: string;
  sessionKey?: string;
  durationMs?: number;
  outcome: "completed" | "skipped" | "error";
  reason?: string;
  error?: string;
}) {
  const wantsLog = params.outcome === "error" ? diag.isEnabled("error") : diag.isEnabled("debug");
  if (wantsLog) {
    const payload = `message processed: channel=${params.channel} chatId=${
      params.chatId ?? "unknown"
    } messageId=${params.messageId ?? "unknown"} sessionId=${
      params.sessionId ?? "unknown"
    } sessionKey=${params.sessionKey ?? "unknown"} outcome=${params.outcome} duration=${
      params.durationMs ?? 0
    }ms${params.reason ? ` reason=${params.reason}` : ""}${
      params.error ? ` error="${params.error}"` : ""
    }`;
    if (params.outcome === "error") {
      diag.error(payload);
    } else {
      diag.debug(payload);
    }
  }
  emitDiagnosticEvent({
    type: "message.processed",
    channel: params.channel,
    chatId: params.chatId,
    messageId: params.messageId,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    durationMs: params.durationMs,
    outcome: params.outcome,
    reason: params.reason,
    error: params.error,
  });
  markActivity();
}

export function logMessageFirstVisible(params: {
  channel: string;
  messageId?: number | string;
  chatId?: number | string;
  sessionId?: string;
  sessionKey?: string;
  kind: "tool" | "block" | "status" | "final";
  dispatchToFirstVisibleMs: number;
}) {
  const payload = `message first visible: channel=${params.channel} chatId=${
    params.chatId ?? "unknown"
  } messageId=${params.messageId ?? "unknown"} sessionId=${params.sessionId ?? "unknown"} sessionKey=${
    params.sessionKey ?? "unknown"
  } kind=${params.kind} dispatchToFirstVisible=${params.dispatchToFirstVisibleMs}ms`;
  if (shouldLogDiagnosticTimelineInfo()) {
    diag.info(payload);
  } else if (diag.isEnabled("debug")) {
    diag.debug(payload);
  }
  emitDiagnosticEvent({
    type: "message.first_visible",
    channel: params.channel,
    chatId: params.chatId,
    messageId: params.messageId,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    kind: params.kind,
    dispatchToFirstVisibleMs: params.dispatchToFirstVisibleMs,
  });
  recordFirstVisibleSample(params.kind, params.dispatchToFirstVisibleMs);
  markActivity();
}

export function getFirstVisibleWatchdogMs(): number {
  try {
    return resolveFirstVisibleWarnMs(loadConfig());
  } catch {
    return FIRST_VISIBLE_TIMEOUT_MS;
  }
}

export function logMessageFirstVisibleTimeout(params: {
  channel: string;
  messageId?: number | string;
  chatId?: number | string;
  sessionId?: string;
  sessionKey?: string;
  thresholdMs?: number;
}) {
  const thresholdMs = params.thresholdMs ?? FIRST_VISIBLE_TIMEOUT_MS;
  firstVisibleTimeoutCount += 1;
  diag.warn(
    `message first visible timeout: channel=${params.channel} chatId=${params.chatId ?? "unknown"} messageId=${
      params.messageId ?? "unknown"
    } sessionId=${params.sessionId ?? "unknown"} sessionKey=${params.sessionKey ?? "unknown"} threshold=${thresholdMs}ms`,
  );
  emitDiagnosticEvent({
    type: "message.first_visible_timeout",
    channel: params.channel,
    chatId: params.chatId,
    messageId: params.messageId,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    thresholdMs,
  });
  markActivity();
}

export function logTurnLatencyStage(
  params: TurnLatencyStageInfo & {
    turnLatencyId: string;
    channel: string;
    messageId?: number | string;
    chatId?: number | string;
    sessionId?: string;
    sessionKey?: string;
    originatingChannel?: string;
    routed?: boolean;
    replyGeneration?: number;
  },
) {
  const payload = `turn latency stage: id=${params.turnLatencyId} stage=${params.stage} channel=${
    params.channel
  } chatId=${params.chatId ?? "unknown"} messageId=${params.messageId ?? "unknown"} sessionId=${
    params.sessionId ?? "unknown"
  } sessionKey=${params.sessionKey ?? "unknown"} duration=${params.durationMs ?? 0}ms${
    params.firstVisibleKind ? ` firstVisibleKind=${params.firstVisibleKind}` : ""
  }${params.provider ? ` provider=${params.provider}` : ""}${
    params.model ? ` model=${params.model}` : ""
  }${params.backend ? ` backend=${params.backend}` : ""}`;
  if (shouldLogDiagnosticTimelineInfo()) {
    diag.info(payload);
  } else if (diag.isEnabled("debug")) {
    diag.debug(payload);
  }
  emitDiagnosticEvent({
    type: "turn.latency.stage",
    turnLatencyId: params.turnLatencyId,
    stage: params.stage,
    channel: params.channel,
    messageId: params.messageId,
    chatId: params.chatId,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    originatingChannel: params.originatingChannel,
    routed: params.routed,
    replyGeneration: params.replyGeneration,
    durationMs: params.durationMs,
    queueModeConfigured: params.queueModeConfigured,
    queueModeFinal: params.queueModeFinal,
    supervisorAction: params.supervisorAction,
    supervisorRelation: params.supervisorRelation,
    firstVisibleKind: params.firstVisibleKind,
    provider: params.provider,
    model: params.model,
    backend: params.backend,
  });
  recordTurnLatencyStageSample({
    turnLatencyId: params.turnLatencyId,
    stage: params.stage,
    durationMs: params.durationMs,
  });
  markActivity();
}

export function logEarlyStatusPolicyDecision(params: {
  channel: string;
  sessionId?: string;
  sessionKey?: string;
  queueMode: string;
  decisionShouldEmit: boolean;
  activationShouldEmit: boolean;
  decisionReason: string;
  activationReason: string;
  recommendationLevel: "prioritize" | "observe" | "deprioritize";
  recommendationReason: string;
}) {
  if (diag.isEnabled("debug")) {
    diag.debug(
      `early status policy: channel=${params.channel} sessionKey=${params.sessionKey ?? "unknown"} queueMode=${
        params.queueMode
      } decision=${params.decisionShouldEmit ? "allow" : "suppress"} activation=${
        params.activationShouldEmit ? "emit" : "skip"
      } recommendation=${params.recommendationLevel} reason=${params.activationReason}`,
    );
  }
  emitDiagnosticEvent({
    type: "early_status.policy",
    channel: params.channel,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    queueMode: params.queueMode,
    decisionShouldEmit: params.decisionShouldEmit,
    activationShouldEmit: params.activationShouldEmit,
    decisionReason: params.decisionReason,
    activationReason: params.activationReason,
    recommendationLevel: params.recommendationLevel,
    recommendationReason: params.recommendationReason,
  });
  recordEarlyStatusPolicySample({
    decisionShouldEmit: params.decisionShouldEmit,
    activationShouldEmit: params.activationShouldEmit,
    queueMode: params.queueMode,
    activationReason: params.activationReason,
  });
  markActivity();
}

export function logSessionStateChange(
  params: SessionRef & {
    state: SessionStateValue;
    reason?: string;
  },
) {
  const state = getDiagnosticSessionState(params);
  const isProbeSession = state.sessionId?.startsWith("probe-") ?? false;
  const prevState = state.state;
  state.state = params.state;
  state.lastActivity = Date.now();
  if (params.state === "idle") {
    state.queueDepth = Math.max(0, state.queueDepth - 1);
  }
  if (!isProbeSession && diag.isEnabled("debug")) {
    diag.debug(
      `session state: sessionId=${state.sessionId ?? "unknown"} sessionKey=${
        state.sessionKey ?? "unknown"
      } prev=${prevState} new=${params.state} reason="${params.reason ?? ""}" queueDepth=${
        state.queueDepth
      }`,
    );
  }
  emitDiagnosticEvent({
    type: "session.state",
    sessionId: state.sessionId,
    sessionKey: state.sessionKey,
    prevState,
    state: params.state,
    reason: params.reason,
    queueDepth: state.queueDepth,
  });
  markActivity();
}

export function logSessionStuck(params: SessionRef & { state: SessionStateValue; ageMs: number }) {
  const state = getDiagnosticSessionState(params);
  diag.warn(
    `stuck session: sessionId=${state.sessionId ?? "unknown"} sessionKey=${
      state.sessionKey ?? "unknown"
    } state=${params.state} age=${Math.round(params.ageMs / 1000)}s queueDepth=${state.queueDepth}`,
  );
  emitDiagnosticEvent({
    type: "session.stuck",
    sessionId: state.sessionId,
    sessionKey: state.sessionKey,
    state: params.state,
    ageMs: params.ageMs,
    queueDepth: state.queueDepth,
  });
  markActivity();
}

export function logLaneEnqueue(lane: string, queueSize: number) {
  diag.debug(`lane enqueue: lane=${lane} queueSize=${queueSize}`);
  emitDiagnosticEvent({
    type: "queue.lane.enqueue",
    lane,
    queueSize,
  });
  markActivity();
}

export function logLaneDequeue(lane: string, waitMs: number, queueSize: number) {
  diag.debug(`lane dequeue: lane=${lane} waitMs=${waitMs} queueSize=${queueSize}`);
  emitDiagnosticEvent({
    type: "queue.lane.dequeue",
    lane,
    queueSize,
    waitMs,
  });
  markActivity();
}

export function logRunAttempt(params: SessionRef & { runId: string; attempt: number }) {
  diag.debug(
    `run attempt: sessionId=${params.sessionId ?? "unknown"} sessionKey=${
      params.sessionKey ?? "unknown"
    } runId=${params.runId} attempt=${params.attempt}`,
  );
  emitDiagnosticEvent({
    type: "run.attempt",
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    runId: params.runId,
    attempt: params.attempt,
  });
  markActivity();
}

export function logToolLoopAction(
  params: SessionRef & {
    toolName: string;
    level: "warning" | "critical";
    action: "warn" | "block";
    detector: "generic_repeat" | "known_poll_no_progress" | "global_circuit_breaker" | "ping_pong";
    count: number;
    message: string;
    pairedToolName?: string;
  },
) {
  const payload = `tool loop: sessionId=${params.sessionId ?? "unknown"} sessionKey=${
    params.sessionKey ?? "unknown"
  } tool=${params.toolName} level=${params.level} action=${params.action} detector=${
    params.detector
  } count=${params.count}${params.pairedToolName ? ` pairedTool=${params.pairedToolName}` : ""} message="${params.message}"`;
  if (params.level === "critical") {
    diag.error(payload);
  } else {
    diag.warn(payload);
  }
  emitDiagnosticEvent({
    type: "tool.loop",
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    toolName: params.toolName,
    level: params.level,
    action: params.action,
    detector: params.detector,
    count: params.count,
    message: params.message,
    pairedToolName: params.pairedToolName,
  });
  markActivity();
}

export function logActiveRuns() {
  const activeSessions = Array.from(diagnosticSessionStates.entries())
    .filter(([, s]) => s.state === "processing")
    .map(
      ([id, s]) =>
        `${id}(q=${s.queueDepth},age=${Math.round((Date.now() - s.lastActivity) / 1000)}s)`,
    );
  diag.debug(`active runs: count=${activeSessions.length} sessions=[${activeSessions.join(", ")}]`);
  markActivity();
}

let heartbeatInterval: NodeJS.Timeout | null = null;

export function startDiagnosticHeartbeat(
  config?: OpenClawConfig,
  opts?: { getConfig?: () => OpenClawConfig },
) {
  if (heartbeatInterval) {
    return;
  }
  heartbeatInterval = setInterval(() => {
    let heartbeatConfig = config;
    if (!heartbeatConfig) {
      try {
        heartbeatConfig = (opts?.getConfig ?? getRuntimeConfig)();
      } catch {
        heartbeatConfig = undefined;
      }
    }
    const stuckSessionWarnMs = resolveStuckSessionWarnMs(heartbeatConfig);
    const now = Date.now();
    pruneDiagnosticSessionStates(now, true);
    const activeCount = Array.from(diagnosticSessionStates.values()).filter(
      (s) => s.state === "processing",
    ).length;
    const waitingCount = Array.from(diagnosticSessionStates.values()).filter(
      (s) => s.state === "waiting",
    ).length;
    const totalQueued = Array.from(diagnosticSessionStates.values()).reduce(
      (sum, s) => sum + s.queueDepth,
      0,
    );
    const hasActivity =
      lastActivityAt > 0 ||
      webhookStats.received > 0 ||
      activeCount > 0 ||
      waitingCount > 0 ||
      totalQueued > 0;
    if (!hasActivity) {
      return;
    }
    if (now - lastActivityAt > 120_000 && activeCount === 0 && waitingCount === 0) {
      return;
    }

    const firstVisible = buildFirstVisibleSummary();
    const latency = buildLatencySummary();
    const earlyStatus = buildEarlyStatusSummary();
    diag.debug(
      `heartbeat: webhooks=${webhookStats.received}/${webhookStats.processed}/${webhookStats.errors} active=${activeCount} waiting=${waitingCount} queued=${totalQueued}${
        firstVisible
          ? ` firstVisible=${firstVisible.sampleCount} avg=${firstVisible.avgMs}ms p95=${firstVisible.p95Ms}ms max=${firstVisible.maxMs}ms`
          : ""
      }${formatLatencyHeartbeatSummary(latency)}${formatEarlyStatusHeartbeatSummary(earlyStatus)}`,
    );
    emitDiagnosticEvent({
      type: "diagnostic.heartbeat",
      webhooks: {
        received: webhookStats.received,
        processed: webhookStats.processed,
        errors: webhookStats.errors,
      },
      active: activeCount,
      waiting: waitingCount,
      queued: totalQueued,
      firstVisible,
      latency,
      earlyStatus,
    });

    void loadCommandPollBackoffRuntime()
      .then(({ pruneStaleCommandPolls }) => {
        for (const [, state] of diagnosticSessionStates) {
          pruneStaleCommandPolls(state);
        }
      })
      .catch((err) => {
        diag.debug(`command-poll-backoff prune failed: ${String(err)}`);
      });

    for (const [, state] of diagnosticSessionStates) {
      const ageMs = now - state.lastActivity;
      if (state.state === "processing" && ageMs > stuckSessionWarnMs) {
        logSessionStuck({
          sessionId: state.sessionId,
          sessionKey: state.sessionKey,
          state: state.state,
          ageMs,
        });
      }
    }
  }, 30_000);
  heartbeatInterval.unref?.();
}

export function stopDiagnosticHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

export function getRecentDiagnosticLatencySummary() {
  return buildLatencySummary();
}

export function getRecentDiagnosticEarlyStatusSummary() {
  return buildEarlyStatusSummary();
}

export function getDiagnosticSessionStateCountForTest(): number {
  return getDiagnosticSessionStateCountForTestImpl();
}

export function resetDiagnosticStateForTest(): void {
  resetDiagnosticSessionStateForTest();
  webhookStats.received = 0;
  webhookStats.processed = 0;
  webhookStats.errors = 0;
  webhookStats.lastReceived = 0;
  firstVisibleSamples.length = 0;
  for (const kind of Object.keys(firstVisibleSamplesByKind) as Array<
    keyof typeof firstVisibleSamplesByKind
  >) {
    firstVisibleSamplesByKind[kind].length = 0;
  }
  firstVisibleTimeoutCount = 0;
  for (const segment of Object.keys(latencySamples) as LatencySegmentName[]) {
    latencySamples[segment].length = 0;
  }
  for (const segment of Object.keys(latencyDominantCounts) as LatencySegmentName[]) {
    delete latencyDominantCounts[segment];
  }
  earlyStatusSamples.length = 0;
  for (const reason of Object.keys(earlyStatusReasonCounts)) {
    delete earlyStatusReasonCounts[reason];
  }
  turnLatencySnapshots.clear();
  lastActivityAt = 0;
  stopDiagnosticHeartbeat();
}

export { diag as diagnosticLogger };
export const __testing = {
  formatLatencyHeartbeatSummary,
  formatEarlyStatusHeartbeatSummary,
};
