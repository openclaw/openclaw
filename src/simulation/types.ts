import type { DiagnosticEventPayload } from "../infra/diagnostic-events.js";

// ── Seeded PRNG ──────────────────────────────────────────────────────

/** Fast seedable 32-bit PRNG (mulberry32). Returns values in [0, 1). */
export function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Messages ─────────────────────────────────────────────────────────

interface SimMessageBase {
  /** UUIDv7 — timestamp-sortable unique ID. */
  id: string;
  /** Unix timestamp (ms) when this message was created. */
  ts: number;
  /** Conversation this message belongs to. */
  conversationId: string;
  /** Message text content. */
  text: string;
  /** Lane this message was enqueued to. */
  lane?: string;
  /** Monotonic insertion order (tiebreaker for same-ms UUIDv7s). */
  seq: number;
}

export interface SimInboundMessage extends SimMessageBase {
  direction: "inbound";
  /** Sender ID for the injected user message. */
  senderId: string;
}

export interface SimOutboundMessage extends SimMessageBase {
  direction: "outbound";
  /** Agent that produced this message. */
  agentId: string;
  /** UUIDv7 of the most recent message the agent had in context. */
  causalParentId: string;
  /** Timestamp of that causal parent message. */
  causalParentTs: number;
  /** Time spent waiting in queue before agent run started (ms). */
  queueWaitMs?: number;
  /** Total agent run duration (ms). */
  runDurationMs?: number;
}

/** Discriminated union for simulation messages. */
export type SimMessage = SimInboundMessage | SimOutboundMessage;

// ── Symptoms ─────────────────────────────────────────────────────────

interface SimSymptomBase {
  severity: "info" | "warning" | "critical";
  ts: number;
  description: string;
}

export interface SimReplyExplosion extends SimSymptomBase {
  type: "reply_explosion";
  conversationId: string;
  inboundCount: number;
  outboundCount: number;
  ratio: number;
}

export interface SimStaleContext extends SimSymptomBase {
  type: "stale_context";
  messageId: string;
  /** How many messages behind the agent was. */
  staleness: number;
}

export interface SimQueueBacklog extends SimSymptomBase {
  type: "queue_backlog";
  lane: string;
  depth: number;
  threshold: number;
}

export interface SimLagDrift extends SimSymptomBase {
  type: "lag_drift";
  slopeMs: number;
  conversationId: string;
}

export interface SimOutOfSync extends SimSymptomBase {
  type: "out_of_sync";
  messageIds: [string, string];
  sharedCausalParentId: string;
}

/** Discriminated union for detected symptoms. */
export type SimSymptom =
  | SimReplyExplosion
  | SimStaleContext
  | SimQueueBacklog
  | SimLagDrift
  | SimOutOfSync;

// ── Thresholds ───────────────────────────────────────────────────────

export type SymptomThresholds = {
  reply_explosion?: { maxRatio: number };
  lag_drift?: { maxSlopeMs: number; windowMessages: number };
  queue_backlog?: { maxDepth: number; sustainedGrowthSamples: number };
  stale_context?: { maxStaleness: number };
  out_of_sync?: { enabled: boolean };
};

// ── Lane Snapshots & Timeline ────────────────────────────────────────

export interface LaneSnapshot {
  ts: number;
  lane: string;
  queued: number;
  active: number;
  maxConcurrent: number;
}

export interface QueueTimeline {
  snapshots: LaneSnapshot[];
  events: DiagnosticEventPayload[];
}

// ── Assertions ───────────────────────────────────────────────────────

export type SimAssertionConfig =
  | { type: "max_queue_depth"; lane: string; threshold: number }
  | { type: "max_reply_latency_ms"; threshold: number }
  | { type: "no_reply_explosion"; maxRepliesPerMessage: number }
  | { type: "no_stale_context"; maxStaleness: number }
  | { type: "no_symptoms"; severity?: "warning" | "critical" };

export type SimAssertionResult = {
  name: string;
  passed: boolean;
  actual: number | string;
  threshold: number | string;
};

// ── Report ───────────────────────────────────────────────────────────

export type SimSummary = {
  totalMessages: number;
  inbound: number;
  outbound: number;
  conversations: number;
  symptomCount: { critical: number; warning: number; info: number };
  /** Queue wait time percentiles (ms). */
  waitTimeP50?: number;
  waitTimeP95?: number;
  waitTimeP99?: number;
};

export type SimReport = {
  scenario: string;
  seed?: number;
  startedAt: string;
  durationMs: number;
  summary: SimSummary;
  messages: SimMessage[];
  timeline: QueueTimeline;
  symptoms: SimSymptom[];
  assertions: SimAssertionResult[];
};

// ── Scenario Config ──────────────────────────────────────────────────

export type ScenarioAgent = {
  id: string;
  provider: string;
  model: string;
};

export type ScenarioChannel = {
  type: string;
  accounts: { id: string }[];
};

export type ScenarioConversation = {
  id: string;
  channel: string;
  account: string;
  peer: string;
  chatType: "direct" | "group";
};

export type ScenarioProviderModel = {
  latencyMs: number;
  response: string;
  errorRate?: number;
};

export type ScenarioTraffic = {
  conversation: string;
  pattern: "burst" | "steady" | "random";
  count: number;
  intervalMs: number;
  startAtMs: number;
  senderIds: string[];
};

export type ScenarioMonitor = {
  sampleIntervalMs: number;
  captureEvents?: string[];
};

export type ScenarioConfig = {
  name: string;
  description?: string;
  seed?: number;
  agents: ScenarioAgent[];
  channels: ScenarioChannel[];
  conversations: ScenarioConversation[];
  providers: Record<string, { models: Record<string, ScenarioProviderModel> }>;
  traffic: ScenarioTraffic[];
  config?: {
    agents?: {
      defaults?: Record<string, unknown>;
    };
  };
  monitor?: ScenarioMonitor;
  symptoms?: SymptomThresholds;
  assertions?: SimAssertionConfig[];
};
