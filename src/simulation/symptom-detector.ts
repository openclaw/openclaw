import type {
  LaneSnapshot,
  QueueTimeline,
  SimLagDrift,
  SimMessage,
  SimOutOfSync,
  SimOutboundMessage,
  SimQueueBacklog,
  SimReplyExplosion,
  SimStaleContext,
  SimSymptom,
  SymptomThresholds,
} from "./types.js";

// ── EWMA for lag drift detection ─────────────────────────────────────

class EWMADetector {
  private ewma = 0;
  private initialized = false;
  constructor(private alpha = 0.3) {}

  update(waitMs: number): number {
    if (!this.initialized) {
      this.ewma = waitMs;
      this.initialized = true;
    } else {
      this.ewma = this.alpha * waitMs + (1 - this.alpha) * this.ewma;
    }
    return this.ewma;
  }

  get value(): number {
    return this.ewma;
  }
}

// ── Default thresholds ───────────────────────────────────────────────

const DEFAULTS: Required<SymptomThresholds> = {
  reply_explosion: { maxRatio: 1.5, windowMs: 10_000 },
  lag_drift: { maxSlopeMs: 200, windowMessages: 10 },
  queue_backlog: { maxDepth: 20, sustainedGrowthSamples: 5 },
  stale_context: { maxStaleness: 3 },
  out_of_sync: { enabled: true },
};

// ── Detection functions ──────────────────────────────────────────────

function detectReplyExplosions(
  messages: readonly SimMessage[],
  thresholds: SymptomThresholds,
  symptoms: SimSymptom[],
): void {
  const cfg = thresholds.reply_explosion ?? DEFAULTS.reply_explosion;
  const byConv = new Map<string, { inbound: number; outbound: number }>();
  for (const msg of messages) {
    let counts = byConv.get(msg.conversationId);
    if (!counts) {
      counts = { inbound: 0, outbound: 0 };
      byConv.set(msg.conversationId, counts);
    }
    if (msg.direction === "inbound") {
      counts.inbound++;
    } else {
      counts.outbound++;
    }
  }
  for (const [convId, counts] of byConv) {
    if (counts.inbound === 0) {
      continue;
    }
    const ratio = counts.outbound / counts.inbound;
    if (ratio > cfg.maxRatio) {
      const s: SimReplyExplosion = {
        type: "reply_explosion",
        severity: ratio > cfg.maxRatio * 2 ? "critical" : "warning",
        ts: Date.now(),
        description: `Reply explosion in ${convId}: ${counts.outbound} replies for ${counts.inbound} messages (ratio ${ratio.toFixed(2)})`,
        conversationId: convId,
        inboundCount: counts.inbound,
        outboundCount: counts.outbound,
        ratio,
      };
      symptoms.push(s);
    }
  }
}

function detectLagDrift(
  messages: readonly SimMessage[],
  thresholds: SymptomThresholds,
  symptoms: SimSymptom[],
): void {
  const cfg = thresholds.lag_drift ?? DEFAULTS.lag_drift;
  // Group outbound messages by conversation and track EWMA of queueWaitMs
  const byConv = new Map<string, SimOutboundMessage[]>();
  for (const msg of messages) {
    if (msg.direction !== "outbound") {
      continue;
    }
    if (msg.queueWaitMs === undefined) {
      continue;
    }
    let list = byConv.get(msg.conversationId);
    if (!list) {
      list = [];
      byConv.set(msg.conversationId, list);
    }
    list.push(msg);
  }

  for (const [convId, outMsgs] of byConv) {
    if (outMsgs.length < cfg.windowMessages) {
      continue;
    }
    const detector = new EWMADetector(0.3);
    let prevEwma = 0;
    let drifting = false;
    for (const msg of outMsgs) {
      // Safe: only messages with defined queueWaitMs were collected above
      const ewma = detector.update(msg.queueWaitMs ?? 0);
      const slope = ewma - prevEwma;
      if (slope > cfg.maxSlopeMs) {
        drifting = true;
      }
      prevEwma = ewma;
    }
    if (drifting) {
      const s: SimLagDrift = {
        type: "lag_drift",
        severity: "warning",
        ts: Date.now(),
        description: `Lag drift detected in ${convId}: queue wait times increasing (EWMA slope > ${cfg.maxSlopeMs}ms)`,
        slopeMs: detector.value,
        conversationId: convId,
      };
      symptoms.push(s);
    }
  }
}

function detectQueueBacklog(
  timeline: QueueTimeline,
  thresholds: SymptomThresholds,
  symptoms: SimSymptom[],
): void {
  const cfg = thresholds.queue_backlog ?? DEFAULTS.queue_backlog;
  // Group snapshots by lane and check if any exceeded threshold
  const byLane = new Map<string, LaneSnapshot[]>();
  for (const snap of timeline.snapshots) {
    let list = byLane.get(snap.lane);
    if (!list) {
      list = [];
      byLane.set(snap.lane, list);
    }
    list.push(snap);
  }

  for (const [lane, snaps] of byLane) {
    let consecutiveGrowth = 0;
    let prevDepth = 0;
    let maxDepth = 0;
    for (const snap of snaps) {
      const depth = snap.queued + snap.active;
      maxDepth = Math.max(maxDepth, depth);
      if (depth > prevDepth) {
        consecutiveGrowth++;
      } else {
        consecutiveGrowth = 0;
      }
      prevDepth = depth;
    }
    if (maxDepth > cfg.maxDepth || consecutiveGrowth >= cfg.sustainedGrowthSamples) {
      const s: SimQueueBacklog = {
        type: "queue_backlog",
        severity: maxDepth > cfg.maxDepth * 2 ? "critical" : "warning",
        ts: Date.now(),
        description: `Queue backlog on lane ${lane}: depth=${maxDepth} (threshold=${cfg.maxDepth}), consecutive growth=${consecutiveGrowth}`,
        lane,
        depth: maxDepth,
        threshold: cfg.maxDepth,
      };
      symptoms.push(s);
    }
  }
}

function detectStaleContext(
  messages: readonly SimMessage[],
  thresholds: SymptomThresholds,
  symptoms: SimSymptom[],
): void {
  const cfg = thresholds.stale_context ?? DEFAULTS.stale_context;
  // Build conversation message lists
  const byConv = new Map<string, SimMessage[]>();
  for (const msg of messages) {
    let list = byConv.get(msg.conversationId);
    if (!list) {
      list = [];
      byConv.set(msg.conversationId, list);
    }
    list.push(msg);
  }
  const byId = new Map<string, SimMessage>();
  for (const msg of messages) {
    byId.set(msg.id, msg);
  }

  for (const msg of messages) {
    if (msg.direction !== "outbound") {
      continue;
    }
    if (!msg.causalParentId) {
      continue;
    }
    const parent = byId.get(msg.causalParentId);
    if (!parent) {
      continue;
    }
    const convMsgs = byConv.get(msg.conversationId) ?? [];
    let missed = 0;
    for (const convMsg of convMsgs) {
      if (convMsg.direction !== "inbound") {
        continue;
      }
      if (convMsg.ts > parent.ts && convMsg.ts < msg.ts) {
        missed++;
      }
    }
    if (missed >= cfg.maxStaleness) {
      const s: SimStaleContext = {
        type: "stale_context",
        severity: missed >= cfg.maxStaleness * 2 ? "critical" : "warning",
        ts: Date.now(),
        description: `Stale context: agent reply ${msg.id} was ${missed} messages behind in ${msg.conversationId}`,
        messageId: msg.id,
        staleness: missed,
      };
      symptoms.push(s);
    }
  }
}

function detectOutOfSync(
  messages: readonly SimMessage[],
  thresholds: SymptomThresholds,
  symptoms: SimSymptom[],
): void {
  const cfg = thresholds.out_of_sync ?? DEFAULTS.out_of_sync;
  if (!cfg.enabled) {
    return;
  }

  // Group outbound by (conversationId, causalParentId) — if two outbound
  // messages share the same causal parent in the same conversation, neither
  // agent saw the other's reply.
  const groups = new Map<string, SimOutboundMessage[]>();
  for (const msg of messages) {
    if (msg.direction !== "outbound") {
      continue;
    }
    if (!msg.causalParentId) {
      continue;
    }
    const key = `${msg.conversationId}:${msg.causalParentId}`;
    let list = groups.get(key);
    if (!list) {
      list = [];
      groups.set(key, list);
    }
    list.push(msg);
  }

  for (const group of groups.values()) {
    if (group.length < 2) {
      continue;
    }
    // Report each pair
    for (let i = 0; i < group.length - 1; i++) {
      const s: SimOutOfSync = {
        type: "out_of_sync",
        severity: "warning",
        ts: Date.now(),
        description: `Out-of-sync: messages ${group[i].id} and ${group[i + 1].id} share causal parent ${group[i].causalParentId}`,
        messageIds: [group[i].id, group[i + 1].id],
        sharedCausalParentId: group[i].causalParentId,
      };
      symptoms.push(s);
    }
  }
}

// ── Public API ────────────────────────────────────────────────────────

export function detectSymptoms(params: {
  messages: readonly SimMessage[];
  timeline: QueueTimeline;
  thresholds?: SymptomThresholds;
}): SimSymptom[] {
  const thresholds = params.thresholds ?? {};
  const symptoms: SimSymptom[] = [];

  detectReplyExplosions(params.messages, thresholds, symptoms);
  detectLagDrift(params.messages, thresholds, symptoms);
  detectQueueBacklog(params.timeline, thresholds, symptoms);
  detectStaleContext(params.messages, thresholds, symptoms);
  detectOutOfSync(params.messages, thresholds, symptoms);

  return symptoms;
}
