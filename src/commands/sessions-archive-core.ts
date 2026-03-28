import { parseDurationMs } from "../cli/parse-duration.js";
import { loadConfig, type OpenClawConfig } from "../config/config.js";
import {
  loadSessionStore,
  resolveSessionStoreTargets,
  type SessionEntry,
  type SessionStoreTarget,
  updateSessionStore,
} from "../config/sessions.js";
import { archiveSessionTranscripts } from "../gateway/session-utils.js";
import {
  isCronSessionKey,
  normalizeMainKey,
  parseAgentSessionKey,
} from "../routing/session-key.js";
import { toSessionDisplayRows } from "./sessions-table.js";

export type SessionsArchiveStatus = "done" | "killed" | "timeout";

export type SessionsArchiveOptions = {
  sessionKey?: string;
  store?: string;
  agent?: string;
  allAgents?: boolean;
  status?: SessionsArchiveStatus;
  olderThan?: string;
  dryRun?: boolean;
};

export type SessionArchiveAction = "archive" | "skip";
export type SessionArchiveSkipReason = "active" | "main" | "cron";

export type SessionArchiveActionRow = ReturnType<typeof toSessionDisplayRows>[number] & {
  action: SessionArchiveAction;
  status: string | null;
  reason: SessionArchiveSkipReason | null;
};

export type SessionArchiveSummary = {
  agentId: string;
  storePath: string;
  dryRun: boolean;
  requestedKey: string | null;
  status: SessionsArchiveStatus | null;
  olderThan: string | null;
  olderThanMs: number | null;
  totalEntries: number;
  matched: number;
  eligible: number;
  skipped: number;
  archived: number;
  transcriptFilesArchived: number;
  wouldMutate: boolean;
};

export type SessionsArchiveStoreResult = {
  summary: SessionArchiveSummary;
  actionRows: SessionArchiveActionRow[];
  eligibleKeys: string[];
};

export type SessionsArchiveRunResult = {
  allAgents: boolean;
  requestedKey: string | null;
  status: SessionsArchiveStatus | null;
  olderThan: string | null;
  stores: SessionsArchiveStoreResult[];
};

export class SessionsArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionsArchiveError";
  }
}

function normalizeStatus(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.toLowerCase() : null;
}

function isActiveSession(entry: SessionEntry | undefined): boolean {
  const status = normalizeStatus(entry?.status);
  return status === "running" || status === "active" || status?.startsWith("active ") === true;
}

function isProtectedMainSession(params: { key: string; cfg: OpenClawConfig }): boolean {
  const trimmed = params.key.trim();
  if (!trimmed) {
    return false;
  }
  if (trimmed === "global") {
    return true;
  }
  const parsed = parseAgentSessionKey(trimmed);
  if (!parsed) {
    return trimmed === normalizeMainKey(params.cfg.session?.mainKey);
  }
  return parsed.rest === normalizeMainKey(params.cfg.session?.mainKey);
}

function resolveSkipReason(params: {
  key: string;
  entry: SessionEntry | undefined;
  cfg: OpenClawConfig;
}): SessionArchiveSkipReason | null {
  if (isProtectedMainSession({ key: params.key, cfg: params.cfg })) {
    return "main";
  }
  if (isCronSessionKey(params.key) || params.key.includes(":cron:")) {
    return "cron";
  }
  if (isActiveSession(params.entry)) {
    return "active";
  }
  return null;
}

export function formatArchiveReason(reason: SessionArchiveSkipReason | null): string {
  if (reason === "main") {
    return "protected main session";
  }
  if (reason === "cron") {
    return "protected cron session";
  }
  if (reason === "active") {
    return "session still active";
  }
  return "";
}

function resolveStoreArchiveCandidates(params: {
  cfg: OpenClawConfig;
  store: Record<string, SessionEntry>;
  sessionKey?: string;
  status?: SessionsArchiveStatus;
  olderThanMs?: number;
  nowMs: number;
}) {
  const requestedKey = params.sessionKey?.trim();
  const selectedEntries = Object.entries(params.store).filter(([key, entry]) => {
    if (requestedKey) {
      return key === requestedKey;
    }
    if (params.status && normalizeStatus(entry?.status) !== params.status) {
      return false;
    }
    if (params.olderThanMs != null) {
      const updatedAt = entry?.updatedAt;
      if (!updatedAt || params.nowMs - updatedAt < params.olderThanMs) {
        return false;
      }
    }
    return true;
  });

  const actionByKey = new Map<
    string,
    { action: SessionArchiveAction; reason: SessionArchiveSkipReason | null }
  >();
  for (const [key, entry] of selectedEntries) {
    const reason = resolveSkipReason({ key, entry, cfg: params.cfg });
    actionByKey.set(key, {
      action: reason ? "skip" : "archive",
      reason,
    });
  }

  const selectedStore = Object.fromEntries(selectedEntries);
  const actionRows = toSessionDisplayRows(selectedStore).map((row) => {
    const entry = params.store[row.key];
    const action = actionByKey.get(row.key);
    return {
      ...row,
      action: action?.action ?? "skip",
      status: normalizeStatus(entry?.status),
      reason: action?.reason ?? null,
    } satisfies SessionArchiveActionRow;
  });

  const eligibleRows = actionRows.filter((row) => row.action === "archive");
  const skippedRows = actionRows.filter((row) => row.action === "skip");
  return {
    actionRows,
    eligibleRows,
    skippedRows,
  };
}

async function applyStoreArchive(params: {
  target: SessionStoreTarget;
  keys: string[];
}): Promise<{ archived: number; transcriptFilesArchived: number }> {
  const removed = await updateSessionStore(
    params.target.storePath,
    (store) => {
      const deleted: Array<{
        key: string;
        sessionId?: string;
        sessionFile?: string;
      }> = [];
      for (const key of params.keys) {
        const entry = store[key];
        if (!entry) {
          continue;
        }
        deleted.push({
          key,
          sessionId: entry.sessionId,
          sessionFile: entry.sessionFile,
        });
        delete store[key];
      }
      return deleted;
    },
    {
      skipMaintenance: true,
    },
  );

  let transcriptFilesArchived = 0;
  for (const entry of removed) {
    if (!entry.sessionId) {
      continue;
    }
    transcriptFilesArchived += archiveSessionTranscripts({
      sessionId: entry.sessionId,
      storePath: params.target.storePath,
      sessionFile: entry.sessionFile,
      agentId: params.target.agentId,
      reason: "deleted",
      restrictToStoreDir: true,
    }).length;
  }

  return {
    archived: removed.length,
    transcriptFilesArchived,
  };
}

export function parseSessionsArchiveOlderThan(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  return parseDurationMs(String(value).trim(), { defaultUnit: "d" });
}

export function resolveSessionsArchiveTargets(params: {
  cfg: OpenClawConfig;
  opts: SessionsArchiveOptions;
}): SessionStoreTarget[] {
  const requestedKey = params.opts.sessionKey?.trim();
  const requestedKeyAgentId = requestedKey
    ? parseAgentSessionKey(requestedKey)?.agentId
    : undefined;
  return resolveSessionStoreTargets(params.cfg, {
    store: params.opts.store,
    agent:
      params.opts.agent ??
      (!params.opts.store && !params.opts.allAgents && requestedKeyAgentId
        ? requestedKeyAgentId
        : undefined),
    allAgents: params.opts.allAgents,
  });
}

export async function runSessionsArchive(
  opts: SessionsArchiveOptions,
  cfg: OpenClawConfig = loadConfig(),
): Promise<SessionsArchiveRunResult> {
  const requestedKey = opts.sessionKey?.trim();
  if (requestedKey && (opts.status || opts.olderThan)) {
    throw new SessionsArchiveError(
      "Do not combine a specific <session-key> with --status or --older-than.",
    );
  }
  if (!requestedKey && !opts.status && !opts.olderThan) {
    throw new SessionsArchiveError(
      "Provide a <session-key> or at least one batch selector (--status/--older-than).",
    );
  }

  let olderThanMs: number | undefined;
  try {
    olderThanMs = parseSessionsArchiveOlderThan(opts.olderThan);
  } catch {
    throw new SessionsArchiveError(
      "--older-than must be a valid duration (for example: 24h, 7d, 1h30m)",
    );
  }

  const targets = resolveSessionsArchiveTargets({ cfg, opts });
  const nowMs = Date.now();
  const stores: SessionsArchiveStoreResult[] = [];

  for (const target of targets) {
    const store = loadSessionStore(target.storePath, { skipCache: true });
    const { actionRows, eligibleRows, skippedRows } = resolveStoreArchiveCandidates({
      cfg,
      store,
      sessionKey: opts.sessionKey,
      status: opts.status,
      olderThanMs,
      nowMs,
    });
    stores.push({
      summary: {
        agentId: target.agentId,
        storePath: target.storePath,
        dryRun: Boolean(opts.dryRun),
        requestedKey: requestedKey || null,
        status: opts.status ?? null,
        olderThan: opts.olderThan?.trim() || null,
        olderThanMs: olderThanMs ?? null,
        totalEntries: Object.keys(store).length,
        matched: actionRows.length,
        eligible: eligibleRows.length,
        skipped: skippedRows.length,
        archived: opts.dryRun ? eligibleRows.length : 0,
        transcriptFilesArchived: 0,
        wouldMutate: eligibleRows.length > 0,
      },
      actionRows,
      eligibleKeys: eligibleRows.map((row) => row.key),
    });
  }

  if (requestedKey) {
    const storesWithMatches = stores.filter((result) => result.summary.matched > 0);
    if (storesWithMatches.length === 0) {
      throw new SessionsArchiveError(
        `Session ${opts.sessionKey} was not found in the selected session store(s).`,
      );
    }
    if (storesWithMatches.length > 1) {
      throw new SessionsArchiveError(
        `Session ${opts.sessionKey} matched multiple session stores. Narrow the scope with --agent or --store.`,
      );
    }
    if (!opts.dryRun && storesWithMatches[0]?.summary.eligible === 0) {
      const blocked = storesWithMatches[0]?.actionRows[0];
      throw new SessionsArchiveError(
        blocked?.reason
          ? `Cannot archive ${opts.sessionKey}: ${formatArchiveReason(blocked.reason)}.`
          : `Cannot archive ${opts.sessionKey}.`,
      );
    }
  }

  if (!opts.dryRun) {
    for (const result of stores) {
      if (result.eligibleKeys.length === 0) {
        continue;
      }
      const applied = await applyStoreArchive({
        target: {
          agentId: result.summary.agentId,
          storePath: result.summary.storePath,
        },
        keys: result.eligibleKeys,
      });
      result.summary.archived = applied.archived;
      result.summary.transcriptFilesArchived = applied.transcriptFilesArchived;
      result.summary.dryRun = false;
    }
  }

  return {
    allAgents: Boolean(opts.allAgents),
    requestedKey: requestedKey || null,
    status: opts.status ?? null,
    olderThan: opts.olderThan?.trim() || null,
    stores,
  };
}
