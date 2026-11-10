import {
  readAssistantStreamSegmentIdentity,
  readSessionMessageIdentity,
} from "@openclaw/gateway-client/browser";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { resolveAssistantMessagePhase } from "../../../../src/shared/chat-message-content.js";
import { isContractToolCallBlock } from "../../../../src/shared/tool-block-contract.js";
import { extractText } from "../../lib/chat/message-extract.js";
import {
  areUiSessionKeysEquivalent,
  normalizeDefaultMainSessionAliasForUi,
} from "../../lib/sessions/session-key.ts";
import { persistedSteerTargetRunId } from "./stream-causal-boundary.ts";

type LiveTerminalIdentity = {
  runId: string;
  disposition?: "aborted" | "error" | "timeout";
};

const liveTerminalIdentities = new WeakMap<object, LiveTerminalIdentity>();
// Outcomes land beside published history arrays; caches keyed by them key this too.
let liveTerminalRevision = 0;
// One armed record per run: two finals can land in one history page without
// either displacing the other's retirement (#149153).
const authoritativeTerminals = new WeakMap<object, Map<string, AuthoritativeTerminal>>();
// Terminals whose run still read active at persistence time; the history reload
// that owns them promotes the record so the live copy retires (#149153).
const pendingAuthoritativeTerminals = new WeakMap<
  object,
  Map<string, PendingAuthoritativeTerminal>
>();
// Late chat.final replays consult historyApplied, so applied records must
// outlive their runs; cap them so long-lived panes stay bounded. The
// pre-#149153 design retained a single slot, so this is strictly safer.
// Eviction runs at arm time only: a hydration flow's history filter and pane
// cleanup must read one consistent applied snapshot (#149153).
const APPLIED_TERMINAL_RETENTION = 64;

type AuthoritativeTerminal = {
  historyApplied: boolean;
  messageId: string;
  runId: string;
  sessionKey: string;
};

type PendingAuthoritativeTerminal = {
  messageId: string;
  runId: string;
  sessionKey: string;
};

/**
 * A saved row owns the run's final reply when it carries non-commentary text or
 * displayable media; tool-call continuations never own it (#149153).
 */
function ownsFinalReply(message: unknown): boolean {
  if (readAssistantStreamSegmentIdentity(message) !== undefined) {
    return false;
  }
  // The canonical phase owner decides commentary vs answer; reading the raw
  // signature here would drift from that contract (#149153).
  if (resolveAssistantMessagePhase(message) === "commentary") {
    return false;
  }
  const content = asNullableRecord(message)?.content;
  // A row that carries a tool invocation is a continuation, not the answer:
  // owning it would suppress the real final that the run still owes (#149153).
  if (Array.isArray(content) && content.some((block) => isContractToolCallBlock(block))) {
    return false;
  }
  if (extractText(message)?.trim()) {
    return true;
  }
  // A pure-media final (an image answer) owns the run's terminal through its
  // displayable non-text blocks: a text-only check would leave it unarmed and
  // rendering beside its persisted row twice (#149153).
  return Array.isArray(content) && content.some((block) => isDisplayableMediaBlock(block));
}

function isDisplayableMediaBlock(block: unknown): boolean {
  const record = asNullableRecord(block);
  if (record?.type !== "image") {
    return false;
  }
  // Persisted media carries an artifact id; inline projections carry a source.
  return (
    (typeof record.artifactId === "string" && record.artifactId.trim().length > 0) ||
    asNullableRecord(record.source) !== null
  );
}

/**
 * Stream-materialized projections carry no session identity and no live-terminal
 * tag, so retirement must also claim unkeyed fallbacks attributed to an applied
 * run; keyed (itemId) segments are commentary that keeps its place beside the
 * final (#149153).
 */
export function isUnkeyedStreamProjectionForRuns(
  message: unknown,
  appliedRunIds: ReadonlySet<string>,
): boolean {
  const identity = readSessionMessageIdentity(message);
  if (identity?.id || identity?.role !== "assistant") {
    return false;
  }
  if (readAssistantStreamSegmentIdentity(message) !== undefined) {
    return false;
  }
  const fallback = asNullableRecord(asNullableRecord(message)?.openclawStreamFallback);
  if (!fallback) {
    return false;
  }
  return typeof fallback.runId === "string" && appliedRunIds.has(fallback.runId);
}

/** Any live projection of a run whose authoritative terminal is in history. */
export function isSupersededLiveProjection(
  message: unknown,
  appliedRunIds: ReadonlySet<string>,
): boolean {
  const liveRunId = readLiveTerminalRunId(message);
  if (liveRunId && appliedRunIds.has(liveRunId)) {
    return true;
  }
  return isUnkeyedStreamProjectionForRuns(message, appliedRunIds);
}

/**
 * Records are scoped per session: a host that reuses a run id in another
 * session must not overwrite or borrow the first session's record (#149153).
 * Session aliases normalize to one identity so exact-key reads agree with
 * the equivalence-based reads everywhere else.
 */
function terminalRecordKey(sessionKey: string, runId: string): string {
  return `${normalizeDefaultMainSessionAliasForUi(sessionKey)}\u0000${runId}`;
}

function trimAppliedTerminals(host: object): void {
  const terminals = authoritativeTerminals.get(host);
  if (!terminals) {
    return;
  }
  let appliedCount = 0;
  for (const terminal of terminals.values()) {
    if (terminal.historyApplied) {
      appliedCount += 1;
    }
  }
  if (appliedCount <= APPLIED_TERMINAL_RETENTION) {
    return;
  }
  for (const [key, terminal] of terminals) {
    if (appliedCount <= APPLIED_TERMINAL_RETENTION) {
      break;
    }
    if (!terminal.historyApplied) {
      continue;
    }
    terminals.delete(key);
    appliedCount -= 1;
  }
}

function setAuthoritativeTerminal(host: object, record: AuthoritativeTerminal): void {
  const terminals = authoritativeTerminals.get(host) ?? new Map<string, AuthoritativeTerminal>();
  terminals.set(terminalRecordKey(record.sessionKey, record.runId), record);
  authoritativeTerminals.set(host, terminals);
  trimAppliedTerminals(host);
}

/** Associates a live terminal projection with its run without altering transcript bytes. */
export function rememberLiveTerminalRun(
  message: unknown,
  runId: string | null | undefined,
  disposition?: LiveTerminalIdentity["disposition"],
): unknown {
  if (runId && message && typeof message === "object") {
    liveTerminalIdentities.set(message, {
      runId,
      ...(disposition ? { disposition } : {}),
    });
    liveTerminalRevision += 1;
  }
  return message;
}

export function readLiveTerminalRevision(): number {
  return liveTerminalRevision;
}

export function isLiveTerminalForRun(message: unknown, runId: string): boolean {
  return readLiveTerminalRunId(message) === runId;
}

function readLiveTerminalIdentity(message: unknown): LiveTerminalIdentity | undefined {
  return message && typeof message === "object" ? liveTerminalIdentities.get(message) : undefined;
}

export function readLiveTerminalRunId(message: unknown): string | null {
  return readLiveTerminalIdentity(message)?.runId ?? null;
}

/** A presentation clone carries the same outcome without publishing a new one. */
export function copyLiveTerminalIdentity(source: unknown, target: object): void {
  const identity = readLiveTerminalIdentity(source);
  if (identity) {
    liveTerminalIdentities.set(target, identity);
  }
}

export function readLiveTerminalDisposition(
  message: unknown,
): LiveTerminalIdentity["disposition"] | null {
  return readLiveTerminalIdentity(message)?.disposition ?? null;
}

export function rememberAuthoritativeTerminal(options: {
  event: {
    clientRunId?: string | null;
    hasActiveRun?: boolean | null;
    key: string;
    runId?: string | null;
  };
  host: object;
  matchesChat: boolean;
  payload: unknown;
  runIdBeforeApply: string | null;
}): void {
  const payload = asNullableRecord(options.payload);
  const identity = readSessionMessageIdentity(payload?.message, {
    messageId: payload?.messageId,
  });
  const messageId = identity?.role === "assistant" && !identity.isImported ? identity.id : null;
  if (!options.runIdBeforeApply || !options.matchesChat || !messageId) {
    return;
  }
  if (!ownsFinalReply(payload?.message)) {
    return;
  }
  const runId = options.event.clientRunId ?? options.event.runId ?? options.runIdBeforeApply;
  if (options.event.hasActiveRun === true) {
    // The persisted final landed while its run still reads active. Keep it pending:
    // the history reload that owns the terminal arms it before reconcile applies,
    // otherwise the live terminal copy is never retired and renders twice (#149153).
    const pendingByRun =
      pendingAuthoritativeTerminals.get(options.host) ??
      new Map<string, PendingAuthoritativeTerminal>();
    pendingByRun.set(terminalRecordKey(options.event.key, runId), {
      messageId,
      runId,
      sessionKey: options.event.key,
    });
    pendingAuthoritativeTerminals.set(options.host, pendingByRun);
    return;
  }
  setAuthoritativeTerminal(options.host, {
    historyApplied: false,
    messageId,
    runId,
    sessionKey: options.event.key,
  });
}

/**
 * Arms a terminal deferred by an active run once the applied history carries that
 * terminal. Single promotion owner: every history reload path converges here, so
 * chat.final and session reconciliation both retire the live copy (#149153).
 */
export function armPendingAuthoritativeTerminalForHistory(options: {
  host: object;
  sessionKey: string;
  visibleMessages: readonly unknown[];
}): void {
  const pendingByRun = pendingAuthoritativeTerminals.get(options.host);
  if (!pendingByRun) {
    return;
  }
  for (const [key, pending] of pendingByRun) {
    if (!areUiSessionKeysEquivalent(pending.sessionKey, options.sessionKey)) {
      continue;
    }
    const historyHasTerminal = options.visibleMessages.some((message) => {
      const identity = readSessionMessageIdentity(message);
      return (
        identity?.role === "assistant" && !identity.isImported && identity.id === pending.messageId
      );
    });
    if (!historyHasTerminal) {
      continue;
    }
    pendingByRun.delete(key);
    // The applied fast path is scoped to the pending's own session: another
    // session's record for the same run id must not block this promotion (#149153).
    // Only the SAME applied terminal blocks re-arming: a different pending
    // messageId is the run's newer reply, and its row in this history must
    // replace even an applied predecessor so the pane converges (#149153).
    const settled = authoritativeTerminals
      .get(options.host)
      ?.get(terminalRecordKey(pending.sessionKey, pending.runId));
    if (settled?.historyApplied && settled.messageId === pending.messageId) {
      continue;
    }
    setAuthoritativeTerminal(options.host, {
      historyApplied: false,
      messageId: pending.messageId,
      runId: pending.runId,
      sessionKey: pending.sessionKey,
    });
  }
  if (pendingByRun.size === 0) {
    pendingAuthoritativeTerminals.delete(options.host);
  }
}

/**
 * Marks every armed terminal whose row the applied history actually carries.
 * Returns the applied run ids so callers can retire live projections of those
 * runs wherever they render (#149153).
 */
export function applyAuthoritativeTerminalsForHistory(options: {
  host: object;
  sessionKey: string;
  visibleMessages: readonly unknown[];
}): ReadonlySet<string> {
  const applied = new Set<string>();
  const terminals = authoritativeTerminals.get(options.host);
  if (!terminals?.size) {
    return applied;
  }
  for (const [key, terminal] of terminals) {
    // Session scope gates even the applied fast path: a host that switched
    // sessions must not lend another session's applied run ids (#149153).
    if (!areUiSessionKeysEquivalent(terminal.sessionKey, options.sessionKey)) {
      continue;
    }
    // A steer row after this terminal's own row fences the record on this
    // read: the run owes a newer reply whose durable row the read does not
    // carry, so the run must not join the retirement set on either path —
    // repeated stale reads included. The durable historyApplied flag keeps its
    // replay-suppression meaning; a stale read never retracts it (#149153).
    const fenced = authoritativeTerminalFencedBySteer({
      host: options.host,
      messages: options.visibleMessages,
      runId: terminal.runId,
      sessionKey: options.sessionKey,
    });
    if (terminal.historyApplied) {
      if (fenced) {
        continue;
      }
      applied.add(terminal.runId);
      continue;
    }
    const historyHasTerminal = options.visibleMessages.some((message) => {
      const identity = readSessionMessageIdentity(message);
      return (
        identity?.role === "assistant" && !identity.isImported && identity.id === terminal.messageId
      );
    });
    if (!historyHasTerminal) {
      continue;
    }
    terminals.set(key, { ...terminal, historyApplied: true });
    if (!fenced) {
      applied.add(terminal.runId);
    }
  }
  return applied;
}

export function reconcileAuthoritativeTerminalHistory<T>(options: {
  appliedRunIds?: ReadonlySet<string>;
  host: object;
  previousMessages: T[];
  sessionKey: string;
  visibleMessages: T[];
}): T[] {
  // Callers that also retire pane rows pass the same effective set from one
  // apply pass, so the filter and the cleanup read one snapshot (#149153).
  const appliedRunIds = options.appliedRunIds ?? applyAuthoritativeTerminalsForHistory(options);
  if (!appliedRunIds.size) {
    return options.previousMessages;
  }
  return options.previousMessages.filter(
    (message) => !isSupersededLiveProjection(message, appliedRunIds),
  );
}

export function authoritativeHistoryAppliedForRun(
  host: object,
  runId: string,
  sessionKey: string,
): boolean {
  const terminal = authoritativeTerminals.get(host)?.get(terminalRecordKey(sessionKey, runId));
  if (!terminal || !terminal.historyApplied) {
    return false;
  }
  // Session-scoped: a host that switched sessions must not lend another
  // session's applied flag to a replaying final with a colliding run id (#149153).
  return areUiSessionKeysEquivalent(terminal.sessionKey, sessionKey);
}

/**
 * A steered run can persist pre-steer text while it still reads active; the
 * history reload that carries that row applies it, but a steer row after it
 * fences the terminal: the run's next chat.final is the post-steer answer, not
 * a replay, so the gateway must not discard it (#149153).
 */
export function authoritativeTerminalFencedBySteer(options: {
  host: object;
  messages: readonly unknown[];
  runId: string;
  sessionKey: string;
}): boolean {
  const terminal = authoritativeTerminals
    .get(options.host)
    ?.get(terminalRecordKey(options.sessionKey, options.runId));
  if (!terminal) {
    return false;
  }
  let terminalIndex = -1;
  let steerIndex = -1;
  for (let index = 0; index < options.messages.length; index += 1) {
    const message = options.messages[index];
    const identity = readSessionMessageIdentity(message);
    if (
      identity?.role === "assistant" &&
      !identity.isImported &&
      identity.id === terminal.messageId
    ) {
      terminalIndex = index;
    } else if (identity?.role === "user" && persistedSteerTargetRunId(message) === options.runId) {
      steerIndex = index;
    }
  }
  // A steer with no terminal row in view still fences: every projection places
  // the applied pre-steer row before the steer that caused its reload (#149153).
  return steerIndex >= 0 && steerIndex > terminalIndex;
}

export function normalizeFinalAssistantMessage(message: unknown): Record<string, unknown> | null {
  const candidate = asNullableRecord(message);
  if (
    !candidate ||
    (typeof candidate.role === "string" &&
      normalizeLowercaseStringOrEmpty(candidate.role) !== "assistant") ||
    (!("content" in candidate) && typeof candidate.text !== "string")
  ) {
    return null;
  }
  const assistant =
    typeof candidate.role === "string" ? candidate : { ...candidate, role: "assistant" };
  // Canonicalize text-only finals before reducing so replay identity includes the reply.
  return !Object.hasOwn(assistant, "content") && typeof assistant.text === "string"
    ? { ...assistant, content: [{ type: "text", text: assistant.text }] }
    : assistant;
}
