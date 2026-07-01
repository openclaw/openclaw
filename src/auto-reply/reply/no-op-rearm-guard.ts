// Pre-provider no-op replay guard (#1138/#1142).
//
// The incident family: a wake source presents work to a session, the session
// buys a provider turn, the turn has no substantive outcome, another same-family
// wake arrives, and the loop repeats at provider cadence. Wake sources include
// stale room-event backlog, durable continuation work, restart/pending-delivery
// /interrupted-run recovery, and status-loop work. The shared bug is self-rearm
// or wake-delivery granting provider turns without a fresh human edge or concrete
// state gain.
//
// This module is the runtime guard. It exposes pure classifiers (wake source and
// turn outcome) plus a bounded in-memory ledger that admits or suppresses a wake
// BEFORE provider construction and records the observed outcome AFTER the turn.
// Admission and recording are keyed per session; the streak only counts self-rearm
// no-op turns and resets on a fresh human edge or concrete completion.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { EmbeddedAgentRunResult } from "../../agents/embedded-agent.js";
import type { InboundEventKind } from "../../channels/inbound-event/kind.js";
import {
  type InputProvenance,
  shouldPreserveUserFacingSessionStateForInputProvenance,
} from "../../sessions/input-provenance.js";
import {
  isSilentReplyPayloadText,
  SILENT_REPLY_TOKEN,
  stripContinuationSignal,
} from "../tokens.js";

/** Provenance sourceTool used by restart/pending-delivery recovery replays. */
const RESTART_SENTINEL_SOURCE_TOOL = "restart-sentinel";

/**
 * Default consecutive self-rearm no-op turns (within the cadence window) before a
 * key's next self-rearm wake is suppressed. Conservative: the incident produced
 * hundreds of no-op turns, so a small threshold stops the storm quickly while
 * leaving margin for a short legitimate parking sequence.
 */
export const DEFAULT_NO_OP_REARM_THRESHOLD = 4;

/**
 * Cadence window for accumulating consecutive self-rearm no-ops. A no-op more than
 * this long after the previous one starts a fresh streak, so only rapid
 * provider-cadence self-rearm bursts accumulate. Slow/periodic self-rearm never
 * reaches the threshold.
 */
export const DEFAULT_NO_OP_REARM_WINDOW_MS = 5 * 60 * 1000;

const MAX_LEDGER_KEYS = 512;
const MAX_SEEN_MESSAGE_IDS = 64;
const MAX_RECORDED_RUN_IDS = 16;
const MAX_STREAK = 1_000_000;

/** Tools that carry no context gain when they are a turn's only output. */
const NO_OP_LOW_VALUE_TOOLS: ReadonlySet<string> = new Set([
  "sessions_yield",
  "continue_work",
  // `message` is low-value only when no reply was actually delivered (read/react,
  // failed/empty send). A delivered message surfaces via hasVisibleReply, which is
  // checked before tool names, so reaching the tool check means no visible reply.
  "message",
  "message_read",
  "message_react",
]);

// ---------------------------------------------------------------------------
// Wake-source classification (pure)
// ---------------------------------------------------------------------------

export type NoOpRearmSelfRearmSource =
  | "room_event_backlog"
  | "continuation"
  | "restart_recovery"
  | "recovery_replay"
  | "internal_system"
  | "human_replay";

export type NoOpRearmWakeClass =
  | { kind: "fresh_human_edge"; messageId?: string }
  | { kind: "structured_completion"; source: string }
  | { kind: "exempt_backend_wake"; source: "heartbeat" }
  | { kind: "neutral"; reason: string }
  | { kind: "self_rearm"; source: NoOpRearmSelfRearmSource };

export type NoOpRearmWakeInput = {
  sessionKey: string;
  /** Spec key precedence is flowId ?? chainId ?? sessionKey; see resolveNoOpRearmKey. */
  flowId?: string;
  chainId?: string;
  provenance?: InputProvenance | undefined;
  inboundEventKind?: InboundEventKind | undefined;
  messageId?: string | number | undefined;
  isHeartbeat?: boolean;
  isContinuationWake?: boolean;
  /**
   * Restart / pending-delivery / interrupted-run recovery replay. When omitted it
   * is derived from restart-sentinel provenance.
   */
  isRecoveryReplay?: boolean;
  /** Structured awaited-completion marker (concrete child/process/job completion). */
  awaitedCompletion?: boolean;
  /** Inbound event time; used to reject stale human edges when a staleness bound is set. */
  eventTimestampMs?: number;
  /**
   * Context only: parentRunId never changes the guard key or wake class. An aligned
   * parent/main session with a parentRunId stays parent/main self-rearm (#1138/#1142),
   * never a child split.
   */
  parentRunId?: string;
};

export type ClassifyWakeOptions = {
  nowMs?: number;
  /** When set, an external_user edge older than this is treated as stale backlog. */
  staleHumanEdgeAfterMs?: number;
};

function isRestartSentinelProvenance(provenance: InputProvenance | undefined): boolean {
  return (
    provenance?.kind === "internal_system" &&
    normalizeOptionalString(provenance.sourceTool)?.toLowerCase() === RESTART_SENTINEL_SOURCE_TOOL
  );
}

function normalizeMessageId(messageId: string | number | undefined): string | undefined {
  if (messageId === undefined || messageId === null) {
    return undefined;
  }
  return normalizeOptionalString(String(messageId));
}

/**
 * Classify a wake's source without ledger state. Message-id novelty (replay
 * detection) is applied at admission time where the ledger lives.
 */
export function classifyNoOpRearmWake(
  input: NoOpRearmWakeInput,
  opts: ClassifyWakeOptions = {},
): NoOpRearmWakeClass {
  const provenance = input.provenance;
  const isRoomEvent = input.inboundEventKind === "room_event";

  // Structured inter-session/backend completion (preserved completion source tools)
  // or an explicit awaited-completion marker is concrete context gain.
  if (input.awaitedCompletion === true) {
    return { kind: "structured_completion", source: "awaited_completion" };
  }
  if (shouldPreserveUserFacingSessionStateForInputProvenance(provenance)) {
    const sourceTool = normalizeOptionalString(provenance?.sourceTool) ?? "inter_session";
    return { kind: "structured_completion", source: sourceTool };
  }

  if (input.inboundEventKind === "user_request" && !isRoomEvent && provenance === undefined) {
    const messageId = normalizeMessageId(input.messageId);
    return messageId ? { kind: "fresh_human_edge", messageId } : { kind: "fresh_human_edge" };
  }

  // Fresh human edge: a direct external_user request that is not room-event backlog
  // and not obviously stale. Stale human backlog must not reset, and is guarded as
  // backlog like a room event.
  let staleHumanBacklog = false;
  if (provenance?.kind === "external_user" && !isRoomEvent) {
    const stale =
      opts.staleHumanEdgeAfterMs !== undefined &&
      input.eventTimestampMs !== undefined &&
      (opts.nowMs ?? Date.now()) - input.eventTimestampMs > opts.staleHumanEdgeAfterMs;
    if (!stale) {
      const messageId = normalizeMessageId(input.messageId);
      return messageId ? { kind: "fresh_human_edge", messageId } : { kind: "fresh_human_edge" };
    }
    staleHumanBacklog = true;
  }

  // A plain heartbeat timer wake is an explicit periodic backend wake (#1142
  // exception). It is admitted and never accrues or trips the self-rearm streak.
  // A heartbeat that emits continuation/room-event work is still guarded at that
  // self-rearm layer.
  if (
    input.isHeartbeat === true &&
    !isRoomEvent &&
    !staleHumanBacklog &&
    input.isContinuationWake !== true &&
    !input.isRecoveryReplay &&
    !isRestartSentinelProvenance(provenance)
  ) {
    return { kind: "exempt_backend_wake", source: "heartbeat" };
  }

  // Only positively-identified self-rearm / recovery sources are guarded. An
  // unmarked wake (no recognized provenance or marker) is neutral: it is admitted
  // and never accrues the streak, so the guard cannot false-block ordinary turns.
  // The incident's storm sources are all positively marked (room-event backlog,
  // continuation, restart/pending-delivery recovery, internal_system).
  const selfRearmSource = resolveSelfRearmSource(input, isRoomEvent || staleHumanBacklog);
  if (selfRearmSource === undefined) {
    return { kind: "neutral", reason: "unmarked-wake" };
  }
  return { kind: "self_rearm", source: selfRearmSource };
}

function resolveSelfRearmSource(
  input: NoOpRearmWakeInput,
  isRoomEvent: boolean,
): NoOpRearmSelfRearmSource | undefined {
  if (isRoomEvent) {
    return "room_event_backlog";
  }
  if (input.isContinuationWake === true) {
    return "continuation";
  }
  if (isRestartSentinelProvenance(input.provenance)) {
    return "restart_recovery";
  }
  if (input.isRecoveryReplay === true) {
    return "recovery_replay";
  }
  if (input.provenance?.kind === "internal_system") {
    return "internal_system";
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Turn-outcome classification (pure)
// ---------------------------------------------------------------------------

export type NoOpRearmTurnFacts = {
  /** A visible text/media reply was actually produced or delivered. */
  hasVisibleReply: boolean;
  /** Deduped tool names invoked during the turn. */
  toolNames: string[];
  /** Concrete completion / context gain (child spawn, cron add, approval prompt). */
  structuredCompletion: boolean;
  /** Terminal error/non-delivery with no useful output. */
  errorOnlyNoGain: boolean;
};

export type NoOpRearmTurnOutcome =
  | { kind: "substantive"; reason: string }
  | { kind: "structured_completion"; reason: string }
  | { kind: "no_op"; reason: string }
  | { kind: "error_no_gain"; reason: string };

function isNoReplyText(text: string | undefined): boolean {
  return isSilentReplyPayloadText(text, SILENT_REPLY_TOKEN);
}

function isContinuationMarkerOnlyText(text: string | undefined): boolean {
  const normalized = normalizeOptionalString(text);
  if (!normalized) {
    return false;
  }
  const stripped = stripContinuationSignal(normalized);
  return stripped.signal !== null && stripped.text.trim().length === 0;
}

function hasSubstantiveToolCall(toolNames: readonly string[]): boolean {
  return toolNames.some((name) => {
    const normalized = normalizeOptionalString(name)?.toLowerCase();
    return normalized ? !NO_OP_LOW_VALUE_TOOLS.has(normalized) : false;
  });
}

/** Build outcome facts from an embedded-agent run result. */
export function summarizeEmbeddedRunOutcome(
  result: EmbeddedAgentRunResult | undefined,
): NoOpRearmTurnFacts {
  const meta = result?.meta;
  const toolNames = meta?.toolSummary?.tools ?? [];

  const payloads = result?.payloads ?? [];
  const payloadVisible = payloads.some((payload) => {
    if (payload.isError === true || payload.isReasoning === true) {
      return false;
    }
    if (
      typeof payload.text === "string" &&
      payload.text.trim().length > 0 &&
      !isNoReplyText(payload.text) &&
      !isContinuationMarkerOnlyText(payload.text)
    ) {
      return true;
    }
    if (typeof payload.mediaUrl === "string" && payload.mediaUrl.trim().length > 0) {
      return true;
    }
    return Array.isArray(payload.mediaUrls) && payload.mediaUrls.length > 0;
  });
  const sentTexts = result?.messagingToolSentTexts ?? [];
  const sentMedia = result?.messagingToolSentMediaUrls ?? [];
  const deliveredViaMessaging =
    (result?.didSendViaMessagingTool === true && (sentTexts.length > 0 || sentMedia.length > 0)) ||
    result?.didDeliverSourceReplyViaMessageTool === true;
  const visibleAssistantText = normalizeOptionalString(
    meta?.finalAssistantVisibleText ?? meta?.finalAssistantRawText,
  );
  const visibleText =
    visibleAssistantText !== undefined &&
    !isNoReplyText(visibleAssistantText) &&
    !isContinuationMarkerOnlyText(visibleAssistantText) &&
    meta?.error?.kind !== "hook_block";
  const hasVisibleReply = payloadVisible || deliveredViaMessaging || visibleText;

  const structuredCompletion =
    (result?.acceptedSessionSpawns?.length ?? 0) > 0 ||
    (result?.successfulCronAdds ?? 0) > 0 ||
    result?.didSendDeterministicApprovalPrompt === true;

  const errorOnlyNoGain = Boolean(meta?.error) && !hasVisibleReply && !structuredCompletion;

  return { hasVisibleReply, toolNames, structuredCompletion, errorOnlyNoGain };
}

/**
 * Classify a completed turn. Critically (the #1141 Codex finding), a blank-text
 * turn that made substantive tool calls is substantive, NOT a no-op. No-op is a
 * blank/silent turn whose only tools are known low-value primitives.
 */
export function classifyNoOpRearmTurnOutcome(facts: NoOpRearmTurnFacts): NoOpRearmTurnOutcome {
  if (facts.structuredCompletion) {
    return { kind: "structured_completion", reason: "concrete-completion" };
  }
  if (facts.hasVisibleReply) {
    return { kind: "substantive", reason: "visible-reply" };
  }
  if (hasSubstantiveToolCall(facts.toolNames)) {
    return { kind: "substantive", reason: "substantive-tool-call" };
  }
  if (facts.errorOnlyNoGain) {
    return { kind: "error_no_gain", reason: "error-only-no-output" };
  }
  return {
    kind: "no_op",
    reason: facts.toolNames.length > 0 ? "low-value-tools-only" : "blank-or-silent",
  };
}

// ---------------------------------------------------------------------------
// Guard key
// ---------------------------------------------------------------------------

/**
 * Resolve the streak key. The spec is flowId ?? chainId ?? sessionKey; integrations
 * pass sessionKey because the post-turn outcome is recorded through the shared
 * per-session reply path, and scoping admission to a narrower flow/chain key than
 * its recording site would stop the streak from ever tripping.
 */
export function resolveNoOpRearmKey(input: {
  flowId?: string;
  chainId?: string;
  sessionKey: string;
}): string {
  return (
    normalizeOptionalString(input.flowId) ??
    normalizeOptionalString(input.chainId) ??
    input.sessionKey
  );
}

// ---------------------------------------------------------------------------
// Bounded ledger + admission / recording
// ---------------------------------------------------------------------------

export type NoOpRearmDiagnostic = {
  code: "noop-rearm-suppressed";
  key: string;
  sessionKey: string;
  wakeSource: NoOpRearmSelfRearmSource;
  streak: number;
  threshold: number;
  message: string;
};

export type NoOpRearmDecision =
  | { admit: true; reason: string; wake: NoOpRearmWakeClass }
  | {
      admit: false;
      reason: "no-op-streak";
      wake: NoOpRearmWakeClass;
      streak: number;
      diagnostic?: NoOpRearmDiagnostic;
    };

export type NoOpRearmRecordInput = {
  sessionKey: string;
  flowId?: string;
  chainId?: string;
  /** Wake class decided at admission; passed through so recording stays consistent. */
  wakeClass: NoOpRearmWakeClass;
  runId?: string;
  result?: EmbeddedAgentRunResult;
  facts?: NoOpRearmTurnFacts;
  outcome?: NoOpRearmTurnOutcome;
};

export type NoOpRearmGuardOptions = {
  threshold?: number;
  windowMs?: number;
  now?: () => number;
  staleHumanEdgeAfterMs?: number;
};

type LedgerEntry = {
  streak: number;
  lastNoOpAtMs?: number;
  lastWakeSource?: string;
  lastFreshHumanEdgeAtMs?: number;
  seenMessageIds: string[];
  diagnosedEpisode: boolean;
  lastDiagnosticAtMs?: number;
  recordedRunIds: string[];
  lastTouchedAtMs: number;
};

function pushBounded(list: string[], value: string, max: number): void {
  list.push(value);
  if (list.length > max) {
    list.splice(0, list.length - max);
  }
}

/**
 * Process-local, bounded safety memory. Lifecycle-owned and single-instance: the
 * streak is loop-detection cache, not durable user state, so it is rebuilt fresh
 * after a restart (a restart is itself a clean boundary). Bounded by key count and
 * by per-key id history.
 */
export class NoOpRearmGuard {
  private readonly entries = new Map<string, LedgerEntry>();
  private readonly threshold: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly staleHumanEdgeAfterMs: number | undefined;

  constructor(options: NoOpRearmGuardOptions = {}) {
    this.threshold = options.threshold ?? DEFAULT_NO_OP_REARM_THRESHOLD;
    this.windowMs = options.windowMs ?? DEFAULT_NO_OP_REARM_WINDOW_MS;
    this.now = options.now ?? Date.now;
    this.staleHumanEdgeAfterMs = options.staleHumanEdgeAfterMs;
  }

  private classifyOptions(): ClassifyWakeOptions {
    return {
      nowMs: this.now(),
      ...(this.staleHumanEdgeAfterMs !== undefined
        ? { staleHumanEdgeAfterMs: this.staleHumanEdgeAfterMs }
        : {}),
    };
  }

  private getEntry(key: string): LedgerEntry {
    const existing = this.entries.get(key);
    if (existing) {
      existing.lastTouchedAtMs = this.now();
      return existing;
    }
    if (this.entries.size >= MAX_LEDGER_KEYS) {
      this.evictOldest();
    }
    const created: LedgerEntry = {
      streak: 0,
      seenMessageIds: [],
      diagnosedEpisode: false,
      recordedRunIds: [],
      lastTouchedAtMs: this.now(),
    };
    this.entries.set(key, created);
    return created;
  }

  private evictOldest(): void {
    let oldestKey: string | undefined;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [key, entry] of this.entries) {
      if (entry.lastTouchedAtMs < oldestAt) {
        oldestAt = entry.lastTouchedAtMs;
        oldestKey = key;
      }
    }
    if (oldestKey !== undefined) {
      this.entries.delete(oldestKey);
    }
  }

  private resetEntry(entry: LedgerEntry): void {
    entry.streak = 0;
    entry.lastNoOpAtMs = undefined;
    entry.diagnosedEpisode = false;
  }

  /** Decide whether a wake may buy a provider turn. Side effects are idempotent per wake. */
  evaluate(input: NoOpRearmWakeInput): NoOpRearmDecision {
    const key = resolveNoOpRearmKey(input);
    const entry = this.getEntry(key);
    let wake = classifyNoOpRearmWake(input, this.classifyOptions());

    if (wake.kind === "fresh_human_edge") {
      const messageId = wake.messageId;
      const isReplay = messageId !== undefined && entry.seenMessageIds.includes(messageId);
      if (!isReplay) {
        this.resetEntry(entry);
        entry.lastFreshHumanEdgeAtMs = this.now();
        if (messageId !== undefined) {
          pushBounded(entry.seenMessageIds, messageId, MAX_SEEN_MESSAGE_IDS);
        }
        return { admit: true, reason: "fresh-human-edge", wake };
      }
      // A redelivery of an already-seen human message id is a replay, not a fresh
      // edge: treat it as self-rearm so a stuck replay loop is bounded.
      wake = { kind: "self_rearm", source: "human_replay" };
    }

    if (wake.kind === "structured_completion") {
      this.resetEntry(entry);
      return { admit: true, reason: "structured-completion", wake };
    }

    if (wake.kind === "exempt_backend_wake") {
      return { admit: true, reason: "exempt-backend-wake", wake };
    }

    if (wake.kind === "neutral") {
      return { admit: true, reason: "neutral", wake };
    }

    // self_rearm
    entry.lastWakeSource = wake.source;
    if (entry.lastNoOpAtMs !== undefined && this.now() - entry.lastNoOpAtMs > this.windowMs) {
      this.resetEntry(entry);
    }
    if (entry.streak >= this.threshold) {
      const diagnostic = entry.diagnosedEpisode
        ? undefined
        : this.buildDiagnostic(key, input.sessionKey, wake.source, entry.streak);
      if (!entry.diagnosedEpisode) {
        entry.diagnosedEpisode = true;
        entry.lastDiagnosticAtMs = this.now();
      }
      return diagnostic
        ? { admit: false, reason: "no-op-streak", wake, streak: entry.streak, diagnostic }
        : { admit: false, reason: "no-op-streak", wake, streak: entry.streak };
    }
    return { admit: true, reason: "below-threshold", wake };
  }

  /** Record an observed turn outcome. Idempotent per runId; only self-rearm no-ops accrue. */
  record(input: NoOpRearmRecordInput): NoOpRearmTurnOutcome {
    const key = resolveNoOpRearmKey(input);
    const entry = this.getEntry(key);

    const runId = normalizeOptionalString(input.runId);
    if (runId !== undefined) {
      if (entry.recordedRunIds.includes(runId)) {
        return input.outcome ?? this.resolveOutcome(input);
      }
      pushBounded(entry.recordedRunIds, runId, MAX_RECORDED_RUN_IDS);
    }

    const outcome = input.outcome ?? this.resolveOutcome(input);

    if (outcome.kind === "substantive" || outcome.kind === "structured_completion") {
      this.resetEntry(entry);
      return outcome;
    }

    // no_op / error_no_gain: accrue only for self-rearm wakes. A no-op response to
    // a fresh human edge, a structured completion, or an exempt heartbeat does not
    // build the self-rearm storm streak.
    if (input.wakeClass.kind === "self_rearm") {
      const now = this.now();
      const withinWindow =
        entry.lastNoOpAtMs !== undefined && now - entry.lastNoOpAtMs <= this.windowMs;
      entry.streak = withinWindow ? Math.min(entry.streak + 1, MAX_STREAK) : 1;
      entry.lastNoOpAtMs = now;
      entry.lastWakeSource = input.wakeClass.source;
    }
    return outcome;
  }

  private resolveOutcome(input: NoOpRearmRecordInput): NoOpRearmTurnOutcome {
    return classifyNoOpRearmTurnOutcome(input.facts ?? summarizeEmbeddedRunOutcome(input.result));
  }

  private buildDiagnostic(
    key: string,
    sessionKey: string,
    wakeSource: NoOpRearmSelfRearmSource,
    streak: number,
  ): NoOpRearmDiagnostic {
    return {
      code: "noop-rearm-suppressed",
      key,
      sessionKey,
      wakeSource,
      streak,
      threshold: this.threshold,
      message:
        `[noop-rearm-guard] suppressed self-rearm provider turn for session=${sessionKey} ` +
        `source=${wakeSource} streak=${streak}/${this.threshold}; no fresh human edge or concrete completion.`,
    };
  }

  /** Snapshot of a key's streak; for tests and diagnostics only. */
  peekStreak(input: { flowId?: string; chainId?: string; sessionKey: string }): number {
    return this.entries.get(resolveNoOpRearmKey(input))?.streak ?? 0;
  }

  /** Drop all ledger state. Lifecycle/test reset. */
  clear(): void {
    this.entries.clear();
  }
}

let defaultGuard = new NoOpRearmGuard();

/** Replace the process singleton (lifecycle reset / tests). */
export function resetNoOpRearmGuard(options?: NoOpRearmGuardOptions): void {
  defaultGuard = new NoOpRearmGuard(options);
}

/** Pre-provider admission against the process singleton. */
export function evaluateNoOpRearmAdmission(input: NoOpRearmWakeInput): NoOpRearmDecision {
  return defaultGuard.evaluate(input);
}

/** Post-turn outcome recording against the process singleton. */
export function recordNoOpRearmOutcome(input: NoOpRearmRecordInput): NoOpRearmTurnOutcome {
  return defaultGuard.record(input);
}
