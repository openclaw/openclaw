import type { StatusFooterMode } from "../config/types.messages.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatDurationCompact } from "../infra/format-time/format-duration.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("channels/status-footer");
const MAX_ACTIVITY_CHARS = 60;
export const STATUS_FOOTER_MAX_RENDERED_CHARS = 384;
const MAX_TERMINAL_RUNS = 4_096;

type StatusFooterRecord = {
  messageId: string;
  textWithoutFooter: string;
  footerText: string;
  runId?: string;
  edit: (messageId: string, text: string) => Promise<void>;
};

type StatusFooterActivity = {
  line: string;
  runId?: string;
};

type PendingStrip = Pick<StatusFooterRecord, "messageId" | "textWithoutFooter" | "edit">;

const records = new Map<string, StatusFooterRecord>();
const activities = new Map<string, StatusFooterActivity>();
const runStartedAt = new Map<string, number>();
const chains = new Map<string, Promise<void>>();
const pendingConversationCountsByRun = new Map<string, Map<string, number>>();
const terminalRuns = new Set<string>();
// Failed strip edits get one deferred retry (next relocation or finalize), then drop.
// Without it a transient edit failure leaves a stale "Working" line on the platform forever.
const pendingStrips = new Map<string, PendingStrip[]>();
const MAX_PENDING_STRIPS = 2;

export function createStatusFooterConversationKey(
  channel: string,
  to: string,
  options?: { accountId?: string; threadId?: string | number | null },
): string {
  return JSON.stringify([channel, options?.accountId ?? null, to, options?.threadId ?? null]);
}

export function resolveStatusFooterMode(
  config: OpenClawConfig,
  channelId: string,
): StatusFooterMode {
  const configured = config.messages?.statusFooter;
  if (typeof configured === "string") {
    return configured;
  }
  return configured?.[channelId] ?? configured?.default ?? "activity";
}

function noteStatusFooterRunStarted(runId: string, startedAt: number): void {
  if (Number.isFinite(startedAt)) {
    runStartedAt.set(runId, startedAt);
  }
}

type StatusFooterRunParams = { opts?: { runId?: string }; runStartedAt?: number };
type StatusFooterRunParamsWithId<TParams extends StatusFooterRunParams> = Omit<TParams, "opts"> & {
  opts: NonNullable<TParams["opts"]> & { runId: string };
};

export async function wrapRunWithStatusFooter<T, TParams extends StatusFooterRunParams>(
  params: TParams,
  run: (
    params: StatusFooterRunParamsWithId<TParams>,
    commitTerminalOutcome: () => void,
  ) => Promise<T>,
  commitTerminalOutcome: () => void,
): Promise<T> {
  const runId = params.opts?.runId ?? crypto.randomUUID();
  const runParams = {
    ...params,
    opts: { ...params.opts, runId },
  } as StatusFooterRunParamsWithId<TParams>;
  noteStatusFooterRunStarted(runId, params.runStartedAt ?? Date.now());
  try {
    return await run(runParams, commitTerminalOutcome);
  } finally {
    try {
      commitTerminalOutcome();
    } finally {
      await finalizeStatusFooterRun(runId);
    }
  }
}

function normalizeActivity(line: string): string {
  const normalized = line.replace(/\s+/g, " ").trim();
  // Truncate on code points, not UTF-16 units: a hard cut inside a surrogate
  // pair renders as replacement garbage and some transports reject it.
  const points = Array.from(normalized);
  if (points.length <= MAX_ACTIVITY_CHARS) {
    return normalized;
  }
  const contentLimit = MAX_ACTIVITY_CHARS - 1;
  const candidate = points.slice(0, contentLimit + 1).join("");
  const wordBoundary = candidate.lastIndexOf(" ");
  const base =
    wordBoundary >= Math.floor(candidate.length * 0.6)
      ? candidate.slice(0, wordBoundary)
      : points.slice(0, contentLimit).join("");
  return `${base.trimEnd()}…`;
}

export function noteActivity(conversationKey: string, line: string, runId?: string): void {
  if (runId && terminalRuns.has(runId)) {
    return;
  }
  const normalized = normalizeActivity(line);
  if (!normalized) {
    return;
  }
  activities.set(conversationKey, { line: normalized, ...(runId ? { runId } : {}) });
}

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function renderFooter(params: {
  conversationKey: string;
  mode: Exclude<StatusFooterMode, "off">;
  runId?: string;
  now: number;
  escapeHtml: boolean;
}): string {
  const activity = activities.get(params.conversationKey);
  const activityMatchesRun = !activity?.runId || !params.runId || activity.runId === params.runId;
  const label =
    params.mode === "activity" && activityMatchesRun && activity?.line ? activity.line : "Working";
  const startedAt = params.runId ? runStartedAt.get(params.runId) : undefined;
  const elapsed =
    formatDurationCompact(Math.max(0, params.now - (startedAt ?? params.now))) ?? "0s";
  const footer = `▸ ${label} · ${elapsed} · reply to steer`;
  return params.escapeHtml ? escapeHtml(footer) : footer;
}

function enqueue<T>(conversationKey: string, operation: () => Promise<T>): Promise<T> {
  const previous = chains.get(conversationKey) ?? Promise.resolve();
  const result = previous.catch(() => {}).then(operation);
  const settled = result.then(
    () => {},
    () => {},
  );
  chains.set(conversationKey, settled);
  void settled.finally(() => {
    if (chains.get(conversationKey) === settled) {
      chains.delete(conversationKey);
    }
  });
  return result;
}

async function attemptStrip(
  conversationKey: string,
  strip: PendingStrip,
  retryOnFailure: boolean,
): Promise<void> {
  try {
    await strip.edit(strip.messageId, strip.textWithoutFooter);
  } catch (error) {
    log.debug("status footer strip failed", {
      conversationKey,
      messageId: strip.messageId,
      error: String(error),
    });
    if (retryOnFailure) {
      const queued = pendingStrips.get(conversationKey) ?? [];
      if (queued.length < MAX_PENDING_STRIPS) {
        queued.push({
          messageId: strip.messageId,
          textWithoutFooter: strip.textWithoutFooter,
          edit: strip.edit,
        });
        pendingStrips.set(conversationKey, queued);
      }
    }
  }
}

async function flushPendingStrips(conversationKey: string): Promise<void> {
  const queued = pendingStrips.get(conversationKey);
  if (!queued?.length) {
    return;
  }
  // One retry each, then gone for good: never leaves an unbounded retry loop behind.
  pendingStrips.delete(conversationKey);
  for (const strip of queued) {
    await attemptStrip(conversationKey, strip, false);
  }
}

async function stripRecord(conversationKey: string, runId?: string): Promise<void> {
  const record = records.get(conversationKey);
  if (!record || (runId && record.runId && record.runId !== runId)) {
    return;
  }
  // Delete first so relocation is never blocked; a failed edit is parked for one retry.
  records.delete(conversationKey);
  await attemptStrip(conversationKey, record, true);
}

export async function decorateIntermediate<T>(params: {
  conversationKey: string;
  mode: StatusFooterMode;
  runId?: string;
  textWithoutFooter: string;
  send: (text: string) => Promise<T>;
  getMessageId: (result: T) => string | undefined;
  edit: (messageId: string, text: string) => Promise<void>;
  now?: () => number;
  escapeHtml?: boolean;
}): Promise<T> {
  const mode = params.mode;
  if (mode === "off" || (params.runId && terminalRuns.has(params.runId))) {
    return await params.send(params.textWithoutFooter);
  }
  const pendingConversationCounts = params.runId
    ? (pendingConversationCountsByRun.get(params.runId) ?? new Map<string, number>())
    : undefined;
  if (params.runId && pendingConversationCounts) {
    pendingConversationCounts.set(
      params.conversationKey,
      (pendingConversationCounts.get(params.conversationKey) ?? 0) + 1,
    );
    pendingConversationCountsByRun.set(params.runId, pendingConversationCounts);
  }
  try {
    return await enqueue(params.conversationKey, async () => {
      await flushPendingStrips(params.conversationKey);
      const footerText = renderFooter({
        conversationKey: params.conversationKey,
        mode,
        runId: params.runId,
        now: (params.now ?? Date.now)(),
        escapeHtml: params.escapeHtml === true,
      });
      // Send first, strip after: a failed replacement send must not cost the
      // previous message its footer. The ms-scale two-footer window is fine.
      const result = await params.send(`${params.textWithoutFooter}\n\n${footerText}`);
      await stripRecord(params.conversationKey);
      const messageId = params.getMessageId(result);
      if (messageId) {
        // Exact rendered text is the edit source of truth; regex stripping would risk user content.
        records.set(params.conversationKey, {
          messageId,
          textWithoutFooter: params.textWithoutFooter,
          footerText,
          ...(params.runId ? { runId: params.runId } : {}),
          edit: params.edit,
        });
      }
      return result;
    });
  } finally {
    if (params.runId && pendingConversationCounts) {
      const remaining = (pendingConversationCounts.get(params.conversationKey) ?? 1) - 1;
      if (remaining > 0) {
        pendingConversationCounts.set(params.conversationKey, remaining);
      } else {
        pendingConversationCounts.delete(params.conversationKey);
      }
      if (pendingConversationCounts.size === 0) {
        pendingConversationCountsByRun.delete(params.runId);
      }
    }
  }
}

export async function finalize(conversationKey: string, runId?: string): Promise<void> {
  await enqueue(conversationKey, async () => {
    // Strip first, flush last: a strip that fails right here still gets its
    // one retry before terminal cleanup returns (cancel/error paths have no
    // later delivery to flush it).
    await stripRecord(conversationKey, runId);
    await flushPendingStrips(conversationKey);
    const activity = activities.get(conversationKey);
    if (!runId || !activity?.runId || activity.runId === runId) {
      activities.delete(conversationKey);
    }
  });
}

async function finalizeStatusFooterRun(runId: string): Promise<void> {
  // Late delivery work must not recreate a footer after cancel/error cleanup snapshots the run.
  terminalRuns.add(runId);
  if (terminalRuns.size > MAX_TERMINAL_RUNS) {
    const oldestRunId = terminalRuns.values().next().value;
    if (oldestRunId) {
      terminalRuns.delete(oldestRunId);
    }
  }
  const conversationKeys = new Set<string>();
  for (const key of pendingConversationCountsByRun.get(runId)?.keys() ?? []) {
    conversationKeys.add(key);
  }
  for (const [key, record] of records) {
    if (record.runId === runId) {
      conversationKeys.add(key);
    }
  }
  for (const [key, activity] of activities) {
    if (activity.runId === runId) {
      conversationKeys.add(key);
    }
  }
  await Promise.all(
    Array.from(conversationKeys)
      .toSorted()
      .map((key) => finalize(key, runId)),
  );
  runStartedAt.delete(runId);
  pendingConversationCountsByRun.delete(runId);
}

function resetStatusFooterStateForTest(): void {
  records.clear();
  activities.clear();
  runStartedAt.clear();
  chains.clear();
  pendingConversationCountsByRun.clear();
  terminalRuns.clear();
  pendingStrips.clear();
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.statusFooterTestApi")] = {
    finalizeStatusFooterRun,
    noteStatusFooterRunStarted,
    resetStatusFooterStateForTest,
  };
}
