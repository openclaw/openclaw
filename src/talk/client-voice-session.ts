/** Durable logical voice-session ledger for client-owned Talk transports. */
import { randomUUID } from "node:crypto";
import { buildToolMutationState } from "../agents/tool-mutation.js";
import { appendTranscriptMessage, loadSessionEntry } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  onTrustedToolExecutionEvent,
  type TrustedToolExecutionEvent,
} from "../infra/diagnostic-events.js";
import { buildOutboundSessionContext } from "../infra/outbound/session-context.js";
import { resolveSessionDeliveryTarget } from "../infra/outbound/targets-session.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { truncateUtf16Safe } from "../utils.js";
import type { RealtimeVoiceAgentConsultTranscriptEntry } from "./agent-consult-tool.js";
import {
  deactivateClientVoiceConfirmationSession,
  noteClientVoiceConfirmationTranscript,
} from "./client-voice-confirmation.js";

const CACHE_SCOPE = "talk-client-voice-sessions";
const LEDGER_VERSION = 1;
const MAX_TRANSCRIPT_ENTRIES = 200;
const MAX_ENTRY_CHARS = 8_000;
const MAX_TRANSCRIPT_CHARS = 120_000;
const DEFAULT_STALE_AFTER_MS = 6 * 60 * 60_000;

export type ClientVoiceTranscriptEntry = RealtimeVoiceAgentConsultTranscriptEntry & {
  entryId: string;
  timestamp: number;
};

type ClientVoiceToolEffect = {
  runId: string;
  toolCallId?: string;
  toolName: string;
  startedAt: number;
  finishedAt?: number;
  status: "started" | "succeeded" | "failed" | "cancelled" | "blocked";
};

type ClientVoiceSessionLedger = {
  version: typeof LEDGER_VERSION;
  voiceSessionId: string;
  agentId: string;
  sessionKey: string;
  status: "open" | "closed";
  createdAt: number;
  updatedAt: number;
  closedAt?: number;
  importedAt?: number;
  transcript: ClientVoiceTranscriptEntry[];
  consultRunIds: string[];
  effects: ClientVoiceToolEffect[];
  digestDeliveredAt?: number;
};

const voiceSessionByRunId = new Map<string, { agentId: string; voiceSessionId: string }>();
let unsubscribeToolEffects: (() => void) | undefined;

function parseLedger(value: unknown): ClientVoiceSessionLedger | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const ledger = value as Partial<ClientVoiceSessionLedger>;
  if (
    ledger.version !== LEDGER_VERSION ||
    typeof ledger.voiceSessionId !== "string" ||
    typeof ledger.agentId !== "string" ||
    typeof ledger.sessionKey !== "string" ||
    (ledger.status !== "open" && ledger.status !== "closed") ||
    typeof ledger.createdAt !== "number" ||
    typeof ledger.updatedAt !== "number" ||
    !Array.isArray(ledger.transcript)
  ) {
    return undefined;
  }
  const transcript = ledger.transcript.flatMap((entry) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }
    const candidate = entry as Partial<ClientVoiceTranscriptEntry>;
    if (
      typeof candidate.entryId !== "string" ||
      (candidate.role !== "user" && candidate.role !== "assistant") ||
      typeof candidate.text !== "string" ||
      typeof candidate.timestamp !== "number"
    ) {
      return [];
    }
    return [candidate as ClientVoiceTranscriptEntry];
  });
  const consultRunIds = Array.isArray(ledger.consultRunIds)
    ? ledger.consultRunIds.filter((entry): entry is string => typeof entry === "string")
    : [];
  const effects = Array.isArray(ledger.effects)
    ? ledger.effects.filter((entry): entry is ClientVoiceToolEffect =>
        Boolean(
          entry &&
          typeof entry === "object" &&
          typeof (entry as ClientVoiceToolEffect).runId === "string" &&
          typeof (entry as ClientVoiceToolEffect).toolName === "string" &&
          typeof (entry as ClientVoiceToolEffect).startedAt === "number",
        ),
      )
    : [];
  return { ...ledger, transcript, consultRunIds, effects } as ClientVoiceSessionLedger;
}

function readLedger(agentId: string, voiceSessionId: string): ClientVoiceSessionLedger | undefined {
  const database = openOpenClawAgentDatabase({ agentId });
  const row = database.db
    .prepare("SELECT value_json FROM cache_entries WHERE scope = ? AND key = ?")
    .get(CACHE_SCOPE, voiceSessionId) as { value_json?: unknown } | undefined;
  if (typeof row?.value_json !== "string") {
    return undefined;
  }
  try {
    return parseLedger(JSON.parse(row.value_json));
  } catch {
    return undefined;
  }
}

function writeLedgerInTransaction(
  database: OpenClawAgentDatabase,
  ledger: ClientVoiceSessionLedger,
): void {
  database.db
    .prepare(
      `INSERT INTO cache_entries (scope, key, value_json, blob, expires_at, updated_at)
       VALUES (?, ?, ?, NULL, NULL, ?)
       ON CONFLICT(scope, key) DO UPDATE SET
         value_json = excluded.value_json,
         updated_at = excluded.updated_at`,
    )
    .run(CACHE_SCOPE, ledger.voiceSessionId, JSON.stringify(ledger), ledger.updatedAt);
}

function assertLedgerOwnership(
  ledger: ClientVoiceSessionLedger,
  params: { agentId: string; sessionKey: string },
): void {
  if (ledger.agentId !== params.agentId || ledger.sessionKey !== params.sessionKey) {
    throw new Error("voice session does not belong to this agent session");
  }
}

function toolEffectStatus(event: TrustedToolExecutionEvent): ClientVoiceToolEffect["status"] {
  if (event.type === "tool.execution.started") {
    return "started";
  }
  if (event.type === "tool.execution.completed") {
    return "succeeded";
  }
  if (event.type === "tool.execution.blocked") {
    return "blocked";
  }
  return event.terminalReason === "cancelled" ? "cancelled" : "failed";
}

function recordClientVoiceToolEffect(event: TrustedToolExecutionEvent): void {
  if (!event.runId) {
    return;
  }
  const runId = event.runId;
  const owner = voiceSessionByRunId.get(runId);
  if (!owner) {
    return;
  }
  const mutatingAction =
    event.mutatingAction ?? buildToolMutationState(event.toolName, {}).mutatingAction;
  const effectKey = event.toolCallId ?? `${runId}:${event.toolName}`;
  runOpenClawAgentWriteTransaction(
    (database) => {
      const row = database.db
        .prepare("SELECT value_json FROM cache_entries WHERE scope = ? AND key = ?")
        .get(CACHE_SCOPE, owner.voiceSessionId) as { value_json?: unknown } | undefined;
      const ledger =
        typeof row?.value_json === "string" ? parseLedger(JSON.parse(row.value_json)) : undefined;
      if (!ledger || ledger.status !== "open") {
        return;
      }
      const existing = ledger.effects.find(
        (entry) => (entry.toolCallId ?? `${entry.runId}:${entry.toolName}`) === effectKey,
      );
      if (!existing && (event.type !== "tool.execution.started" || !mutatingAction)) {
        return;
      }
      const status = toolEffectStatus(event);
      if (existing) {
        existing.status = status;
        if (event.type !== "tool.execution.started") {
          existing.finishedAt = event.ts;
        }
      } else {
        ledger.effects.push({
          runId,
          ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
          toolName: event.toolName,
          startedAt: event.ts,
          status,
        });
      }
      ledger.updatedAt = Date.now();
      writeLedgerInTransaction(database, ledger);
    },
    { agentId: owner.agentId },
  );
}

function ensureToolEffectSubscription(): void {
  unsubscribeToolEffects ??= onTrustedToolExecutionEvent(recordClientVoiceToolEffect);
}

/** Correlate a Talk consult run with its logical voice session for mutation evidence. */
export function registerClientVoiceConsultRun(params: {
  agentId: string;
  sessionKey: string;
  voiceSessionId: string;
  runId: string;
}): void {
  const ledger = readLedger(params.agentId, params.voiceSessionId);
  if (!ledger) {
    throw new Error("voice session not found");
  }
  assertLedgerOwnership(ledger, params);
  if (ledger.status !== "open") {
    throw new Error("voice session is closed");
  }
  if (!ledger.consultRunIds.includes(params.runId)) {
    ledger.consultRunIds.push(params.runId);
    ledger.updatedAt = Date.now();
    runOpenClawAgentWriteTransaction((database) => writeLedgerInTransaction(database, ledger), {
      agentId: params.agentId,
    });
  }
  voiceSessionByRunId.set(params.runId, {
    agentId: params.agentId,
    voiceSessionId: params.voiceSessionId,
  });
  ensureToolEffectSubscription();
}

/** Create a logical Talk session or resume it across a provider transport replacement. */
export function createOrResumeClientVoiceSession(params: {
  agentId: string;
  sessionKey: string;
  voiceSessionId?: string;
  now?: number;
}): string {
  const voiceSessionId = params.voiceSessionId?.trim() || randomUUID();
  const now = params.now ?? Date.now();
  runOpenClawAgentWriteTransaction(
    (database) => {
      const row = database.db
        .prepare("SELECT value_json FROM cache_entries WHERE scope = ? AND key = ?")
        .get(CACHE_SCOPE, voiceSessionId) as { value_json?: unknown } | undefined;
      const existing =
        typeof row?.value_json === "string" ? parseLedger(JSON.parse(row.value_json)) : undefined;
      if (existing) {
        assertLedgerOwnership(existing, params);
        if (existing.status !== "open") {
          throw new Error("voice session is already closed");
        }
        existing.updatedAt = now;
        writeLedgerInTransaction(database, existing);
        return;
      }
      writeLedgerInTransaction(database, {
        version: LEDGER_VERSION,
        voiceSessionId,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        status: "open",
        createdAt: now,
        updatedAt: now,
        transcript: [],
        consultRunIds: [],
        effects: [],
      });
    },
    { agentId: params.agentId },
  );
  return voiceSessionId;
}

/** Append one finalized transcript item idempotently. */
export function appendClientVoiceTranscript(params: {
  agentId: string;
  sessionKey: string;
  voiceSessionId: string;
  entryId: string;
  role: "user" | "assistant";
  text: string;
  timestamp?: number;
}): void {
  const text = truncateUtf16Safe(params.text.trim(), MAX_ENTRY_CHARS);
  if (!text) {
    return;
  }
  const timestamp = params.timestamp ?? Date.now();
  let appended = false;
  runOpenClawAgentWriteTransaction(
    (database) => {
      const row = database.db
        .prepare("SELECT value_json FROM cache_entries WHERE scope = ? AND key = ?")
        .get(CACHE_SCOPE, params.voiceSessionId) as { value_json?: unknown } | undefined;
      const ledger =
        typeof row?.value_json === "string" ? parseLedger(JSON.parse(row.value_json)) : undefined;
      if (!ledger) {
        throw new Error("voice session not found");
      }
      assertLedgerOwnership(ledger, params);
      if (ledger.status !== "open") {
        throw new Error("voice session is closed");
      }
      if (ledger.transcript.some((entry) => entry.entryId === params.entryId)) {
        return;
      }
      ledger.transcript.push({
        entryId: params.entryId,
        role: params.role,
        text,
        timestamp,
      });
      appended = true;
      while (
        ledger.transcript.length > MAX_TRANSCRIPT_ENTRIES ||
        ledger.transcript.reduce((total, entry) => total + entry.text.length, 0) >
          MAX_TRANSCRIPT_CHARS
      ) {
        ledger.transcript.shift();
      }
      ledger.updatedAt = Date.now();
      writeLedgerInTransaction(database, ledger);
    },
    { agentId: params.agentId },
  );
  if (appended) {
    noteClientVoiceConfirmationTranscript({
      sessionKey: params.sessionKey,
      voiceSessionId: params.voiceSessionId,
      role: params.role,
      text,
      timestamp,
    });
  }
}

/** Return bounded recent transcript context for an agent consult. */
export function readClientVoiceConsultTranscript(params: {
  agentId: string;
  sessionKey: string;
  voiceSessionId: string;
  limit?: number;
}): RealtimeVoiceAgentConsultTranscriptEntry[] {
  const ledger = readLedger(params.agentId, params.voiceSessionId);
  if (!ledger) {
    return [];
  }
  assertLedgerOwnership(ledger, params);
  return ledger.transcript
    .slice(-Math.max(1, Math.min(params.limit ?? 12, 24)))
    .map(({ role, text }) => ({ role, text }));
}

function buildPersistedVoiceMessage(entry: ClientVoiceTranscriptEntry): Record<string, unknown> {
  const provenance = {
    kind: "realtime_voice",
    sourceChannel: "talk",
  };
  if (entry.role === "user") {
    return {
      role: "user",
      content: [{ type: "text", text: entry.text }],
      timestamp: entry.timestamp,
      provenance,
    };
  }
  return {
    role: "assistant",
    content: [{ type: "text", text: entry.text }],
    api: "openai-realtime",
    provider: "openai",
    model: "realtime-voice",
    stopReason: "stop",
    timestamp: entry.timestamp,
    provenance,
  };
}

function formatMutationDigest(effects: ClientVoiceToolEffect[]): string | undefined {
  if (effects.length === 0) {
    return undefined;
  }
  const lines = effects.slice(0, 12).map((effect) => {
    const status =
      effect.status === "started"
        ? "outcome not confirmed"
        : effect.status === "succeeded"
          ? "succeeded"
          : effect.status;
    return `- ${effect.toolName}: ${status}`;
  });
  return ["Voice call changes", ...lines].join("\n");
}

async function deliverMutationDigest(params: {
  ledger: ClientVoiceSessionLedger;
  config: OpenClawConfig;
}): Promise<boolean> {
  if (params.ledger.digestDeliveredAt) {
    return false;
  }
  const text = formatMutationDigest(params.ledger.effects);
  if (!text) {
    return false;
  }
  const entry = loadSessionEntry({
    agentId: params.ledger.agentId,
    sessionKey: params.ledger.sessionKey,
  });
  const target = resolveSessionDeliveryTarget({ entry, requestedChannel: "last" });
  if (!target.channel || target.channel === "webchat" || !target.to) {
    return false;
  }
  const { deliverOutboundPayloads } = await import("../infra/outbound/deliver.js");
  await deliverOutboundPayloads({
    cfg: params.config,
    channel: target.channel,
    to: target.to,
    ...(target.accountId ? { accountId: target.accountId } : {}),
    ...(target.threadId != null ? { threadId: target.threadId } : {}),
    payloads: [{ text }],
    queuePolicy: "required",
    session: buildOutboundSessionContext({
      cfg: params.config,
      agentId: params.ledger.agentId,
      sessionKey: params.ledger.sessionKey,
      policySessionKey: params.ledger.sessionKey,
    }),
  });
  return true;
}

/** Close a logical Talk session and import its complete transcript into the agent session. */
export async function closeClientVoiceSession(params: {
  agentId: string;
  sessionKey: string;
  voiceSessionId: string;
  config?: OpenClawConfig;
  persistTranscript?: boolean;
  postCallSummary?: boolean;
  now?: number;
}): Promise<{ imported: number }> {
  const ledger = readLedger(params.agentId, params.voiceSessionId);
  if (!ledger) {
    throw new Error("voice session not found");
  }
  assertLedgerOwnership(ledger, params);

  let imported = 0;
  if (params.persistTranscript === true && !ledger.importedAt) {
    const sessionEntry = loadSessionEntry({
      agentId: params.agentId,
      sessionKey: params.sessionKey,
    });
    if (!sessionEntry?.sessionId) {
      throw new Error(
        `cannot import voice transcript: agent session not found (${params.sessionKey})`,
      );
    }
    for (const entry of ledger.transcript) {
      const result = await appendTranscriptMessage(
        {
          agentId: params.agentId,
          sessionId: sessionEntry.sessionId,
          sessionKey: params.sessionKey,
        },
        {
          config: params.config,
          eventId: `voice:${params.voiceSessionId}:${entry.entryId}`,
          message: buildPersistedVoiceMessage(entry),
          now: entry.timestamp,
        },
      );
      if (result.appended) {
        imported += 1;
      }
    }
  }

  const now = params.now ?? Date.now();
  runOpenClawAgentWriteTransaction(
    (database) => {
      const currentRow = database.db
        .prepare("SELECT value_json FROM cache_entries WHERE scope = ? AND key = ?")
        .get(CACHE_SCOPE, params.voiceSessionId) as { value_json?: unknown } | undefined;
      const current =
        typeof currentRow?.value_json === "string"
          ? parseLedger(JSON.parse(currentRow.value_json))
          : undefined;
      if (!current) {
        throw new Error("voice session disappeared during close");
      }
      assertLedgerOwnership(current, params);
      current.status = "closed";
      current.closedAt = now;
      if (params.persistTranscript === true) {
        current.importedAt = now;
      }
      current.updatedAt = now;
      writeLedgerInTransaction(database, current);
    },
    { agentId: params.agentId },
  );
  deactivateClientVoiceConfirmationSession({
    sessionKey: params.sessionKey,
    voiceSessionId: params.voiceSessionId,
  });
  for (const runId of ledger.consultRunIds) {
    voiceSessionByRunId.delete(runId);
  }
  if (params.postCallSummary === true && params.config) {
    const latest = readLedger(params.agentId, params.voiceSessionId);
    if (latest && (await deliverMutationDigest({ ledger: latest, config: params.config }))) {
      const deliveredAt = Date.now();
      runOpenClawAgentWriteTransaction(
        (database) => {
          const delivered = readLedger(params.agentId, params.voiceSessionId);
          if (!delivered) {
            return;
          }
          delivered.digestDeliveredAt = deliveredAt;
          delivered.updatedAt = deliveredAt;
          writeLedgerInTransaction(database, delivered);
        },
        { agentId: params.agentId },
      );
    }
  }
  return { imported };
}

/** Recover abandoned logical sessions when a client starts a later voice session. */
export async function closeStaleClientVoiceSessions(params: {
  agentId: string;
  config?: OpenClawConfig;
  persistTranscript?: boolean;
  postCallSummary?: boolean;
  excludeVoiceSessionId?: string;
  staleAfterMs?: number;
  now?: number;
  warn?: (message: string) => void;
}): Promise<number> {
  const now = params.now ?? Date.now();
  const cutoff = now - Math.max(60_000, params.staleAfterMs ?? DEFAULT_STALE_AFTER_MS);
  const database = openOpenClawAgentDatabase({ agentId: params.agentId });
  const rows = database.db
    .prepare("SELECT value_json FROM cache_entries WHERE scope = ? AND updated_at <= ?")
    .all(CACHE_SCOPE, cutoff) as Array<{ value_json?: unknown }>;
  const stale = rows.flatMap((row) => {
    if (typeof row.value_json !== "string") {
      return [];
    }
    try {
      const ledger = parseLedger(JSON.parse(row.value_json));
      return ledger &&
        ledger.status === "open" &&
        ledger.voiceSessionId !== params.excludeVoiceSessionId
        ? [ledger]
        : [];
    } catch {
      return [];
    }
  });
  let closed = 0;
  for (const ledger of stale) {
    try {
      await closeClientVoiceSession({
        agentId: params.agentId,
        sessionKey: ledger.sessionKey,
        voiceSessionId: ledger.voiceSessionId,
        config: params.config,
        persistTranscript: params.persistTranscript,
        postCallSummary: params.postCallSummary,
        now,
      });
      closed += 1;
    } catch (error) {
      params.warn?.(
        `failed to recover stale voice session ${ledger.voiceSessionId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return closed;
}

/** Test-only readback of redacted mutation evidence. */
export function readClientVoiceSessionEffectsForTest(params: {
  agentId: string;
  voiceSessionId: string;
}): ClientVoiceToolEffect[] {
  return readLedger(params.agentId, params.voiceSessionId)?.effects ?? [];
}
