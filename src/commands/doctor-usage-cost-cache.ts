import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { note } from "../../packages/terminal-core/src/note.js";
import { resolveStateDir } from "../config/paths.js";
import { formatErrorMessage, hasErrnoCode } from "../infra/errors.js";
import { hasRetiredSessionCostUsageCacheEntriesInDatabase } from "../infra/session-cost-usage-cache.kernel.js";
import { retireLegacySessionCostUsageCache } from "../infra/session-cost-usage-cache.sqlite.js";
import { openUsageCostRefreshFailures } from "../infra/session-cost-usage-refresh-health.js";
import { readOnlyOpenWouldCreateSqliteSidecars } from "../infra/sqlite-files.js";
import { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import { listOpenClawRegisteredAgentDatabases } from "../state/openclaw-agent-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { shortenHomePath } from "../utils.js";
import { runDoctorAgentDatabaseOperationAsync } from "./doctor-agent-database-operation.js";
import {
  detectConfigAuditScrubIssue,
  maybeScrubConfigAuditLog,
} from "./doctor-config-audit-scrub.js";
import { decideDoctorPendingFromLiveStores } from "./doctor-live-store-pending.js";
import type { DoctorMaintenancePending } from "./doctor-maintenance-pending.js";

const LEGACY_USAGE_COST_TEMP_GRACE_MS = 10_000;
const LEGACY_USAGE_COST_TEMP_PATTERNS = [
  /^\.usage-cost-cache\.\d+\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/u,
  /^\.usage-cost-cache(?:\.json)?\.\d+\.tmp$/u,
  /^\.usage-cost-cache\.json\.lock\.\d+(?:\.\d+)?\.tmp$/u,
];

async function readFilesystemEntryOrMissing<T>(
  filePath: string,
  read: () => Promise<T>,
): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return null;
    }
    throw new Error(`${shortenHomePath(filePath)}: ${formatErrorMessage(error)}`, {
      cause: error,
    });
  }
}

async function detectLegacyUsageCostCacheFiles(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const stateDir = resolveStateDir(env, os.homedir);
  const sessionDirs = [path.join(stateDir, "sessions")];
  const agentsDir = path.join(stateDir, "agents");
  const agentEntries =
    (await readFilesystemEntryOrMissing(agentsDir, () =>
      fs.readdir(agentsDir, { withFileTypes: true }),
    )) ?? [];
  for (const entry of agentEntries) {
    if (entry.isDirectory()) {
      sessionDirs.push(path.join(agentsDir, entry.name, "sessions"));
    }
  }
  const files: string[] = [];
  for (const sessionDir of sessionDirs) {
    const entries =
      (await readFilesystemEntryOrMissing(sessionDir, () =>
        fs.readdir(sessionDir, { withFileTypes: true }),
      )) ?? [];
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
      const filePath = path.join(sessionDir, entry.name);
      if (entry.name === ".usage-cost-cache.json" || entry.name === ".usage-cost-cache.json.lock") {
        files.push(filePath);
        continue;
      }
      if (LEGACY_USAGE_COST_TEMP_PATTERNS.some((pattern) => pattern.test(entry.name))) {
        const stats = await readFilesystemEntryOrMissing(filePath, () => fs.stat(filePath));
        if (stats && Date.now() - stats.mtimeMs >= LEGACY_USAGE_COST_TEMP_GRACE_MS) {
          files.push(filePath);
        }
      }
    }
  }
  return files.toSorted();
}

async function maybeRemoveLegacyUsageCostCacheFiles(params: {
  shouldRepair: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const files = await detectLegacyUsageCostCacheFiles(params.env).catch((error: unknown) => {
    const command = params.shouldRepair ? "openclaw doctor --fix" : "openclaw doctor";
    const action = params.shouldRepair ? "scan and cleanup" : "scan";
    note(
      [
        `Legacy usage-cost cache ${action} could not be completed; ${params.shouldRepair ? "no sidecar files were removed" : "cache state may remain uninspected"}.`,
        `- ${formatErrorMessage(error)}`,
        `Resolve the filesystem error and rerun \`${command}\`.`,
      ].join("\n"),
      "Usage cost cache",
    );
    return null;
  });
  if (!files?.length) {
    return;
  }
  if (!params.shouldRepair) {
    note(
      `${files.length} rebuildable usage-cost cache ${files.length === 1 ? "file remains" : "files remain"}. Run \`openclaw doctor --fix\` to remove ${files.length === 1 ? "it" : "them"}.`,
      "Usage cost cache",
    );
    return;
  }
  const failures: string[] = [];
  for (const filePath of files) {
    await fs.rm(filePath, { force: true }).catch((error: unknown) => {
      failures.push(`${filePath}: ${String(error)}`);
    });
  }
  if (failures.length > 0) {
    note(
      `Failed removing legacy usage-cost cache files:\n${failures.join("\n")}`,
      "Usage cost cache",
    );
    return;
  }
  note(
    `Removed ${files.length} rebuildable legacy usage-cost cache ${files.length === 1 ? "file" : "files"}; SQLite rebuilds the cache on demand.`,
    "Usage cost cache",
  );
}

const resolveLegacySkillUploadRoot = (env: NodeJS.ProcessEnv = process.env) =>
  path.join(resolveStateDir(env, os.homedir), "tmp", "skill-uploads");

// Installs from 2026.8 kept prior Control UI builds here; reload recovery replaced them.
const resolveObsoleteControlUiAssetCache = (env: NodeJS.ProcessEnv = process.env) =>
  path.join(resolveStateDir(env, os.homedir), "cache", "control-ui-assets");

async function maybeRemoveLegacySkillUploadTree(params: {
  shouldRepair: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const uploadRoot = resolveLegacySkillUploadRoot(params.env);
  try {
    await fs.lstat(uploadRoot);
    if (!params.shouldRepair) {
      note(
        "Legacy skill-upload staging remains. Run `openclaw doctor --fix` to discard it; active uploads now live in SQLite and must be retried.",
        "Skill uploads",
      );
      return;
    }
    await fs.rm(uploadRoot, { recursive: true, force: true });
  } catch (error) {
    if (!hasErrnoCode(error, "ENOENT")) {
      note(
        `Failed ${params.shouldRepair ? "removing" : "inspecting"} legacy skill-upload staging: ${String(error)}`,
        "Skill uploads",
      );
    }
    return;
  }
  note(
    "Removed legacy skill-upload staging; unfinished transient uploads must be retried.",
    "Skill uploads",
  );
}

async function maybeRemoveObsoleteControlUiAssetCache(params: {
  shouldRepair: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<string[]> {
  const cacheRoot = resolveObsoleteControlUiAssetCache(params.env);
  try {
    await fs.lstat(cacheRoot);
    if (!params.shouldRepair) {
      note(
        `Obsolete Control UI asset cache remains at ${shortenHomePath(cacheRoot)}. Run \`openclaw doctor --fix\` to remove it.`,
        "Control UI assets",
      );
      return [];
    }
    await fs.rm(cacheRoot, { recursive: true, force: true });
    note(
      `Removed obsolete Control UI asset cache at ${shortenHomePath(cacheRoot)}.`,
      "Control UI assets",
    );
  } catch (error) {
    if (!hasErrnoCode(error, "ENOENT")) {
      const warning = `Could not ${params.shouldRepair ? "remove" : "inspect"} obsolete Control UI asset cache at ${shortenHomePath(cacheRoot)}: ${formatErrorMessage(error)}. Resolve the filesystem error and rerun \`openclaw doctor --fix\`.`;
      note(warning, "Doctor warnings");
      return [warning];
    }
  }
  return [];
}

/**
 * Read-only: whether `retireLegacySessionCostUsageCache` would delete a row in this existing
 * database file. One without the agent schema is work, so the retire path keeps owning it. A
 * file the reader will not open (an incognito path, or one fenced while its agent is deleted)
 * is undecidable here, so the retire path still runs for it.
 */
function inspectRetiredSessionCostUsageCacheEntries(
  entry: { agentId: string; path: string },
  env?: NodeJS.ProcessEnv,
): DoctorMaintenancePending {
  const inspected = withOpenClawAgentDatabaseReadOnly(
    ({ db }) => hasRetiredSessionCostUsageCacheEntriesInDatabase(db),
    { agentId: entry.agentId, env, path: entry.path },
  );
  if (inspected.found) {
    return inspected.value ? "work" : "none";
  }
  return inspected.reason === "schema-missing" ? "work" : "undecidable";
}

function retiredUsageCacheEntriesMayExist(
  entry: { agentId: string; path: string },
  env?: NodeJS.ProcessEnv,
): boolean {
  try {
    // A database no connection holds open goes straight to the retire path: its write
    // connection removes the sidecars on close, which a read-only open would leave behind.
    return (
      readOnlyOpenWouldCreateSqliteSidecars(entry.path) ||
      inspectRetiredSessionCostUsageCacheEntries(entry, env) !== "none"
    );
  } catch {
    // The retire path reports an unreadable database.
    return true;
  }
}

/**
 * Read-only: whether `maybeRepairLegacyRuntimeFiles(true)` would change anything. It reuses each
 * cleanup's own detection; refresh-failure history is only reported.
 */
export async function checkLegacyRuntimeFilesPending(
  env?: NodeJS.ProcessEnv,
): Promise<DoctorMaintenancePending> {
  if ((await detectConfigAuditScrubIssue({ env })).rewritten > 0) {
    return "work";
  }
  if ((await detectLegacyUsageCostCacheFiles(env)).length > 0) {
    return "work";
  }
  const retired = await decideDoctorPendingFromLiveStores(
    [resolveOpenClawStateSqlitePath(env)],
    async () => {
      for (const entry of listOpenClawRegisteredAgentDatabases({ env })) {
        const stats = await readFilesystemEntryOrMissing(entry.path, () => fs.stat(entry.path));
        const pending = stats?.isFile()
          ? await decideDoctorPendingFromLiveStores([entry.path], () =>
              inspectRetiredSessionCostUsageCacheEntries(entry, env),
            )
          : "none";
        if (pending !== "none") {
          return pending;
        }
      }
      return "none";
    },
  );
  if (retired !== "none") {
    return retired;
  }
  for (const root of [resolveLegacySkillUploadRoot(env), resolveObsoleteControlUiAssetCache(env)]) {
    if (await readFilesystemEntryOrMissing(root, () => fs.lstat(root))) {
      return "work";
    }
  }
  return "none";
}

export async function maybeRepairLegacyRuntimeFiles(
  shouldRepair: boolean,
  env?: NodeJS.ProcessEnv,
): Promise<string[]> {
  const failures = await openUsageCostRefreshFailures(env)
    .entries()
    .catch((error: unknown) => {
      note(
        `Could not read usage refresh failure history: ${formatErrorMessage(error)}`,
        "Usage cost cache",
      );
      return [];
    });
  if (failures.length > 0) {
    note(
      failures
        .map(({ value }) => `- ${value.agentId}: ${value.sessionFile}: ${value.reason}`)
        .join("\n"),
      "Usage cost cache",
    );
  }
  await maybeScrubConfigAuditLog({ shouldRepair, env });
  await maybeRemoveLegacyUsageCostCacheFiles({ shouldRepair, env });
  if (shouldRepair) {
    for (const entry of listOpenClawRegisteredAgentDatabases({ env })) {
      await runDoctorAgentDatabaseOperationAsync({
        agentId: entry.agentId,
        path: entry.path,
        run: async () => {
          const stats = await readFilesystemEntryOrMissing(entry.path, () => fs.stat(entry.path));
          // Read first: a clean database needs no write transaction.
          if (stats?.isFile() && retiredUsageCacheEntriesMayExist(entry, env)) {
            await retireLegacySessionCostUsageCache({
              agentId: entry.agentId,
              env,
              databasePath: entry.path,
            });
          }
        },
      });
    }
  }
  await maybeRemoveLegacySkillUploadTree({ shouldRepair, env });
  return await maybeRemoveObsoleteControlUiAssetCache({ shouldRepair, env });
}
