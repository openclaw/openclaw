import fs from "node:fs";
import { loadConfig } from "../config/config.js";
import {
  loadSessionStore,
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
  updateSessionStore,
  type SessionEntry,
} from "../config/sessions.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveSessionStoreTargetsOrExit } from "./session-store-targets.js";

type SessionMutationBaseOptions = {
  store?: string;
  agent?: string;
  allAgents?: boolean;
  dryRun?: boolean;
  json?: boolean;
};

export type SessionsRemoveOptions = SessionMutationBaseOptions & {
  key: string;
};

export type SessionsClearOptions = SessionMutationBaseOptions & {
  olderThan?: string;
};

type SessionDeletionResult = {
  key: string;
  entry: SessionEntry;
};

type SessionDeletionStoreSummary = {
  agentId: string;
  storePath: string;
  beforeCount: number;
  afterCount: number;
  removedKeys: string[];
  removedTranscripts: string[];
  dryRun: boolean;
};

function normalizeSessionKey(input: string): string {
  return input.trim().toLowerCase();
}

function parseOlderThanMinutes(value: string | undefined, runtime: RuntimeEnv): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    runtime.error("--older-than must be a positive integer (minutes)");
    runtime.exit(1);
    return undefined;
  }
  return parsed;
}

function collectRemovalsByPredicate(
  store: Record<string, SessionEntry>,
  shouldDelete: (params: { key: string; entry: SessionEntry }) => boolean,
): SessionDeletionResult[] {
  const removals: SessionDeletionResult[] = [];
  for (const [key, entry] of Object.entries(store)) {
    if (!entry || !shouldDelete({ key, entry })) {
      continue;
    }
    removals.push({ key, entry });
    delete store[key];
  }
  return removals;
}

async function removeTranscriptFiles(params: {
  removals: SessionDeletionResult[];
  remainingStore: Record<string, SessionEntry>;
  storePath: string;
  agentId: string;
}): Promise<string[]> {
  const remainingSessionIds = new Set(
    Object.values(params.remainingStore)
      .map((entry) => entry?.sessionId)
      .filter((sessionId): sessionId is string => Boolean(sessionId)),
  );
  const pathOpts = resolveSessionFilePathOptions({
    storePath: params.storePath,
    agentId: params.agentId,
  });
  const removedPaths: string[] = [];
  for (const { entry } of params.removals) {
    if (!entry.sessionId || remainingSessionIds.has(entry.sessionId)) {
      continue;
    }
    const transcriptPath = resolveSessionFilePath(entry.sessionId, entry, pathOpts);
    await fs.promises.rm(transcriptPath, { force: true }).catch(() => undefined);
    removedPaths.push(transcriptPath);
  }
  return removedPaths;
}

async function deleteSessionsByPredicate(params: {
  runtime: RuntimeEnv;
  opts: SessionMutationBaseOptions;
  shouldDelete: (args: { key: string; entry: SessionEntry; nowMs: number }) => boolean;
}): Promise<SessionDeletionStoreSummary[] | null> {
  const cfg = loadConfig();
  const targets = resolveSessionStoreTargetsOrExit({
    cfg,
    opts: {
      store: params.opts.store,
      agent: params.opts.agent,
      allAgents: params.opts.allAgents,
    },
    runtime: params.runtime,
  });
  if (!targets) {
    return null;
  }

  const nowMs = Date.now();
  const summaries: SessionDeletionStoreSummary[] = [];

  for (const target of targets) {
    if (params.opts.dryRun) {
      const store = loadSessionStore(target.storePath, { skipCache: true });
      const beforeCount = Object.keys(store).length;
      const removals = collectRemovalsByPredicate(structuredClone(store), ({ key, entry }) =>
        params.shouldDelete({ key, entry, nowMs }),
      );
      summaries.push({
        agentId: target.agentId,
        storePath: target.storePath,
        beforeCount,
        afterCount: beforeCount - removals.length,
        removedKeys: removals.map((row) => row.key),
        removedTranscripts: [],
        dryRun: true,
      });
      continue;
    }

    const mutationResult = await updateSessionStore(target.storePath, (store) => {
      const beforeCount = Object.keys(store).length;
      const removals = collectRemovalsByPredicate(store, ({ key, entry }) =>
        params.shouldDelete({ key, entry, nowMs }),
      );
      return {
        beforeCount,
        afterCount: Object.keys(store).length,
        removals,
        remainingStore: structuredClone(store),
      };
    });

    const removedTranscripts = await removeTranscriptFiles({
      removals: mutationResult.removals,
      remainingStore: mutationResult.remainingStore,
      storePath: target.storePath,
      agentId: target.agentId,
    });

    summaries.push({
      agentId: target.agentId,
      storePath: target.storePath,
      beforeCount: mutationResult.beforeCount,
      afterCount: mutationResult.afterCount,
      removedKeys: mutationResult.removals.map((row) => row.key),
      removedTranscripts,
      dryRun: false,
    });
  }

  return summaries;
}

function totalRemovedCount(summaries: SessionDeletionStoreSummary[]): number {
  return summaries.reduce((sum, row) => sum + row.removedKeys.length, 0);
}

function renderTextSummary(params: {
  runtime: RuntimeEnv;
  label: string;
  summaries: SessionDeletionStoreSummary[];
}): void {
  const stores = params.summaries.length;
  const removed = totalRemovedCount(params.summaries);
  params.runtime.log(`${params.label}: removed ${removed} session(s) across ${stores} store(s).`);
  for (const summary of params.summaries) {
    const deleted = summary.removedKeys.length;
    const transcriptCount = summary.removedTranscripts.length;
    params.runtime.log(
      `- ${summary.agentId}: ${summary.beforeCount} -> ${summary.afterCount} (removed ${deleted}, transcripts ${transcriptCount})`,
    );
  }
}

function renderJsonSummary(params: {
  runtime: RuntimeEnv;
  action: "rm" | "clear";
  summaries: SessionDeletionStoreSummary[];
  dryRun?: boolean;
  key?: string;
  olderThanMinutes?: number;
}): void {
  params.runtime.log(
    JSON.stringify(
      {
        action: params.action,
        dryRun: Boolean(params.dryRun),
        key: params.key,
        olderThanMinutes: params.olderThanMinutes ?? null,
        removed: totalRemovedCount(params.summaries),
        stores: params.summaries,
      },
      null,
      2,
    ),
  );
}

export async function sessionsRemoveCommand(opts: SessionsRemoveOptions, runtime: RuntimeEnv) {
  const key = opts.key?.trim();
  if (!key) {
    runtime.error("Session key is required");
    runtime.exit(1);
    return;
  }
  const normalized = normalizeSessionKey(key);
  const summaries = await deleteSessionsByPredicate({
    runtime,
    opts,
    shouldDelete: ({ key: candidateKey }) => normalizeSessionKey(candidateKey) === normalized,
  });
  if (!summaries) {
    return;
  }

  const removed = totalRemovedCount(summaries);
  if (removed === 0) {
    runtime.error(`No matching session found for key: ${key}`);
    runtime.exit(1);
    return;
  }

  if (opts.json) {
    renderJsonSummary({
      runtime,
      action: "rm",
      key,
      dryRun: opts.dryRun,
      summaries,
    });
    return;
  }
  renderTextSummary({
    runtime,
    label: opts.dryRun ? "Dry-run session remove" : "Session remove",
    summaries,
  });
}

export async function sessionsClearCommand(opts: SessionsClearOptions, runtime: RuntimeEnv) {
  const olderThanMinutes = parseOlderThanMinutes(opts.olderThan, runtime);
  if (opts.olderThan !== undefined && olderThanMinutes === undefined) {
    return;
  }
  const olderThanMs = olderThanMinutes ? olderThanMinutes * 60_000 : undefined;

  const summaries = await deleteSessionsByPredicate({
    runtime,
    opts,
    shouldDelete: ({ entry, nowMs }) => {
      if (olderThanMs === undefined) {
        return true;
      }
      if (!entry.updatedAt) {
        return false;
      }
      return nowMs - entry.updatedAt >= olderThanMs;
    },
  });
  if (!summaries) {
    return;
  }

  if (opts.json) {
    renderJsonSummary({
      runtime,
      action: "clear",
      dryRun: opts.dryRun,
      olderThanMinutes,
      summaries,
    });
    return;
  }
  renderTextSummary({
    runtime,
    label: opts.dryRun ? "Dry-run session clear" : "Session clear",
    summaries,
  });
}
