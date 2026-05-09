import fs from "node:fs";
import path from "node:path";
import {
  normalizeSubagentRunRecordsForMigration,
  resolveSubagentStateDir,
  writeSubagentRegistryRunsForMigration,
} from "../../../agents/subagent-registry.store.js";
import type { SubagentRunRecord } from "../../../agents/subagent-registry.types.js";
import { loadJsonFile } from "../../../infra/json-file.js";

type LegacySubagentRunRecord = SubagentRunRecord & {
  announceCompletedAt?: unknown;
  announceHandled?: unknown;
  requesterChannel?: unknown;
  requesterAccountId?: unknown;
};

type PersistedSubagentRegistryV1 = {
  version: 1;
  runs: Record<string, LegacySubagentRunRecord>;
};

type PersistedSubagentRegistryV2 = {
  version: 2;
  runs: Record<string, SubagentRunRecord>;
};

type PersistedSubagentRegistry = PersistedSubagentRegistryV1 | PersistedSubagentRegistryV2;

export function resolveLegacySubagentRegistryPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveSubagentStateDir(env), "subagents", "runs.json");
}

function loadLegacySubagentRegistryFile(pathname: string): Map<string, SubagentRunRecord> {
  const raw = loadJsonFile(pathname);
  if (!raw || typeof raw !== "object") {
    return new Map();
  }
  const record = raw as Partial<PersistedSubagentRegistry>;
  if (record.version !== 1 && record.version !== 2) {
    return new Map();
  }
  const runsRaw = record.runs;
  if (!runsRaw || typeof runsRaw !== "object") {
    return new Map();
  }
  return normalizeSubagentRunRecordsForMigration({
    runsRaw: runsRaw as Record<string, unknown>,
    isLegacy: record.version === 1,
  });
}

export function legacySubagentRegistryFileExists(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    return fs.statSync(resolveLegacySubagentRegistryPath(env)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export function importLegacySubagentRegistryFileToSqlite(env: NodeJS.ProcessEnv = process.env): {
  imported: boolean;
  runs: number;
} {
  const pathname = resolveLegacySubagentRegistryPath(env);
  if (!legacySubagentRegistryFileExists(env)) {
    return { imported: false, runs: 0 };
  }
  const runs = loadLegacySubagentRegistryFile(pathname);
  writeSubagentRegistryRunsForMigration(runs, env);
  try {
    fs.unlinkSync(pathname);
  } catch {
    // Import succeeded; a later doctor pass can remove the stale file.
  }
  return { imported: true, runs: runs.size };
}
