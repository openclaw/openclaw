import fs from "node:fs";
import path from "node:path";
import { listAgentIds } from "../agents/agent-scope-config.js";
import {
  parseSqliteTargetSuffixIndex,
  resolveUnsuffixedSqliteTargetFromSessionStorePath,
} from "../config/sessions/session-sqlite-target-paths.js";
import {
  listDurableSqliteTargetOwnersForSessionStorePath,
  resolveSqliteTargetFromSessionStorePath,
} from "../config/sessions/session-sqlite-target.js";
import {
  resolveConfiguredAgentDatabaseTargets,
  resolveSessionStoreCompatibilityAgentId,
} from "../config/sessions/targets.js";
import { resolveStateDir } from "../config/state-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveRequiredHomeDir } from "../infra/home-dir.js";
import type { LegacyStateMigrationMode } from "../infra/state-migrations.types.js";
import {
  isUpdateRehearsalReadOnlyPath,
  resolveUpdateRehearsalRoot,
} from "../infra/update-rehearsal-paths.js";

/** Preflight inspects custom stores without binding their migration owners. */
export function resolveDoctorAgentMigrationTargets(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  options: {
    registeredDatabases: readonly { agentId: string; path: string }[];
    mode: LegacyStateMigrationMode;
    skipConfigured: boolean;
  },
) {
  const targets = options.skipConfigured
    ? []
    : resolveConfiguredAgentDatabaseTargets(cfg, {
        env,
        registeredDatabases: options.registeredDatabases,
      });
  if (options.mode === "doctor") {
    targets.push(
      ...resolveRelativeSessionStoreMigrationTargets(cfg, env, options.registeredDatabases).filter(
        (target) => !isUpdateRehearsalReadOnlyPath(target.path, env),
      ),
    );
  }
  return targets;
}

/** Match recorded old working directories without searching unrelated filesystem roots. */
function registeredRelativeStoreBase(
  databasePath: string,
  relativeDatabase: string,
  agentId: string,
  suffixed: boolean,
): string | undefined {
  const segments = relativeDatabase.split(path.sep);
  let parents = 0;
  while (segments[0] === "..") {
    segments.shift();
    parents++;
  }
  const filename = segments.pop();
  if (!filename) {
    return undefined;
  }
  const actual = path.basename(databasePath);
  if (
    actual !== filename &&
    (!suffixed ||
      parseSqliteTargetSuffixIndex(actual, `${path.basename(filename, ".sqlite")}.${agentId}`) ===
        undefined)
  ) {
    return undefined;
  }
  const tail = path.join(...segments, actual);
  if (!databasePath.endsWith(`${path.sep}${tail}`)) {
    return undefined;
  }
  const root = databasePath.slice(0, -tail.length);
  // Only the canceled parent count matters; these placeholders are never accessed.
  return path.join(root, ...Array<string>(parents).fill(".old-session-cwd"));
}

/** Doctor retains these prior selectors through schema repair, backup, and the final merge. */
export function resolveRelativeSessionStoreMigrationTargets(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  registered: readonly { agentId: string; path: string }[],
) {
  const store = cfg.session?.store;
  const targets: Array<{
    agentId: string;
    configuredAgentId: string;
    path: string;
    storePath: string;
  }> = [];
  if (!store || store.startsWith("~") || path.isAbsolute(store)) {
    return targets;
  }
  const probeRoot = path.join(resolveStateDir(env), ".relative-session-store-probe");
  const owners = new Set([...listAgentIds(cfg), ...registered.map((row) => row.agentId)]);
  for (const configuredAgentId of owners) {
    const expanded = store.replaceAll("{agentId}", configuredAgentId);
    const probe = resolveUnsuffixedSqliteTargetFromSessionStorePath(
      path.resolve(probeRoot, expanded),
    );
    for (const row of registered) {
      if (!probe.shared && row.agentId !== configuredAgentId) {
        continue;
      }
      const base = registeredRelativeStoreBase(
        row.path,
        path.relative(probeRoot, probe.path),
        row.agentId,
        !probe.agentId && !probe.shared,
      );
      if (base !== undefined) {
        targets.push({ ...row, configuredAgentId, storePath: path.resolve(base, expanded) });
      }
    }
  }
  // Probe only the old local selectors and their bounded durable sibling families.
  // Header ownership, not the current roster, identifies retired physical owners.
  if (!resolveUpdateRehearsalRoot(env)) {
    const defaultAgentId = resolveSessionStoreCompatibilityAgentId(cfg);
    for (const base of new Set([process.cwd(), resolveRequiredHomeDir(env)])) {
      for (const configuredAgentId of owners) {
        const storePath = path.resolve(base, store.replaceAll("{agentId}", configuredAgentId));
        const durableOwners = new Set([
          configuredAgentId,
          ...listDurableSqliteTargetOwnersForSessionStorePath(storePath),
        ]);
        for (const owner of durableOwners) {
          const selected = resolveSqliteTargetFromSessionStorePath(storePath, {
            agentId: owner,
            defaultAgentId,
            env,
            registeredDatabases: registered,
          });
          if (fs.existsSync(selected.path)) {
            targets.push({
              agentId: selected.agentId ?? owner,
              configuredAgentId: owner,
              path: selected.path,
              storePath,
            });
          }
        }
      }
    }
  }
  return targets;
}
