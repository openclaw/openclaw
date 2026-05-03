import fs from "node:fs";
import path from "node:path";
import { parseByteSize } from "../cli/parse-bytes.js";
import { resolveSessionTranscriptsDirForAgent } from "../config/sessions/paths.js";
import type { OpenClawConfig } from "../config/types.js";
import { normalizeStringifiedOptionalString } from "../shared/string-coerce.js";
import { sanitizeForLog } from "../terminal/ansi.js";

/**
 * Defensive guard that runs when a configured context engine fails to resolve
 * and {@link resolveContextEngine} falls back to the default `legacy` engine.
 *
 * Background (#76940): when a context-engine plugin (e.g. lossless-claw) gets
 * disabled — silently or by user error — the gateway loads existing session
 * transcripts with their full message history. For users whose sessions were
 * growing under an active context engine, the resulting load cascade looks
 * like a generic gateway stall rather than "your context engine vanished."
 *
 * This guard runs at the moment the fallback decision is made. It walks the
 * affected agent's transcript directory and, for any jsonl whose size exceeds
 * the configured threshold, takes one of:
 *
 *   - "warn":    log a structured, actionable warning naming the file + size
 *   - "archive": rename the jsonl out of the live path so the next session
 *                load starts fresh (recoverable via existing archive recovery)
 *   - "block":   throw, refusing to start until an operator takes action
 *   - "auto":    smart default — archive if the session has prior context-
 *                engine activity (lcm-style sqlite db present), warn otherwise
 *
 * For users running a context engine like LCM, the jsonl on disk is NOT the
 * source of truth — the engine persists the full transcript into its own
 * store at every compaction. Archiving the jsonl loses at most the fresh
 * tail (~32-64 messages), the same blast radius as a forced compaction. For
 * users on the default legacy engine the jsonl IS the only record, so `auto`
 * conservatively warns instead of archiving.
 */

/**
 * Default per-transcript byte threshold. 2 MiB of jsonl text is roughly
 * 500k tokens of message content (ratios vary by tool-result density).
 * 500k tokens overflows every shipping context window; for models in the
 * 200-256k effective-window range it overflows much sooner. Operators on
 * smaller-context models can dial this down via
 * `session.maintenance.contextFallbackGuard.sizeBytes`.
 */
export const DEFAULT_FALLBACK_GUARD_SIZE_BYTES = 2 * 1_048_576; // 2 MiB
export const DEFAULT_FALLBACK_GUARD_ACTION = "auto" as const;

export type FallbackGuardAction = "warn" | "archive" | "block" | "auto";

export type FallbackGuardEntry = {
  /** Absolute path to the session transcript file. */
  path: string;
  /** Size in bytes at the time the guard observed it. */
  sizeBytes: number;
  /** Action that was applied to this entry. */
  appliedAction: Exclude<FallbackGuardAction, "auto">;
  /** New path after archive (only set when appliedAction === "archive"). */
  archivedPath?: string;
};

export type FallbackGuardOutcome = {
  /** Number of session files inspected. */
  inspected: number;
  /** Files that exceeded the threshold and had an action applied. */
  triggered: FallbackGuardEntry[];
  /** Resolved size threshold actually used (after parsing). */
  resolvedSizeBytes: number;
  /** Resolved action actually used (after auto resolution). */
  resolvedAction: Exclude<FallbackGuardAction, "auto"> | null;
};

export type FallbackGuardLogger = {
  warn(message: string): void;
  error?(message: string): void;
  info?(message: string): void;
};

export type ApplyFallbackGuardOptions = {
  config?: OpenClawConfig;
  agentDir?: string;
  agentId?: string;
  /** Plugin id of the engine that failed to resolve (for log messages). */
  failedEngineId: string;
  /** Short reason string explaining why fallback fired. */
  fallbackReason: string;
  /** Optional logger; defaults to console. */
  logger?: FallbackGuardLogger;
  /**
   * Override for the sessions dir resolver — primarily for tests. Receives
   * the agent id (or undefined) and returns an absolute directory path.
   */
  resolveSessionsDir?: (agentId?: string) => string;
  /**
   * Override for the "auto" action resolver — primarily for tests. Receives
   * the sessions dir and returns whether the session has prior context-engine
   * activity (which makes archive the safer default).
   */
  hasContextEngineHistory?: (sessionsDir: string) => boolean;
  /** Filesystem facade — primarily for tests. */
  fs?: Pick<typeof fs, "readdirSync" | "statSync" | "renameSync" | "existsSync">;
  /**
   * Process-level dedup state used to suppress repeated warnings for the
   * same session path. Pass an explicit Set to scope dedup; defaults to a
   * shared module-level Set (one warning per session path per process).
   */
  warnedPaths?: Set<string>;
};

const DEFAULT_WARNED_PATHS = new Set<string>();

const SESSION_ARCHIVE_SUFFIX = ".archived-no-context-engine";

function resolveGuardConfig(config?: OpenClawConfig): {
  sizeBytes: number;
  action: FallbackGuardAction;
} {
  const guard = config?.session?.maintenance?.contextFallbackGuard;
  let sizeBytes = DEFAULT_FALLBACK_GUARD_SIZE_BYTES;
  if (guard?.sizeBytes !== undefined) {
    try {
      const parsed = parseByteSize(normalizeStringifiedOptionalString(guard.sizeBytes) ?? "", {
        defaultUnit: "b",
      });
      if (typeof parsed === "number" && Number.isFinite(parsed) && parsed > 0) {
        sizeBytes = parsed;
      }
    } catch {
      // fall through to default — schema validation surfaces the parse error
      // separately so we don't double-log here.
    }
  }
  const action: FallbackGuardAction = guard?.action ?? DEFAULT_FALLBACK_GUARD_ACTION;
  return { sizeBytes, action };
}

/**
 * Heuristic for the `auto` action: if the agent's state directory contains
 * a context-engine sqlite store (the convention for engines like
 * lossless-claw), the engine has historical compaction data — archiving the
 * jsonl is safe because the source of truth lives elsewhere. If no such
 * marker exists, conservatively fall back to `warn`.
 */
function defaultHasContextEngineHistory(sessionsDir: string): boolean {
  // sessionsDir = ~/.openclaw/agents/<id>/sessions
  // walk up two levels to find the state root, then look for known engine dbs.
  const stateRoot = path.dirname(path.dirname(path.dirname(sessionsDir)));
  const candidates = ["lcm.db", "lossless-claw.db", "context-engine.db"];
  for (const name of candidates) {
    if (fs.existsSync(path.join(stateRoot, name))) {
      return true;
    }
  }
  return false;
}

function isLiveSessionTranscript(filename: string): boolean {
  if (!filename.endsWith(".jsonl")) {
    return false;
  }
  if (filename.includes(".archived-")) {
    return false;
  }
  if (filename.includes(".bak")) {
    return false;
  }
  if (filename.includes(".reset")) {
    return false;
  }
  if (filename.includes(".trim-backup")) {
    return false;
  }
  if (filename.includes(".deleted")) {
    return false;
  }
  return true;
}

function archiveTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export function applyContextEngineFallbackGuard(
  options: ApplyFallbackGuardOptions,
): FallbackGuardOutcome {
  const logger: FallbackGuardLogger = options.logger ?? {
    warn: (m) => console.warn(m),
    error: (m) => console.error(m),
  };
  const ioFs = options.fs ?? fs;
  const warnedPaths = options.warnedPaths ?? DEFAULT_WARNED_PATHS;

  const { sizeBytes: thresholdBytes, action: requestedAction } = resolveGuardConfig(options.config);

  let sessionsDir: string;
  try {
    sessionsDir = options.resolveSessionsDir
      ? options.resolveSessionsDir(options.agentId)
      : resolveSessionTranscriptsDirForAgent(options.agentId);
  } catch (err) {
    logger.warn(
      `[context-engine] fallback guard could not resolve sessions dir for agent ` +
        `"${sanitizeForLog(options.agentId ?? "(default)")}": ${sanitizeForLog(
          err instanceof Error ? err.message : String(err),
        )}`,
    );
    return {
      inspected: 0,
      triggered: [],
      resolvedSizeBytes: thresholdBytes,
      resolvedAction: null,
    };
  }

  if (!ioFs.existsSync(sessionsDir)) {
    return {
      inspected: 0,
      triggered: [],
      resolvedSizeBytes: thresholdBytes,
      resolvedAction: null,
    };
  }

  let entries: string[];
  try {
    entries = ioFs.readdirSync(sessionsDir);
  } catch (err) {
    logger.warn(
      `[context-engine] fallback guard could not read sessions dir ` +
        `"${sanitizeForLog(sessionsDir)}": ${sanitizeForLog(
          err instanceof Error ? err.message : String(err),
        )}`,
    );
    return {
      inspected: 0,
      triggered: [],
      resolvedSizeBytes: thresholdBytes,
      resolvedAction: null,
    };
  }

  const liveTranscripts = entries.filter(isLiveSessionTranscript);

  const hasHistoryFn = options.hasContextEngineHistory ?? defaultHasContextEngineHistory;
  const resolvedAction: Exclude<FallbackGuardAction, "auto"> =
    requestedAction === "auto" ? (hasHistoryFn(sessionsDir) ? "archive" : "warn") : requestedAction;

  const triggered: FallbackGuardEntry[] = [];
  for (const entry of liveTranscripts) {
    const fullPath = path.join(sessionsDir, entry);
    let stat: fs.Stats;
    try {
      stat = ioFs.statSync(fullPath);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size <= thresholdBytes) {
      continue;
    }

    const result: FallbackGuardEntry = {
      path: fullPath,
      sizeBytes: stat.size,
      appliedAction: resolvedAction,
    };

    const sizeMb = (stat.size / 1_048_576).toFixed(2);
    const thresholdMb = (thresholdBytes / 1_048_576).toFixed(2);
    const summary =
      `[context-engine] session-size guard tripped: agent="${sanitizeForLog(
        options.agentId ?? "(default)",
      )}" engine="${sanitizeForLog(options.failedEngineId)}" reason="${sanitizeForLog(
        options.fallbackReason,
      )}" file="${sanitizeForLog(entry)}" size=${sizeMb}MiB threshold=${thresholdMb}MiB`;

    if (resolvedAction === "warn") {
      if (!warnedPaths.has(fullPath)) {
        warnedPaths.add(fullPath);
        logger.warn(
          renderWarnMessage({
            summary,
            archivedPath: null,
            agentId: options.agentId,
            failedEngineId: options.failedEngineId,
            fallbackReason: options.fallbackReason,
            sizeMb,
            originalPath: fullPath,
          }),
        );
      }
      triggered.push(result);
      continue;
    }

    if (resolvedAction === "archive") {
      const archivedPath = `${fullPath.replace(/\.jsonl$/u, "")}${SESSION_ARCHIVE_SUFFIX}-${archiveTimestamp()}.jsonl`;
      try {
        ioFs.renameSync(fullPath, archivedPath);
        result.archivedPath = archivedPath;
        logger.warn(
          renderArchiveMessage({
            summary,
            archivedPath,
            agentId: options.agentId,
            failedEngineId: options.failedEngineId,
            fallbackReason: options.fallbackReason,
            sizeMb,
            originalPath: fullPath,
          }),
        );
      } catch (err) {
        logger.error?.(
          `${summary} action=archive FAILED: ${sanitizeForLog(
            err instanceof Error ? err.message : String(err),
          )} — manual intervention required.`,
        );
        // Treat unarchivable as warn so we still surface the entry but don't
        // silently lose the signal.
        result.appliedAction = "warn";
      }
      triggered.push(result);
      continue;
    }

    if (resolvedAction === "block") {
      logger.error?.(
        `${summary} action=block — refusing to resolve fallback engine. ` +
          `Repair the configured context-engine plugin or rotate the offending ` +
          `transcript before retrying.`,
      );
      triggered.push(result);
      // The caller decides how to surface block (typically by throwing). We
      // return the outcome so the caller can include details in the error.
      continue;
    }
  }

  return {
    inspected: liveTranscripts.length,
    triggered,
    resolvedSizeBytes: thresholdBytes,
    resolvedAction,
  };
}

/**
 * True if the outcome contains any entries that the caller should treat as
 * a hard block (i.e. {@link ApplyFallbackGuardOptions.config} requested
 * `action: "block"` and at least one file exceeded the threshold).
 */
export function fallbackGuardOutcomeIsBlocking(outcome: FallbackGuardOutcome): boolean {
  return outcome.triggered.some((entry) => entry.appliedAction === "block");
}

// ---------------------------------------------------------------------------
// Periodic (boot-time) guard
// ---------------------------------------------------------------------------
//
// The on-fallback path catches "configured engine failed to load" — but does
// not protect users who run on the default `legacy` engine (no engine
// configured, or `slots.contextEngine` unset). The legacy engine compacts
// in-memory at request time and never shrinks the on-disk jsonl, so an
// unmanaged session can still grow until it stalls the gateway on next load.
//
// {@link applyContextEngineBootGuard} runs once at gateway startup and
// applies the same size-guard policy when the active context engine is
// "legacy" (i.e. no real engine is managing the on-disk transcripts). This
// gives operators a single config knob that protects every user, not only
// users with a configured-but-broken engine.

export type ApplyBootGuardOptions = Omit<
  ApplyFallbackGuardOptions,
  "failedEngineId" | "fallbackReason"
> & {
  /** Resolved active context-engine plugin id, or "legacy" / undefined for default. */
  activeContextEngineId: string | undefined;
  /** Plugin ids that successfully loaded at gateway boot. */
  loadedPluginIds: ReadonlySet<string>;
};

/**
 * Boot-time periodic guard. Returns null when no guard is needed (an active
 * context engine is loaded for the slot). Otherwise applies the same size
 * policy as {@link applyContextEngineFallbackGuard} with a synthesized
 * "no-active-context-engine" reason.
 *
 * Trigger conditions:
 *   - `slots.contextEngine` is unset, "legacy", or empty → no engine ever
 *     manages this session → guard runs.
 *   - `slots.contextEngine` is set but the plugin isn't in
 *     `loadedPluginIds` → engine failed to load → guard runs.
 *   - `slots.contextEngine` matches a loaded plugin → guard short-circuits
 *     (the engine itself is responsible for size management).
 */
export function applyContextEngineBootGuard(
  options: ApplyBootGuardOptions,
): FallbackGuardOutcome | null {
  const slot = options.config?.plugins?.slots?.contextEngine?.trim();
  const normalizedSlot = slot && slot.length > 0 ? slot : "legacy";
  const isLegacy = normalizedSlot === "legacy";
  const engineLoaded = options.loadedPluginIds.has(normalizedSlot);

  // Engine is configured AND loaded — engine owns size management; skip.
  if (!isLegacy && engineLoaded) {
    return null;
  }

  const failedEngineId = isLegacy ? "(legacy/none)" : normalizedSlot;
  const fallbackReason = isLegacy
    ? "no context engine configured (slots.contextEngine is unset or 'legacy')"
    : `configured engine "${normalizedSlot}" did not load at gateway startup`;

  return applyContextEngineFallbackGuard({
    config: options.config,
    agentDir: options.agentDir,
    agentId: options.agentId,
    failedEngineId,
    fallbackReason,
    logger: options.logger,
    resolveSessionsDir: options.resolveSessionsDir,
    hasContextEngineHistory: options.hasContextEngineHistory,
    fs: options.fs,
    warnedPaths: options.warnedPaths,
  });
}

// ---------------------------------------------------------------------------
// Operator-facing message renderers
// ---------------------------------------------------------------------------
//
// These emit a multi-line block that operators see in the gateway log. The
// recovery prompt is copy-pasteable into the agent chat in a fresh session
// and instructs the agent to summarize the archived tail using LCM-style
// chunked summaries — sized to reload meaningful context (~40k tokens of
// summary across the last ~200 messages) into the new session, since the
// fresh session has the full context window available to absorb it.

type GuardMessageContext = {
  summary: string;
  archivedPath: string | null;
  agentId: string | undefined;
  failedEngineId: string;
  fallbackReason: string;
  sizeMb: string;
  originalPath: string;
};

const RECOVERY_PROMPT_MAX_SUMMARY_TOKENS = 40_000;
const RECOVERY_PROMPT_PER_CHUNK_MIN_TOKENS = 1_000;
const RECOVERY_PROMPT_PER_CHUNK_MAX_TOKENS = 2_000;
const RECOVERY_PROMPT_TAIL_MESSAGES = 200;

function renderRecoveryPrompt(params: {
  archivedPath: string | null;
  originalPath: string;
}): string {
  const target = params.archivedPath ?? params.originalPath;
  return [
    `My previous session was archived because the configured context-engine plugin`,
    `failed to load and the transcript would have overflowed the model context on`,
    `next gateway start. Read the archived transcript at:`,
    ``,
    `  ${target}`,
    ``,
    `Take the last ~${RECOVERY_PROMPT_TAIL_MESSAGES} non-system messages (skip heartbeat,`,
    `synthetic, and bootstrap turns). Group them into chronological chunks of`,
    `~${RECOVERY_PROMPT_PER_CHUNK_MIN_TOKENS}-${RECOVERY_PROMPT_PER_CHUNK_MAX_TOKENS} tokens each — one chunk per coherent unit of work (a`,
    `tool-call run, a topic shift, a multi-message exchange). For each chunk emit a`,
    `${RECOVERY_PROMPT_PER_CHUNK_MIN_TOKENS}-${RECOVERY_PROMPT_PER_CHUNK_MAX_TOKENS} token summary that:`,
    `  - names the goal of the work in that chunk,`,
    `  - lists tools called with key inputs/outputs (file paths, commits, decisions),`,
    `  - notes unresolved threads, errors, or pending follow-ups.`,
    ``,
    `Stop at ~${(RECOVERY_PROMPT_MAX_SUMMARY_TOKENS / 1000).toFixed(0)}k tokens of aggregate summary so the fresh session keeps`,
    `headroom. Output chunks in chronological order with one-line dividers like`,
    `"chunk N: <topic>" so I can reference them later. After the chunks, give:`,
    `  - "open threads": anything in-flight,`,
    `  - "decisions made": anything settled,`,
    `  - "next likely action": what I would have done next.`,
    ``,
    `That summary is now my working context — proceed from there.`,
  ].join("\n");
}

function indent(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function renderWarnMessage(ctx: GuardMessageContext): string {
  const recoveryPrompt = renderRecoveryPrompt({
    archivedPath: null,
    originalPath: ctx.originalPath,
  });
  return [
    ctx.summary,
    "",
    `[context-engine] Session-size guard: a transcript would stall the gateway on next load.`,
    ``,
    `  Reason:    Context engine "${sanitizeForLog(ctx.failedEngineId)}" is configured but failed`,
    `             (${sanitizeForLog(ctx.fallbackReason)}). Falling back to the default`,
    `             "legacy" engine, which does not shrink on-disk transcripts.`,
    ``,
    `  Transcript: ${ctx.originalPath}`,
    `              (${ctx.sizeMb} MiB — ${RECOVERY_PROMPT_MAX_SUMMARY_TOKENS / 1_000}k+ tokens of message content)`,
    ``,
    `  Action:    warn (no automatic archive)`,
    ``,
    `  Repair the engine, then restart the gateway:`,
    `    openclaw doctor --fix`,
    `    launchctl kickstart -k gui/$(id -u)/ai.openclaw.gateway   # macOS`,
    ``,
    `  Or rotate this transcript yourself before next gateway start:`,
    `    openclaw sessions archive ${path.basename(ctx.originalPath, ".jsonl")}`,
    ``,
    `  Or remove the configured slot to fall back cleanly:`,
    `    openclaw config set plugins.slots.contextEngine ""`,
    ``,
    `  If you choose archive instead, paste this into the next agent turn to`,
    `  reload meaningful context from the tail of the transcript:`,
    `  ┌─────────────────────────────────────────────────────────────────────────┐`,
    indent(recoveryPrompt, "  │ "),
    `  └─────────────────────────────────────────────────────────────────────────┘`,
  ].join("\n");
}

function renderArchiveMessage(ctx: GuardMessageContext): string {
  const archivedPath = ctx.archivedPath;
  if (!archivedPath) {
    // Defensive: archive renderer always called with a real archived path.
    return ctx.summary;
  }
  const recoveryPrompt = renderRecoveryPrompt({
    archivedPath,
    originalPath: ctx.originalPath,
  });
  return [
    ctx.summary,
    "",
    `[context-engine] Session-size guard archived a transcript that would have stalled the gateway.`,
    ``,
    `  Reason:    Context engine "${sanitizeForLog(ctx.failedEngineId)}" is configured but failed`,
    `             (${sanitizeForLog(ctx.fallbackReason)}). Falling back to the default`,
    `             "legacy" engine would have loaded the full transcript on next start.`,
    ``,
    `  Archived:  ${ctx.originalPath}`,
    `             → ${archivedPath}`,
    `             (${ctx.sizeMb} MiB — ${RECOVERY_PROMPT_MAX_SUMMARY_TOKENS / 1_000}k+ tokens of message content)`,
    ``,
    `  Next session start will be fresh and small. To recover the prior context,`,
    `  paste this prompt into the agent on the first turn:`,
    `  ┌─────────────────────────────────────────────────────────────────────────┐`,
    indent(recoveryPrompt, "  │ "),
    `  └─────────────────────────────────────────────────────────────────────────┘`,
    ``,
    `  Repair the engine plugin so this does not repeat:`,
    `    openclaw doctor --fix`,
    ``,
    `  Or remove the configured slot to fall back cleanly without this guard:`,
    `    openclaw config set plugins.slots.contextEngine ""`,
  ].join("\n");
}
