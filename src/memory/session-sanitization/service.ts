import type { OpenClawConfig } from "../../config/config.js";
import { fireAndForgetHook } from "../../hooks/fire-and-forget.js";
import type { CanonicalInboundMessageHookContext } from "../../hooks/message-hook-mappers.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  isMcpServerTrusted,
  resolveSessionSanitizationAvailability,
  resolveSessionSanitizationConfig,
  resolveSessionSanitizationMcpConfig,
} from "./config.js";
import { runSessionSanitizationHelper, type SanitizationRunner } from "./runtime.js";
import {
  appendSessionMemoryAuditEntry,
  upsertSessionMemorySummaryEntry,
  deleteSessionMemoryArtifacts,
  readSessionMemoryRawEntries,
  readSessionMemorySummaryEntries,
  sweepExpiredSessionMemoryMcpRawEntries,
  sweepExpiredSessionMemoryRawEntries,
  writeSessionMemoryMcpRawEntry,
  writeSessionMemoryRawEntry,
} from "./storage.js";
import { runTier1PreFilter } from "./tier1.js";
import type {
  SessionMemoryConfidence,
  SessionMemoryMcpChildResult,
  SessionMemoryRawEntry,
  SessionMemoryRecallChildResult,
  SessionMemoryRecallResult,
  SessionMemorySignalResult,
  SessionMemorySummaryEntry,
  SessionMemoryWriteResult,
} from "./types.js";

const log = createSubsystemLogger("memory/session-sanitization");
const warnedUnavailableAgents = new Set<string>();
const warnedSandboxSkipPassthrough = new Set<string>();

type HelperDeps = {
  runner?: SanitizationRunner;
  now?: () => number;
  lane?: string;
};

function nowIso(now: number): string {
  return new Date(now).toISOString();
}

function normalizeText(value: string | undefined): string {
  return (value ?? "").trim();
}

function isNonEmptyText(value: string | undefined): boolean {
  return normalizeText(value).length > 0;
}

function resolveFeatureState(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionId?: string;
}): { enabled: boolean; available: boolean; rawMaxAgeMs: number } {
  const resolved = resolveSessionSanitizationConfig(params.cfg);
  if (!resolved.enabled || !params.sessionId?.trim()) {
    return { enabled: false, available: false, rawMaxAgeMs: resolved.rawMaxAgeMs };
  }
  const availability = resolveSessionSanitizationAvailability({
    cfg: params.cfg,
    agentId: params.agentId,
  });
  if (!availability.available && !warnedUnavailableAgents.has(params.agentId)) {
    warnedUnavailableAgents.add(params.agentId);
    log.warn("session sanitization disabled because sandbox isolation is unavailable", {
      agentId: params.agentId,
    });
  }
  return {
    enabled: resolved.enabled,
    available: availability.available,
    rawMaxAgeMs: resolved.rawMaxAgeMs,
  };
}

function buildRawEntry(params: {
  canonical: CanonicalInboundMessageHookContext;
  now: number;
  rawMaxAgeMs: number;
}): SessionMemoryRawEntry | null {
  const messageId = normalizeText(params.canonical.messageId);
  const transcript = normalizeText(params.canonical.transcript);
  if (!messageId || !transcript) {
    return null;
  }
  const timestampMs =
    typeof params.canonical.timestamp === "number" && Number.isFinite(params.canonical.timestamp)
      ? params.canonical.timestamp
      : params.now;
  return {
    messageId,
    timestamp: nowIso(timestampMs),
    expiresAt: nowIso(timestampMs + params.rawMaxAgeMs),
    transcript,
    body: normalizeText(params.canonical.body) || undefined,
    bodyForAgent: normalizeText(params.canonical.bodyForAgent) || undefined,
    from: normalizeText(params.canonical.from) || undefined,
    to: normalizeText(params.canonical.to) || undefined,
    channelId: normalizeText(params.canonical.channelId) || undefined,
    conversationId: normalizeText(params.canonical.conversationId) || undefined,
    senderId: normalizeText(params.canonical.senderId) || undefined,
    senderName: normalizeText(params.canonical.senderName) || undefined,
    senderUsername: normalizeText(params.canonical.senderUsername) || undefined,
    provider: normalizeText(params.canonical.provider) || undefined,
    surface: normalizeText(params.canonical.surface) || undefined,
    mediaPath: normalizeText(params.canonical.mediaPath) || undefined,
    mediaType: normalizeText(params.canonical.mediaType) || undefined,
  };
}

function lexicalScore(query: string, entry: SessionMemorySummaryEntry): number {
  const normalizedQuery = normalizeText(query).toLowerCase();
  if (!normalizedQuery) {
    return 0;
  }
  const haystack = [entry.contextNote, ...entry.decisions, ...entry.actionItems, ...entry.entities]
    .map((value) => normalizeText(value).toLowerCase())
    .filter(Boolean)
    .join("\n");
  if (!haystack) {
    return 0;
  }
  let score = haystack.includes(normalizedQuery) ? 10 : 0;
  const tokens = normalizedQuery
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
  for (const token of tokens) {
    if (haystack.includes(token)) {
      score += 1;
    }
  }
  return score;
}

function sortByLexicalMatch(
  query: string,
  entries: SessionMemorySummaryEntry[],
): SessionMemorySummaryEntry[] {
  return entries
    .map((entry) => ({ entry, score: lexicalScore(query, entry) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return Date.parse(b.entry.timestamp) - Date.parse(a.entry.timestamp);
    })
    .map((row) => row.entry);
}

function computeSummaryDensity(entry: SessionMemorySummaryEntry): number {
  return (
    entry.decisions.length +
    entry.actionItems.length +
    (entry.entities.length > 0 ? 1 : 0) +
    (isNonEmptyText(entry.contextNote) ? 1 : 0)
  );
}

function normalizeRecallConfidence(params: {
  child: SessionMemoryRecallChildResult;
  summariesById: Map<string, SessionMemorySummaryEntry>;
  verifiedRawMessageIds: Set<string>;
  now: number;
}): SessionMemoryConfidence {
  if (
    params.child.source === "raw" &&
    params.child.usedRawMessageIds.length >= 1 &&
    params.child.usedRawMessageIds.some((id) => params.verifiedRawMessageIds.has(id))
  ) {
    return "high";
  }
  if (params.child.source === "summary" && params.child.matchedSummaryIds.length >= 1) {
    const matched = params.child.matchedSummaryIds
      .map((id) => params.summariesById.get(id))
      .filter((entry): entry is SessionMemorySummaryEntry => Boolean(entry));
    const hasDense = matched.some((entry) => computeSummaryDensity(entry) >= 2);
    const allPostExpiry =
      matched.length > 0 &&
      matched.every((entry) => {
        const rawExpiresAt = Date.parse(entry.rawExpiresAt);
        return Number.isFinite(rawExpiresAt) && rawExpiresAt <= params.now;
      });
    if (hasDense && !allPostExpiry) {
      return "medium";
    }
  }
  return "low";
}

async function sweepAndAuditExpiredRaw(params: {
  agentId: string;
  sessionId: string;
  now: number;
}): Promise<void> {
  const expired = await sweepExpiredSessionMemoryRawEntries(params);
  if (expired.length === 0) {
    return;
  }
  await Promise.all(
    expired.map((entry) =>
      appendSessionMemoryAuditEntry({
        agentId: params.agentId,
        sessionId: params.sessionId,
        entry: {
          event: "raw_expired",
          timestamp: nowIso(params.now),
          messageId: entry.messageId,
        },
      }),
    ),
  );
}

function buildJsonLines(entries: unknown[]): string {
  return entries.map((entry) => JSON.stringify(entry)).join("\n");
}

function formatAutomaticRecallPrompt(result: SessionMemoryRecallResult): string | undefined {
  const text = normalizeText(result.result);
  if (!text) {
    return undefined;
  }
  const confidenceNote =
    result.confidence === "high"
      ? "This transcript-derived recall is current-session only and is backed by unexpired raw transcript data."
      : result.confidence === "medium"
        ? "This transcript-derived recall is current-session only and is based on sanitized summaries. If you use it, qualify it explicitly as medium-confidence."
        : "This transcript-derived recall is current-session only and low-confidence. If you use it, qualify it explicitly and avoid presenting it as certain.";
  return [
    "## Transcript Session Recall",
    `Source: ${result.source}`,
    `Confidence: ${result.confidence}`,
    confidenceNote,
    text,
  ].join("\n");
}

export function isSessionSanitizationToolingAvailable(params: {
  cfg: OpenClawConfig | undefined;
  agentId: string;
  sessionId?: string;
}): boolean {
  if (!params.cfg) {
    return false;
  }
  const state = resolveFeatureState({
    cfg: params.cfg,
    agentId: params.agentId,
    sessionId: params.sessionId,
  });
  return state.enabled && state.available;
}

export function queueSessionSanitizationWrite(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionId?: string;
  canonical: CanonicalInboundMessageHookContext;
  helperDeps?: HelperDeps;
}): void {
  const state = resolveFeatureState({
    cfg: params.cfg,
    agentId: params.agentId,
    sessionId: params.sessionId,
  });
  if (!state.enabled || !state.available || !params.sessionId?.trim()) {
    return;
  }
  fireAndForgetHook(
    writeTranscriptTurnToSessionMemory({
      cfg: params.cfg,
      agentId: params.agentId,
      sessionId: params.sessionId,
      canonical: params.canonical,
      helperDeps: params.helperDeps,
    }),
    "session-memory-sanitization write failed",
  );
}

export async function writeTranscriptTurnToSessionMemory(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionId: string;
  canonical: CanonicalInboundMessageHookContext;
  helperDeps?: HelperDeps;
}): Promise<void> {
  const state = resolveFeatureState({
    cfg: params.cfg,
    agentId: params.agentId,
    sessionId: params.sessionId,
  });
  if (!state.enabled || !state.available) {
    return;
  }
  const now = params.helperDeps?.now?.() ?? Date.now();
  const rawEntry = buildRawEntry({
    canonical: params.canonical,
    now,
    rawMaxAgeMs: state.rawMaxAgeMs,
  });
  if (!rawEntry) {
    return;
  }

  await sweepAndAuditExpiredRaw({
    agentId: params.agentId,
    sessionId: params.sessionId,
    now,
  });
  await writeSessionMemoryRawEntry({
    agentId: params.agentId,
    sessionId: params.sessionId,
    entry: rawEntry,
  });

  const summaryEntries = await readSessionMemorySummaryEntries({
    agentId: params.agentId,
    sessionId: params.sessionId,
  });

  try {
    const child = await runSessionSanitizationHelper<SessionMemoryWriteResult>({
      cfg: params.cfg,
      agentId: params.agentId,
      mode: "write",
      lane: params.helperDeps?.lane,
      runner: params.helperDeps?.runner,
      files: [
        {
          relativePath: "mode.json",
          content: JSON.stringify({ mode: "write" }, null, 2),
        },
        {
          relativePath: "raw-turn.json",
          content: JSON.stringify(rawEntry, null, 2),
        },
        {
          relativePath: "summary-index.jsonl",
          content: buildJsonLines(summaryEntries),
        },
      ],
    });

    if (child.discard) {
      await appendSessionMemoryAuditEntry({
        agentId: params.agentId,
        sessionId: params.sessionId,
        entry: {
          event: "discard",
          timestamp: nowIso(now),
          messageId: rawEntry.messageId,
        },
      });
      return;
    }

    const summaryEntry: SessionMemorySummaryEntry = {
      messageId: rawEntry.messageId,
      timestamp: rawEntry.timestamp,
      rawExpiresAt: rawEntry.expiresAt,
      decisions: child.decisions,
      actionItems: child.actionItems,
      entities: child.entities,
      contextNote: child.contextNote,
      discard: false,
    };
    await upsertSessionMemorySummaryEntry({
      agentId: params.agentId,
      sessionId: params.sessionId,
      entry: summaryEntry,
    });
    await appendSessionMemoryAuditEntry({
      agentId: params.agentId,
      sessionId: params.sessionId,
      entry: {
        event: "write",
        timestamp: nowIso(now),
        messageId: rawEntry.messageId,
      },
    });
  } catch (error) {
    await appendSessionMemoryAuditEntry({
      agentId: params.agentId,
      sessionId: params.sessionId,
      entry: {
        event: "write_failed",
        timestamp: nowIso(now),
        messageId: rawEntry.messageId,
        reason: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

export async function recallSessionMemory(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionId: string;
  query: string;
  helperDeps?: HelperDeps;
}): Promise<SessionMemoryRecallResult> {
  const state = resolveFeatureState({
    cfg: params.cfg,
    agentId: params.agentId,
    sessionId: params.sessionId,
  });
  const query = normalizeText(params.query);
  if (!state.enabled || !state.available || !query) {
    return {
      mode: "recall",
      query,
      result: "",
      confidence: "low",
      source: "summary",
    };
  }

  const now = params.helperDeps?.now?.() ?? Date.now();
  await sweepAndAuditExpiredRaw({
    agentId: params.agentId,
    sessionId: params.sessionId,
    now,
  });

  const summaries = await readSessionMemorySummaryEntries({
    agentId: params.agentId,
    sessionId: params.sessionId,
  });
  const matchedSummaries = sortByLexicalMatch(query, summaries);
  if (matchedSummaries.length === 0) {
    return {
      mode: "recall",
      query,
      result: "",
      confidence: "low",
      source: "summary",
    };
  }
  const rawByMessageId = new Map(
    (
      await readSessionMemoryRawEntries({
        agentId: params.agentId,
        sessionId: params.sessionId,
      })
    ).map(({ entry }) => [entry.messageId, entry] as const),
  );
  const rawWindow = matchedSummaries
    .map((entry) => rawByMessageId.get(entry.messageId))
    .filter((entry): entry is SessionMemoryRawEntry => Boolean(entry));

  const child = await runSessionSanitizationHelper<SessionMemoryRecallChildResult>({
    cfg: params.cfg,
    agentId: params.agentId,
    mode: "recall",
    lane: params.helperDeps?.lane,
    runner: params.helperDeps?.runner,
    files: [
      {
        relativePath: "mode.json",
        content: JSON.stringify({ mode: "recall", query }, null, 2),
      },
      {
        relativePath: "summary-candidates.jsonl",
        content: buildJsonLines(matchedSummaries),
      },
      ...(rawWindow.length > 0
        ? [
            {
              relativePath: "raw-window.jsonl",
              content: buildJsonLines(rawWindow),
            },
          ]
        : []),
    ],
  });

  const resultText = normalizeText(child.result);
  if (!resultText) {
    return {
      mode: "recall",
      query,
      result: "",
      confidence: "low",
      source: "summary",
    };
  }

  const summariesById = new Map(matchedSummaries.map((entry) => [entry.messageId, entry]));
  const verifiedRawMessageIds = new Set(rawWindow.map((entry) => entry.messageId));
  return {
    mode: "recall",
    query,
    result: resultText,
    confidence: normalizeRecallConfidence({
      child,
      summariesById,
      verifiedRawMessageIds,
      now,
    }),
    source: child.source,
  };
}

export async function signalSessionMemory(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionId: string;
  query: string;
  limit?: number;
  helperDeps?: HelperDeps;
}): Promise<SessionMemorySignalResult> {
  const state = resolveFeatureState({
    cfg: params.cfg,
    agentId: params.agentId,
    sessionId: params.sessionId,
  });
  const query = normalizeText(params.query);
  if (!state.enabled || !state.available || !query) {
    return { mode: "signal", relevant: [] };
  }
  const now = params.helperDeps?.now?.() ?? Date.now();
  const limit =
    typeof params.limit === "number" && Number.isFinite(params.limit)
      ? Math.max(1, Math.min(100, Math.floor(params.limit)))
      : 100;
  await sweepAndAuditExpiredRaw({
    agentId: params.agentId,
    sessionId: params.sessionId,
    now,
  });

  const summaries = sortByLexicalMatch(
    query,
    await readSessionMemorySummaryEntries({
      agentId: params.agentId,
      sessionId: params.sessionId,
    }),
  ).slice(0, limit);
  if (summaries.length === 0) {
    return { mode: "signal", relevant: [] };
  }
  const rawEntries = (
    await readSessionMemoryRawEntries({
      agentId: params.agentId,
      sessionId: params.sessionId,
    })
  )
    .map(({ entry }) => entry)
    .filter((entry) => summaries.some((summary) => summary.messageId === entry.messageId))
    .slice(0, limit);

  try {
    return await runSessionSanitizationHelper<SessionMemorySignalResult>({
      cfg: params.cfg,
      agentId: params.agentId,
      mode: "signal",
      lane: params.helperDeps?.lane,
      runner: params.helperDeps?.runner,
      files: [
        {
          relativePath: "mode.json",
          content: JSON.stringify({ mode: "signal", query, limit }, null, 2),
        },
        {
          relativePath: "recent-summary.jsonl",
          content: buildJsonLines(summaries),
        },
        ...(rawEntries.length > 0
          ? [
              {
                relativePath: "recent-raw.jsonl",
                content: buildJsonLines(rawEntries),
              },
            ]
          : []),
      ],
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    try {
      await appendSessionMemoryAuditEntry({
        agentId: params.agentId,
        sessionId: params.sessionId,
        entry: {
          event: "write_failed",
          timestamp: nowIso(now),
          reason: `signal helper failed: ${reason}`,
        },
      });
    } catch (auditError) {
      log.warn("session memory signal audit write failed", {
        agentId: params.agentId,
        sessionId: params.sessionId,
        error: auditError instanceof Error ? auditError.message : String(auditError),
      });
    }
    return {
      mode: "signal",
      relevant: [],
      discarded: "signal helper failed — degraded gracefully",
    };
  }
}

export async function buildAutomaticSessionMemoryPrompt(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionId?: string;
  query: string;
  helperDeps?: HelperDeps;
}): Promise<string | undefined> {
  const sessionId = params.sessionId?.trim();
  if (!sessionId) {
    return undefined;
  }
  const result = await recallSessionMemory({
    cfg: params.cfg,
    agentId: params.agentId,
    sessionId,
    query: params.query,
    helperDeps: params.helperDeps,
  });
  return formatAutomaticRecallPrompt(result);
}

export async function cleanupSessionSanitizationArtifacts(params: {
  agentId: string;
  sessionId?: string;
}): Promise<void> {
  await deleteSessionMemoryArtifacts({
    agentId: params.agentId,
    sessionId: params.sessionId,
  });
}

// ---------------------------------------------------------------------------
// MCP result sanitization
// ---------------------------------------------------------------------------

export type McpProcessResult = {
  /** True if the server was on the trusted list (no sanitization performed). */
  trusted: boolean;
  /** True if the result is safe to pass to the manager. */
  safe: boolean;
  /** Sanitized structured content. Empty object if not safe. */
  structuredResult: Record<string, unknown>;
  /** Flags from the tier that produced the result. */
  flags: string[];
  /** Brief description for audit and logging. */
  contextNote: string;
  /** Which tier blocked or passed the result (undefined for trusted results). */
  tier?: 1 | 2;
};

const SESSION_CONTEXT_MAX_ENTRIES = 10;
const SESSION_CONTEXT_WINDOW_MS = 30 * 60 * 1000;

function buildRecentSessionContext(
  summaries: SessionMemorySummaryEntry[],
  now: number,
): SessionMemorySummaryEntry[] {
  const windowStart = now - SESSION_CONTEXT_WINDOW_MS;
  const last30min = summaries.filter((e) => {
    const ts = Date.parse(e.timestamp);
    return Number.isFinite(ts) && ts >= windowStart;
  });
  const last10 = summaries.slice(-SESSION_CONTEXT_MAX_ENTRIES);
  return last30min.length <= last10.length ? last30min : last10;
}

function buildBlockedResult(flags: string[], contextNote: string, tier: 1 | 2): McpProcessResult {
  return { trusted: false, safe: false, structuredResult: {}, flags, contextNote, tier };
}

export async function processMcpToolResult(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionId: string;
  server: string;
  toolCallId: string;
  toolName: string;
  rawResult: unknown;
  /** The original tool call (query.json for the sub-agent workspace). */
  query: unknown;
  helperDeps?: HelperDeps;
}): Promise<McpProcessResult> {
  const mcpCfg = resolveSessionSanitizationMcpConfig(params.cfg);
  if (!mcpCfg.enabled) {
    // Feature disabled — pass through without sanitization.
    return {
      trusted: false,
      safe: true,
      structuredResult:
        params.rawResult !== null && typeof params.rawResult === "object"
          ? (params.rawResult as Record<string, unknown>)
          : {},
      flags: [],
      contextNote: "mcp sanitization disabled",
    };
  }

  const now = params.helperDeps?.now?.() ?? Date.now();
  const sanitizationCfg = resolveSessionSanitizationConfig(params.cfg);

  // Trusted list fast path.
  if (
    isMcpServerTrusted({
      cfg: params.cfg,
      server: params.server,
    })
  ) {
    await appendSessionMemoryAuditEntry({
      agentId: params.agentId,
      sessionId: params.sessionId,
      entry: {
        event: "trusted_pass",
        timestamp: nowIso(now),
        server: params.server,
        toolCallId: params.toolCallId,
      },
    });
    return {
      trusted: true,
      safe: true,
      structuredResult:
        params.rawResult !== null && typeof params.rawResult === "object"
          ? (params.rawResult as Record<string, unknown>)
          : {},
      flags: [],
      contextNote: `trusted server: ${params.server}`,
    };
  }

  // Sandbox availability check for untrusted servers.
  const availability = resolveSessionSanitizationAvailability({
    cfg: params.cfg,
    agentId: params.agentId,
  });
  if (!availability.available) {
    if (mcpCfg.blockOnSandboxUnavailable) {
      log.warn("mcp sanitization: sandbox unavailable, blocking untrusted result", {
        agentId: params.agentId,
        server: params.server,
        toolCallId: params.toolCallId,
      });
      return buildBlockedResult(
        ["sandbox isolation unavailable — untrusted result blocked"],
        "blocked: sandbox unavailable",
        1,
      );
    }
    if (!warnedSandboxSkipPassthrough.has(params.agentId)) {
      warnedSandboxSkipPassthrough.add(params.agentId);
      log.warn(
        "MCP sanitization sandbox unavailable — returning raw tool result as trusted pass-through (blockOnSandboxUnavailable=false). Raw MCP output will not be inspected. Ensure this deployment is intentional.",
        { agentId: params.agentId, server: params.server },
      );
    }
    return {
      trusted: true,
      safe: true,
      structuredResult:
        params.rawResult !== null && typeof params.rawResult === "object"
          ? (params.rawResult as Record<string, unknown>)
          : {},
      flags: ["sandbox unavailable — sanitization skipped per config"],
      contextNote: "sandbox unavailable, sanitization skipped",
    };
  }

  // Sweep expired MCP raw entries before writing a new one.
  await sweepExpiredSessionMemoryMcpRawEntries({
    agentId: params.agentId,
    sessionId: params.sessionId,
    now,
  });

  // Tier 1 structural pre-filter.
  const tier1 = runTier1PreFilter({ rawResult: params.rawResult });

  if (tier1.blocked) {
    // Write raw mirror with safe: false.
    await writeSessionMemoryMcpRawEntry({
      agentId: params.agentId,
      sessionId: params.sessionId,
      entry: {
        toolCallId: params.toolCallId,
        timestamp: nowIso(now),
        expiresAt: nowIso(now + sanitizationCfg.rawMaxAgeMs),
        server: params.server,
        toolName: params.toolName,
        rawResult: params.rawResult,
        sanitizedResult: {},
        safe: false,
        flags: tier1.blockFlags,
      },
    });
    await appendSessionMemoryAuditEntry({
      agentId: params.agentId,
      sessionId: params.sessionId,
      entry: {
        event: "structural_block",
        timestamp: nowIso(now),
        server: params.server,
        toolCallId: params.toolCallId,
        tier: 1,
        flags: tier1.blockFlags,
      },
    });
    return buildBlockedResult(tier1.blockFlags, tier1.contextNote, 1);
  }

  // Tier 2 — sanitization sub-agent.
  const summaries = await readSessionMemorySummaryEntries({
    agentId: params.agentId,
    sessionId: params.sessionId,
  });
  const sessionContext = buildRecentSessionContext(summaries, now);

  const workspaceFiles: Array<{ relativePath: string; content: string }> = [
    {
      relativePath: "query.json",
      content: JSON.stringify(params.query, null, 2),
    },
    {
      relativePath: "mcp-result.json",
      content: JSON.stringify(params.rawResult, null, 2),
    },
    ...(sessionContext.length > 0
      ? [
          {
            relativePath: "session-context.jsonl",
            content: buildJsonLines(sessionContext),
          },
        ]
      : []),
    ...(tier1.annotationFlags.length > 0
      ? [
          {
            relativePath: "tier1-annotations.json",
            content: JSON.stringify(
              {
                flags: tier1.annotationFlags,
                patternsMatched: tier1.patternsMatched.filter((id) =>
                  tier1.annotationFlags.some((f) => f.startsWith(id)),
                ),
              },
              null,
              2,
            ),
          },
        ]
      : []),
  ];

  let child: SessionMemoryMcpChildResult;
  try {
    child = await runSessionSanitizationHelper<SessionMemoryMcpChildResult>({
      cfg: params.cfg,
      agentId: params.agentId,
      mode: "mcp",
      lane: params.helperDeps?.lane ?? "background:session-memory-mcp",
      runner: params.helperDeps?.runner,
      files: workspaceFiles,
    });
  } catch (error) {
    log.warn("mcp sanitization: sub-agent failed", {
      agentId: params.agentId,
      server: params.server,
      toolCallId: params.toolCallId,
      error: error instanceof Error ? error.message : String(error),
    });
    // Fail closed — treat sub-agent failure as a block.
    await appendSessionMemoryAuditEntry({
      agentId: params.agentId,
      sessionId: params.sessionId,
      entry: {
        event: "sanitized_block",
        timestamp: nowIso(now),
        server: params.server,
        toolCallId: params.toolCallId,
        tier: 2,
        flags: ["sub-agent error"],
      },
    });
    return buildBlockedResult(["sanitization sub-agent failed"], "blocked: sub-agent error", 2);
  }

  // Write raw mirror with final known state.
  await writeSessionMemoryMcpRawEntry({
    agentId: params.agentId,
    sessionId: params.sessionId,
    entry: {
      toolCallId: params.toolCallId,
      timestamp: nowIso(now),
      expiresAt: nowIso(now + sanitizationCfg.rawMaxAgeMs),
      server: params.server,
      toolName: params.toolName,
      rawResult: params.rawResult,
      sanitizedResult: child.safe ? child.structuredResult : {},
      safe: child.safe,
      flags: child.flags,
    },
  });

  if (!child.safe) {
    await appendSessionMemoryAuditEntry({
      agentId: params.agentId,
      sessionId: params.sessionId,
      entry: {
        event: "sanitized_block",
        timestamp: nowIso(now),
        server: params.server,
        toolCallId: params.toolCallId,
        tier: 2,
        flags: child.flags,
      },
    });
    return buildBlockedResult(child.flags, child.contextNote, 2);
  }

  // Safe: append summary entry and log pass.
  const summaryEntry: SessionMemorySummaryEntry = {
    messageId: params.toolCallId,
    timestamp: nowIso(now),
    rawExpiresAt: nowIso(now + sanitizationCfg.rawMaxAgeMs),
    decisions: [],
    actionItems: [],
    entities: [],
    contextNote: child.contextNote || undefined,
    discard: false,
  };
  await upsertSessionMemorySummaryEntry({
    agentId: params.agentId,
    sessionId: params.sessionId,
    entry: summaryEntry,
  });
  await appendSessionMemoryAuditEntry({
    agentId: params.agentId,
    sessionId: params.sessionId,
    entry: {
      event: "sanitized_pass",
      timestamp: nowIso(now),
      server: params.server,
      toolCallId: params.toolCallId,
      tier: 2,
    },
  });

  return {
    trusted: false,
    safe: true,
    structuredResult: child.structuredResult,
    flags: child.flags,
    contextNote: child.contextNote,
    tier: 2,
  };
}
