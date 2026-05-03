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

export const DEFAULT_FALLBACK_GUARD_SIZE_BYTES = 1_048_576; // 1 MiB
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
    const baseMessage = `[context-engine] session-size guard tripped: agent="${sanitizeForLog(
      options.agentId ?? "(default)",
    )}" engine="${sanitizeForLog(options.failedEngineId)}" reason="${sanitizeForLog(
      options.fallbackReason,
    )}" file="${sanitizeForLog(entry)}" size=${sizeMb}MiB threshold=${(
      thresholdBytes / 1_048_576
    ).toFixed(2)}MiB`;

    if (resolvedAction === "warn") {
      if (!warnedPaths.has(fullPath)) {
        warnedPaths.add(fullPath);
        logger.warn(
          `${baseMessage} action=warn — install or repair the configured ` +
            `context-engine plugin, or run \`openclaw sessions archive\` to ` +
            `rotate this transcript before the next gateway start.`,
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
          `${baseMessage} action=archive archivedTo="${sanitizeForLog(path.basename(archivedPath))}"` +
            ` — original transcript moved aside; next session start will be fresh.`,
        );
      } catch (err) {
        logger.error?.(
          `${baseMessage} action=archive FAILED: ${sanitizeForLog(
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
        `${baseMessage} action=block — refusing to resolve fallback engine. ` +
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
