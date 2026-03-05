import { archiveSessionTranscripts } from "../gateway/session-utils.fs.js";
import {
  loadConfig,
  loadSessionStore,
  updateSessionStore,
  type SessionEntry,
} from "../config/sessions.js";
import { parseDurationMs } from "../cli/parse-duration.js";
import { resolveSessionStoreTargetsOrExit } from "./session-store-targets.js";
import type { RuntimeEnv } from "../runtime.js";

type SessionsDeleteCriteria =
  | { mode: "rm"; key: string }
  | { mode: "clear-all" }
  | { mode: "clear-older-than"; olderThanMs: number; nowMs: number };

type SessionDeletionPlan = {
  beforeCount: number;
  deletedKeys: string[];
  deletedSessionIds: string[];
  sessionFileBySessionId: Map<string, string | undefined>;
};

type DeletionApplyResult = {
  deletedCount: number;
  deletedKeys: string[];
  archivedSessionIds: string[];
};

type SessionsDeleteSummary = {
  agentId: string;
  storePath: string;
  mode: "rm" | "clear-all" | "clear-older-than";
  dryRun: boolean;
  beforeCount: number;
  afterCount: number;
  deletedCount: number;
  deletedKeys: string[];
  deletedSessionIds: string[];
};

function normalizeLookupKey(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function recordSessionFile(params: {
  sessionId: string;
  sessionFile: string | undefined;
  sessionFileBySessionId: Map<string, string | undefined>;
}) {
  const key = params.sessionId.trim();
  if (!key) {
    return;
  }
  if (params.sessionFileBySessionId.has(key)) {
    return;
  }
  params.sessionFileBySessionId.set(key, params.sessionFile);
}

function includeForCriteria(params: {
  mode: SessionsDeleteCriteria["mode"];
  entry: SessionEntry | undefined;
  nowMs: number;
  olderThanMs?: number;
}): boolean {
  if (params.mode === "clear-all") {
    return true;
  }
  if (params.mode !== "clear-older-than" || params.olderThanMs == null) {
    return false;
  }
  return (
    typeof params.entry?.updatedAt === "number" &&
    params.entry.updatedAt < params.nowMs - params.olderThanMs
  );
}

function buildDeletionPlan(params: {
  store: Record<string, SessionEntry>;
  criteria: SessionsDeleteCriteria;
}): SessionDeletionPlan {
  const deletedKeys = new Set<string>();
  const deletedSessionIds = new Set<string>();
  const sessionFileBySessionId = new Map<string, string | undefined>();
  const nowMs =
    params.criteria.mode === "clear-older-than" ? params.criteria.nowMs : Date.now();

  const targetSessionIds = new Set<string>();
  if (params.criteria.mode === "rm") {
    const targetKey = normalizeLookupKey(params.criteria.key);
    for (const [sessionKey, entry] of Object.entries(params.store)) {
      if (normalizeLookupKey(sessionKey) === targetKey) {
        if (typeof entry?.sessionId === "string") {
          targetSessionIds.add(entry.sessionId);
        }
      }
    }
    if (targetSessionIds.size === 0) {
      return {
        beforeCount: Object.keys(params.store).length,
        deletedKeys: [],
        deletedSessionIds: [],
        sessionFileBySessionId,
      };
    }
    for (const [sessionKey, entry] of Object.entries(params.store)) {
      if (entry?.sessionId && targetSessionIds.has(entry.sessionId)) {
        deletedKeys.add(sessionKey);
        recordSessionFile({
          sessionId: entry.sessionId,
          sessionFile: entry.sessionFile,
          sessionFileBySessionId,
        });
      }
    }
  } else {
    const selectedSessionIds = new Set<string>();
    for (const [sessionKey, entry] of Object.entries(params.store)) {
      const shouldDelete = includeForCriteria({
        mode: params.criteria.mode,
        entry,
        olderThanMs:
          params.criteria.mode === "clear-older-than" ? params.criteria.olderThanMs : undefined,
        nowMs,
      });
      if (!shouldDelete) {
        continue;
      }
      deletedKeys.add(sessionKey);
      if (typeof entry?.sessionId === "string") {
        selectedSessionIds.add(entry.sessionId);
      }
      if (entry?.sessionId) {
        recordSessionFile({
          sessionId: entry.sessionId,
          sessionFile: entry.sessionFile,
          sessionFileBySessionId,
        });
      }
    }

    if (selectedSessionIds.size > 0) {
      for (const [sessionKey, entry] of Object.entries(params.store)) {
        if (!entry?.sessionId || !selectedSessionIds.has(entry.sessionId)) {
          continue;
        }
        deletedKeys.add(sessionKey);
      }
    }
  }

  for (const key of deletedKeys) {
    const entry = params.store[key];
    if (typeof entry?.sessionId === "string") {
      deletedSessionIds.add(entry.sessionId);
    }
  }

  return {
    beforeCount: Object.keys(params.store).length,
    deletedKeys: [...deletedKeys].toSorted(),
    deletedSessionIds: [...deletedSessionIds].toSorted(),
    sessionFileBySessionId,
  };
}

function formatSummary(params: {
  agentId: string;
  storePath: string;
  mode: SessionsDeleteCriteria["mode"];
  dryRun: boolean;
  plan: SessionDeletionPlan;
  applyResult?: DeletionApplyResult | null;
}): SessionsDeleteSummary {
  const applied = params.applyResult ?? null;
  const deletedKeys = applied?.deletedKeys?.length ? applied.deletedKeys : params.plan.deletedKeys;
  const deletedSessionIds = (
    applied?.archivedSessionIds && applied.archivedSessionIds.length > 0
      ? applied.archivedSessionIds
      : params.plan.deletedSessionIds
  ).toSorted();
  const deletedCount = applied?.deletedCount ?? deletedKeys.length;
  const afterCount = params.dryRun
    ? params.plan.beforeCount
    : Math.max(0, params.plan.beforeCount - deletedCount);

  return {
    agentId: params.agentId,
    storePath: params.storePath,
    mode: params.mode,
    dryRun: params.dryRun,
    beforeCount: params.plan.beforeCount,
    afterCount,
    deletedCount,
    deletedKeys,
    deletedSessionIds,
  };
}

function resolveOlderThanMs(raw: unknown): number {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) {
    throw new Error("--older-than requires a duration, for example 7d");
  }
  const ms = parseDurationMs(trimmed);
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new Error("--older-than must be a positive duration (for example 7d)");
  }
  return ms;
}

async function executeDeleteAcrossTargets(params: {
  targets: Array<{ agentId: string; storePath: string }>;
  criteria: SessionsDeleteCriteria;
  dryRun: boolean;
}): Promise<SessionsDeleteSummary[]> {
  const summaries: SessionsDeleteSummary[] = [];

  for (const target of params.targets) {
    const store = loadSessionStore(target.storePath);
    const plan = buildDeletionPlan({ store, criteria: params.criteria });

    if (params.dryRun) {
      summaries.push(
        formatSummary({
          agentId: target.agentId,
          storePath: target.storePath,
          mode: params.criteria.mode,
          dryRun: true,
          plan,
        }),
      );
      continue;
    }
    if (plan.deletedKeys.length === 0) {
      summaries.push(
        formatSummary({
          agentId: target.agentId,
          storePath: target.storePath,
          mode: params.criteria.mode,
          dryRun: false,
          plan,
        }),
      );
      continue;
    }

    const applyResult = await updateSessionStore(
      target.storePath,
      (mutableStore) => {
        const deletedKeys: string[] = [];
        const archivedSessionIds = new Set<string>();
        for (const sessionKey of plan.deletedKeys) {
          const entry = mutableStore[sessionKey];
          if (!entry) {
            continue;
          }
          delete mutableStore[sessionKey];
          deletedKeys.push(sessionKey);
          if (typeof entry.sessionId === "string") {
            archivedSessionIds.add(entry.sessionId);
          }
        }
        for (const sessionId of archivedSessionIds) {
          const sessionFile = plan.sessionFileBySessionId.get(sessionId);
          archiveSessionTranscripts({
            sessionId,
            storePath: target.storePath,
            sessionFile,
            reason: "deleted",
            restrictToStoreDir: true,
          });
        }
        return {
          deletedCount: deletedKeys.length,
          deletedKeys: deletedKeys.toSorted(),
          archivedSessionIds: [...archivedSessionIds],
        };
      },
      { skipMaintenance: true },
    );

    summaries.push(
      formatSummary({
        agentId: target.agentId,
        storePath: target.storePath,
        mode: params.criteria.mode,
        dryRun: false,
        plan,
        applyResult,
      }),
    );
  }

  return summaries;
}

function renderDeleteSummaries(
  summaries: SessionsDeleteSummary[],
  runtime: RuntimeEnv,
): void {
  for (const summary of summaries) {
    runtime.log(`Session store: ${summary.storePath}`);
    runtime.log(`${summary.dryRun ? "[dry-run] " : ""}Deleted sessions: ${summary.deletedCount}`);
    if (summary.deletedKeys.length === 0) {
      runtime.log("No sessions deleted.");
      continue;
    }
    for (const key of summary.deletedKeys) {
      runtime.log(`- ${key}`);
    }
  }
}

function resolveCriteria(opts: {
  all?: boolean;
  olderThan?: string;
}): SessionsDeleteCriteria {
  if (opts.all === true && opts.olderThan != null) {
    throw new Error("Use either --all or --older-than, not both.");
  }
  if (opts.all === true) {
    return { mode: "clear-all" };
  }
  if (opts.olderThan != null) {
    const olderThanMs = resolveOlderThanMs(opts.olderThan);
    return { mode: "clear-older-than", olderThanMs, nowMs: Date.now() };
  }
  throw new Error("Either --all or --older-than is required.");
}

type BaseSessionDeleteOptions = {
  store?: string;
  agent?: string;
  allAgents?: boolean;
  dryRun?: boolean;
  json?: boolean;
};

export type SessionsRmOptions = BaseSessionDeleteOptions & {
  key?: string;
};

export async function sessionsRmCommand(opts: SessionsRmOptions, runtime: RuntimeEnv): Promise<void> {
  const cfg = loadConfig();
  const targets = resolveSessionStoreTargetsOrExit({
    cfg,
    opts: {
      store: opts.store,
      agent: opts.agent,
      allAgents: opts.allAgents,
    },
    runtime,
  });
  if (!targets) {
    return;
  }

  if (!opts.key?.trim()) {
    runtime.error("Usage: openclaw sessions rm <key>");
    runtime.exit(1);
    return;
  }

  const summaries = await executeDeleteAcrossTargets({
    targets,
    criteria: { mode: "rm", key: opts.key },
    dryRun: Boolean(opts.dryRun),
  });
  const deletedAny = summaries.some((summary) => summary.deletedCount > 0);

  if (opts.json) {
    if (summaries.length === 1) {
      runtime.log(JSON.stringify(summaries[0], null, 2));
    } else {
      runtime.log(
        JSON.stringify(
          {
            allAgents: true,
            dryRun: Boolean(opts.dryRun),
            mode: "rm",
            stores: summaries,
          },
          null,
          2,
        ),
      );
    }
    if (!deletedAny && !opts.dryRun) {
      runtime.error(`Session key not found: "${opts.key}"`);
      runtime.exit(1);
    }
    return;
  }

  if (!deletedAny && !opts.dryRun) {
    runtime.error(`Session key not found: "${opts.key}"`);
    runtime.exit(1);
    return;
  }

  renderDeleteSummaries(summaries, runtime);
}

export type SessionsClearOptions = BaseSessionDeleteOptions & {
  all?: boolean;
  olderThan?: string;
};

export async function sessionsClearCommand(
  opts: SessionsClearOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  const cfg = loadConfig();
  const targets = resolveSessionStoreTargetsOrExit({
    cfg,
    opts: {
      store: opts.store,
      agent: opts.agent,
      allAgents: opts.allAgents,
    },
    runtime,
  });
  if (!targets) {
    return;
  }

  let criteria: SessionsDeleteCriteria;
  try {
    criteria = resolveCriteria({ all: opts.all, olderThan: opts.olderThan });
  } catch (error) {
    runtime.error(error instanceof Error ? error.message : String(error));
    runtime.exit(1);
    return;
  }

  const summaries = await executeDeleteAcrossTargets({
    targets,
    criteria,
    dryRun: Boolean(opts.dryRun),
  });

  if (opts.json) {
    if (summaries.length === 1) {
      runtime.log(JSON.stringify(summaries[0], null, 2));
      return;
    }
    runtime.log(
      JSON.stringify(
        {
          allAgents: true,
          dryRun: Boolean(opts.dryRun),
          mode: criteria.mode,
          stores: summaries,
        },
        null,
        2,
      ),
    );
    return;
  }

  renderDeleteSummaries(summaries, runtime);
}
