import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveInstallAgentDir } from "../agents/install-agent-dir.js";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readExistingAgentSchemaMeta } from "../state/openclaw-agent-db-schema-helpers.js";
import { readDeferredPluginMigrations } from "./deferred-plugin-migrations.js";
import { preserveDeferredPluginSessionSource } from "./deferred-plugin-session-sources.js";
import { isErrno } from "./errors.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { isPathInside } from "./path-guards.js";
import { resolveSqliteDatabaseFilePaths, SQLITE_SIDECAR_SUFFIXES } from "./sqlite-files.js";
import { quoteSqliteIdentifier } from "./sqlite-schema-sql.js";
import {
  LEGACY_AGENT_DIR_RECEIPT,
  recordCompletedLegacyAgentDirMigration,
} from "./state-migrations.agent-dir-receipt.js";
import {
  migrationFileExists,
  readSessionStoreJson5,
  type SessionEntryLike,
} from "./state-migrations.fs.js";
import {
  aliasedSessionStoreMigrationWarning,
  canonicalizeSessionStore,
  distinctSessionStoreAliasWarning,
  isAmbiguousSharedStoreKey,
  normalizeSessionEntry,
  removeDirIfEmpty,
  saveSessionStoreStrict,
  unresolvedSessionStoreIdentityWarning,
} from "./state-migrations.session-store.js";
import {
  isLegacyDefaultMainAliasKey,
  type PreparedLegacySessionSurfaces,
} from "./state-migrations.session-surfaces.js";
import type { LegacyStateDetection, MigrationMessages } from "./state-migrations.types.js";

const LEGACY_AGENT_DATABASE_BASENAME = "openclaw-agent.sqlite";

function legacyAgentInspectionFailure(subject: string, error: unknown) {
  return { status: "failed", warning: `Failed inspecting ${subject}: ${String(error)}` } as const;
}

export function inspectLegacyAgentDir(
  legacyDir: string,
): { status: "empty" | "payload" } | { status: "failed"; warning: string } {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(legacyDir, { withFileTypes: true });
  } catch (error) {
    if (isErrno(error) && error.code === "ENOENT") {
      return { status: "empty" };
    }
    return legacyAgentInspectionFailure(`legacy agent directory ${legacyDir}`, error);
  }
  if (entries.length === 0) {
    return { status: "empty" };
  }

  const databasePath = path.join(legacyDir, LEGACY_AGENT_DATABASE_BASENAME);
  const databaseFiles = new Set(
    resolveSqliteDatabaseFilePaths(databasePath).map((pathname) => path.basename(pathname)),
  );
  const hasFilePayload = entries.some((entry) => !databaseFiles.has(entry.name));
  const hasDatabaseFiles = entries.some((entry) => databaseFiles.has(entry.name));
  if (!hasDatabaseFiles) {
    return { status: hasFilePayload ? "payload" : "empty" };
  }
  if (!migrationFileExists(databasePath)) {
    return legacyAgentInspectionFailure(
      `legacy agent database ${databasePath}`,
      "main database is missing or not a regular file",
    );
  }

  let database: ReturnType<typeof openNodeSqliteDatabase> | undefined;
  try {
    const opened = openNodeSqliteDatabase(databasePath, { readOnly: true });
    database = opened;
    const schemaOwner = readExistingAgentSchemaMeta(opened);
    if (!schemaOwner || schemaOwner.role !== "agent") {
      return legacyAgentInspectionFailure(
        `legacy agent database ${databasePath}`,
        "agent schema ownership metadata is missing",
      );
    }
    if (!schemaOwner.agentId) {
      return legacyAgentInspectionFailure(
        `legacy agent database ${databasePath}`,
        "agent schema owner is missing or blank",
      );
    }
    const tableNames = opened // sqlite-allow-raw -- Read-only legacy migration payload inspection.
      .prepare(
        // The excluded singleton rows are seeded schema controls, not user payload.
        `SELECT name FROM pragma_table_list
         WHERE schema = 'main' AND type IN ('table', 'virtual')
           AND substr(name, 1, 7) <> 'sqlite_'
           AND name NOT IN ('schema_meta', 'session_key_contract', 'memory_index_state')`,
      )
      .all()
      .flatMap((row) =>
        row && typeof row === "object" && "name" in row && typeof row.name === "string"
          ? [row.name]
          : [],
      );
    const hasPayload = tableNames.some((name) =>
      opened // sqlite-allow-raw -- pragma-owned names stay quoted inside this bounded probe.
        .prepare(`SELECT 1 FROM ${quoteSqliteIdentifier(name)} LIMIT 1`)
        .get(),
    );
    return { status: hasPayload || hasFilePayload ? "payload" : "empty" };
  } catch (error) {
    return legacyAgentInspectionFailure(`legacy agent database ${databasePath}`, error);
  } finally {
    database?.close();
  }
}

function normalizeTargetSessionStore(target: Record<string, SessionEntryLike>): {
  store: Record<string, SessionEntry>;
  rejectedProtectedKeyCount: number;
} {
  const store = Object.create(null) as Record<string, SessionEntry>;
  let rejectedProtectedKeyCount = 0;
  for (const [key, entry] of Object.entries(target)) {
    const normalizedEntry = normalizeSessionEntry(entry, key);
    if (!normalizedEntry) {
      rejectedProtectedKeyCount++;
      continue;
    }
    store[key] = normalizedEntry;
  }
  return { store, rejectedProtectedKeyCount };
}

export async function migrateLegacySessions(
  detected: LegacyStateDetection,
  options: {
    cfg: OpenClawConfig;
    env: NodeJS.ProcessEnv;
    legacySessionSurfaces: PreparedLegacySessionSurfaces;
  },
): Promise<MigrationMessages> {
  const changes: string[] = [];
  const warnings: string[] = [];
  if (!detected.sessions.hasLegacy) {
    return { changes, warnings };
  }
  if (options.legacySessionSurfaces.failures.length > 0) {
    return { changes, warnings: [...options.legacySessionSurfaces.failures] };
  }
  const env = { ...options.env, OPENCLAW_STATE_DIR: detected.stateDir };
  if (
    preserveDeferredPluginSessionSource({
      cfg: options.cfg,
      env,
      target: { agentId: detected.targetAgentId, storePath: detected.sessions.targetStorePath },
      pending: readDeferredPluginMigrations({ env }),
    })
  ) {
    return {
      changes,
      warnings,
      notices: [
        "Preserved legacy session sources for pending plugin migration or verified import archival; Doctor still imports and verifies canonical sessions.",
      ],
    };
  }
  const targetParsed = migrationFileExists(detected.sessions.targetStorePath)
    ? readSessionStoreJson5(detected.sessions.targetStorePath)
    : { store: {}, ok: true };
  if (!targetParsed.ok) {
    return {
      changes,
      warnings: [
        `Target sessions store unreadable; left untouched at ${detected.sessions.targetStorePath}. Repair the index, then rerun openclaw doctor --fix.`,
      ],
    };
  }
  const targetStore = targetParsed.store;
  if (detected.sessions.targetStoreAliases.hasUnresolvedIdentity) {
    warnings.push(
      unresolvedSessionStoreIdentityWarning(
        "legacy session migration",
        detected.sessions.targetStorePath,
      ),
    );
    return { changes, warnings };
  }
  if (detected.sessions.targetStoreAliases.hasFinalSymlink) {
    warnings.push(
      `Deferred legacy session migration in final-component symlink store ${detected.sessions.targetStorePath}; configure one canonical session.store path, then rerun openclaw doctor --fix`,
    );
    return { changes, warnings };
  }

  const ambiguousAliasedKeys = Object.keys(targetStore).filter(
    (key) =>
      isAmbiguousSharedStoreKey(key, detected.targetMainKey, detected.targetScope) ||
      (detected.sessions.preserveForeignMainAliases &&
        isLegacyDefaultMainAliasKey(key, detected.targetMainKey)),
  );
  if (detected.sessions.targetStoreAliases.hasDistinctAliases) {
    warnings.push(
      ambiguousAliasedKeys.length > 0
        ? aliasedSessionStoreMigrationWarning({
            subject: "migration of",
            count: ambiguousAliasedKeys.length,
            storePath: detected.sessions.targetStorePath,
          })
        : distinctSessionStoreAliasWarning(
            "legacy session migration",
            detected.sessions.targetStorePath,
          ),
    );
    return { changes, warnings };
  }

  const canonicalized = canonicalizeSessionStore({
    store: targetStore,
    agentId: detected.targetAgentId,
    mainKey: detected.targetMainKey,
    scope: detected.targetScope,
    preserveAmbiguousKeys: detected.sessions.preserveAmbiguousKeys,
    preserveForeignMainAliases: detected.sessions.preserveForeignMainAliases,
    legacySessionSurfaces: options.legacySessionSurfaces.surfaces,
  });
  const normalized = normalizeTargetSessionStore(canonicalized.store);
  if (normalized.rejectedProtectedKeyCount > 0) {
    warnings.push(
      `Refused legacy session migration because normalization rejected ${normalized.rejectedProtectedKeyCount} existing target session ${normalized.rejectedProtectedKeyCount === 1 ? "key" : "keys"}; left ${detected.sessions.targetStorePath} in place. Repair the conflicting rows, then rerun openclaw doctor --fix.`,
    );
    return { changes, warnings };
  }
  if (Object.keys(targetStore).length > 0) {
    await saveSessionStoreStrict(detected.sessions.targetStorePath, normalized.store);
    if (canonicalized.legacyKeys.length > 0) {
      changes.push(`Canonicalized ${canonicalized.legacyKeys.length} legacy session key(s)`);
    }
  }
  return { changes, warnings };
}

type SqliteFamilyPlan = {
  kind: "sqlite";
  relative: string;
  files: string[];
};
type AgentDirEntryPlan =
  | SqliteFamilyPlan
  | { kind: "file"; relative: string }
  | {
      kind: "directory";
      relative: string;
      entries: AgentDirEntryPlan[];
      families: SqliteFamilyPlan[];
    };

function planLegacyAgentDir(sourceRoot: string, targetRoot: string) {
  const families: SqliteFamilyPlan[] = [];
  function plan(relative: string, blocked: boolean): AgentDirEntryPlan[] {
    const source = path.join(sourceRoot, relative);
    const target = path.join(targetRoot, relative);
    const entries = fs.readdirSync(source, { withFileTypes: true });
    const targetStat = blocked ? undefined : fs.lstatSync(target, { throwIfNoEntry: false });
    const targetBlocked = blocked || Boolean(targetStat && !targetStat.isDirectory());
    const names = new Map(entries.map((entry) => [entry.name, entry]));
    const targetEntries = targetStat?.isDirectory()
      ? fs.readdirSync(target, { withFileTypes: true })
      : [];
    const bases = new Set(
      [...entries, ...targetEntries].flatMap((entry) => {
        if (entry.isDirectory()) {
          return [];
        }
        const name = entry.name;
        const suffix = SQLITE_SIDECAR_SUFFIXES.find((candidate) => name.endsWith(candidate));
        return suffix
          ? [name.slice(0, -suffix.length)]
          : /\.(?:sqlite3?|db)$/i.test(name)
            ? [name]
            : [];
      }),
    );
    const reserved = new Set<string>();
    const result: AgentDirEntryPlan[] = [];
    // Reserve every sibling family, including orphan sidecars. SQLite files and their
    // containing directories stay at the source until atomic family migration is supported.
    for (const base of bases) {
      const candidates = resolveSqliteDatabaseFilePaths(base);
      const members = candidates.filter((name) => names.has(name));
      if (members.length === 0) {
        continue;
      }
      const family: SqliteFamilyPlan = {
        kind: "sqlite",
        relative: path.join(relative, base),
        files: members.map((name) => path.join(relative, name)),
      };
      members.forEach((name) => reserved.add(name));
      families.push(family);
      result.push(family);
    }
    for (const entry of entries) {
      if (reserved.has(entry.name)) {
        continue;
      }
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) {
        const before = families.length;
        const children = plan(child, targetBlocked);
        result.push({
          kind: "directory",
          relative: child,
          entries: children,
          families: families.slice(before),
        });
      } else {
        result.push({ kind: "file", relative: child });
      }
    }
    return result;
  }
  return { entries: plan("", false), families };
}

export async function migrateLegacyAgentDir(
  detected: LegacyStateDetection,
  now: () => number,
): Promise<MigrationMessages> {
  const changes: string[] = [];
  const warnings: string[] = [];
  const deferred: NonNullable<MigrationMessages["deferred"]> = [];
  const sqliteFamilies: NonNullable<MigrationMessages["sqliteFamilies"]> = [];
  const { targetDir, sources } = detected.agentDir;
  if (!detected.agentDir.hasLegacy || !targetDir) {
    return { changes, warnings };
  }
  const destination = path.relative(detected.stateDir, targetDir).replaceAll(path.sep, "/");
  for (const { legacyDir, standalone, boundaryRoot } of sources) {
    const conflicts: string[] = [];
    const duplicates: string[] = [];
    const directories: string[] = [];
    const movedFiles: { sourcePath: string; destinationPath: string }[] = [];
    let sourceRoot = legacyDir;
    let targetRoot = targetDir;
    let retainedRoot = legacyDir;
    let quarantined = false;
    let preserveSource = false;
    function merge(entry: AgentDirEntryPlan) {
      const relative = entry.relative;
      const from = path.join(sourceRoot, relative);
      const to = path.join(targetRoot, relative);
      if (entry.kind === "sqlite") {
        return;
      }
      // A source-carried receipt cannot certify this migration.
      if (relative === LEGACY_AGENT_DIR_RECEIPT) {
        conflicts.push(relative);
        return;
      }
      const source = fs.lstatSync(from);
      const target = fs.lstatSync(to, { throwIfNoEntry: false });
      if (!target && (entry.kind !== "directory" || entry.families.length === 0)) {
        if (preserveSource) {
          if (source.isFile()) {
            fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
          } else {
            fs.cpSync(from, to, {
              recursive: true,
              force: false,
              errorOnExist: true,
              verbatimSymlinks: true,
            });
          }
        } else {
          fs.renameSync(from, to);
          movedFiles.push({ sourcePath: from, destinationPath: to });
        }
        changes.push(
          `${preserveSource ? "Copied" : "Moved"} agent file ${relative} → ${destination}`,
        );
      } else if (entry.kind === "directory" && (!target || target.isDirectory())) {
        if (!target) {
          fs.mkdirSync(to, { mode: source.mode & 0o7777 });
          fs.chmodSync(to, source.mode & 0o7777);
        }
        for (const child of entry.entries) {
          merge(child);
        }
        directories.push(relative);
      } else if (
        source.isFile() &&
        target?.isFile() &&
        source.size === target.size &&
        fs.readFileSync(from).equals(fs.readFileSync(to))
      ) {
        duplicates.push(relative);
      } else if (entry.kind === "directory" && entry.families.length > 0) {
        warnings.push(
          `Kept legacy directory ${from}: destination ${to} is not a directory; its SQLite families remain in place.`,
        );
      } else {
        conflicts.push(relative);
      }
    }

    try {
      sourceRoot = fs.realpathSync(legacyDir);
      retainedRoot = sourceRoot;
      if (!fs.lstatSync(legacyDir).isDirectory() || !isPathInside(boundaryRoot, sourceRoot)) {
        return {
          changes,
          ...(sqliteFamilies.length > 0 ? { sqliteFamilies } : {}),
          ...(deferred.length > 0 ? { deferred } : {}),
          warnings: [
            ...warnings,
            `Refused legacy agent migration from ${legacyDir}: source escaped its declared directory boundary.`,
          ],
        };
      }
      const owner = migrationFileExists(path.join(legacyDir, LEGACY_AGENT_DATABASE_BASENAME))
        ? resolveInstallAgentDir({}, { agentDir: legacyDir }).directory.owner
        : undefined;
      const ownerMismatch = owner !== undefined && owner !== detected.targetAgentId;
      if (ownerMismatch) {
        deferred.push({
          reason: "owner-mismatch",
          recordedOwner: owner,
          configuredOwner: detected.targetAgentId,
          path: legacyDir,
        });
        warnings.push(
          `Deferred legacy agent migration at ${legacyDir}: recorded owner ${owner} differs from configured owner ${detected.targetAgentId}. Keep using the existing store; ownership transfer requires a later release.`,
        );
      }
      // Ownership inspection can materialize a SQLite shared-memory sidecar; inventory afterward.
      const plan = planLegacyAgentDir(sourceRoot, targetDir);
      preserveSource = plan.families.length > 0;
      for (const family of plan.families) {
        const database = path.join(sourceRoot, family.relative);
        const files = family.files.map((file) => path.join(sourceRoot, file));
        const target = path.join(targetDir, family.relative);
        sqliteFamilies.push({
          database,
          files,
          destination: target,
          outcome: "deferred",
          reason: "sqlite-family",
        });
        warnings.push(
          `Deferred SQLite family ${database} (${files.join(", ")}) → ${target}: the store keeps being used from its current location; a later release moves it.`,
        );
      }
      if (ownerMismatch) {
        continue;
      }
      const stateRoot = fs.realpathSync(detected.stateDir);
      fs.mkdirSync(targetDir, { recursive: true });
      targetRoot = fs.realpathSync(targetDir);
      if (
        !fs.lstatSync(targetDir).isDirectory() ||
        isPathInside(sourceRoot, targetRoot) ||
        isPathInside(targetRoot, sourceRoot) ||
        sourceRoot === targetRoot
      ) {
        return {
          changes,
          ...(sqliteFamilies.length > 0 ? { sqliteFamilies } : {}),
          ...(deferred.length > 0 ? { deferred } : {}),
          warnings: [
            ...warnings,
            `Refused legacy agent migration from ${legacyDir} to ${targetDir}: overlapping directories or root symlinks could move canonical data.`,
          ],
        };
      }
      for (const entry of plan.entries) {
        merge(entry);
      }
      if (preserveSource) {
        continue;
      }
      // Removing the source pathname commits cutover. Until then every rename is reversible.
      // Keep duplicates and source directories intact so a failed cutover can restore all moves.
      const backupDir = path.join(stateRoot, `agent.legacy-${now()}-${randomUUID()}`);
      const quarantineParent = fs.realpathSync(path.dirname(backupDir));
      if (quarantineParent !== stateRoot && !isPathInside(stateRoot, quarantineParent)) {
        throw new Error(`Quarantine parent escaped the state directory: ${quarantineParent}`);
      }
      fs.renameSync(sourceRoot, backupDir);
      retainedRoot = backupDir;
      quarantined = true;
      for (const relative of duplicates) {
        fs.unlinkSync(path.join(backupDir, relative));
      }
      for (const relative of directories) {
        removeDirIfEmpty(path.join(backupDir, relative));
      }
      if (conflicts.length > 0) {
        changes.push(`Quarantined ${conflicts.length} conflicting agent path(s) → ${backupDir}`);
        for (const relative of conflicts) {
          warnings.push(
            `Kept ${path.join(targetDir, relative)}; quarantined legacy copy at ${path.join(backupDir, relative)}`,
          );
        }
      } else {
        fs.rmdirSync(backupDir);
      }
      if (standalone) {
        recordCompletedLegacyAgentDirMigration(sourceRoot, targetRoot);
      }
    } catch (error) {
      if (!quarantined) {
        // Only non-database entries enter this list; SQLite families never move.
        for (const move of movedFiles.toReversed()) {
          try {
            if (fs.lstatSync(move.sourcePath, { throwIfNoEntry: false })) {
              throw new Error(`Source was recreated: ${move.sourcePath}`, { cause: error });
            }
            fs.renameSync(move.destinationPath, move.sourcePath);
          } catch (restoreError) {
            warnings.push(
              `Could not restore ${move.sourcePath}; preserved at ${move.destinationPath}: ${String(restoreError)}`,
            );
          }
        }
      }
      warnings.push(
        `Could not finish legacy agent migration: ${String(error)}. Any remaining source is preserved at ${retainedRoot}. Rerun openclaw doctor --fix after resolving this error.`,
      );
    } finally {
      if (preserveSource) {
        for (const relative of conflicts) {
          warnings.push(
            `Kept ${path.join(targetDir, relative)}; legacy copy remains at ${path.join(sourceRoot, relative)} with the deferred SQLite store.`,
          );
        }
      }
    }
  }

  return {
    changes,
    warnings,
    warningDisposition: "recoverable",
    ...(sqliteFamilies.length > 0 ? { sqliteFamilies } : {}),
    ...(deferred.length > 0 ? { deferred } : {}),
    ...(deferred.length > 0 || sqliteFamilies.length > 0 ? ({ outcome: "deferred" } as const) : {}),
  };
}
