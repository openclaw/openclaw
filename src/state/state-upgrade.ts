// In-place state upgrade. Gateway startup is the only owner and holds exclusive custody.
//
// When a shared or agent database is older than this build, each outdated database
// first gets one pre-migration image, `<name>.pre-<generation>`: a copy-on-write clone
// where the filesystem supports it, a byte copy only when that still leaves the
// migration its room, otherwise none (recorded; the previous release then cannot be
// restored, and a failed start is fixed forward). The config gets one too. The
// shipped migration chain (this build's Doctor) then runs on the live state. Every
// schema step commits in one SQLite transaction with its version bump, so an
// interrupted or failed run leaves each database at its old or new version and the
// next start resumes. Nothing else is copied. If the chain fails validation, the
// generic name-matched rebuild produces the outdated databases from their images
// (or from the databases as left) through a durable plan, and the generation is
// pinned. Snapshot space never stops the upgrade; only the migration itself can.
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import JSON5 from "json5";
import { resolveDefaultAgentWorkspaceDir } from "../agents/workspace-default-path.js";
import { listAgentWorkspaceDirs } from "../agents/workspace-dirs.js";
import { resolveManagedWorktreeRoot } from "../agents/worktrees/storage-root.js";
import { resolveConfigIncludes } from "../config/includes.js";
import { coerceConfig } from "../config/io.read-helpers.js";
import { resolveConfigPath, resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveUserPath } from "../infra/home-dir.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { readSqliteUserVersion } from "../infra/sqlite-user-version.js";
import { getMediaDir } from "../media/store-path.js";
import { resolveRuntimeServiceBuildId, VERSION } from "../version.js";
import { readRetainedAgentDeletionIds } from "./agent-deletion-journal.snapshot.worker.js";
import { buildAgentDatabaseByCopy } from "./openclaw-agent-db-swap.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-schema-versions.js";
import { closeOpenClawStateDatabaseByPathAsync } from "./openclaw-state-db-cache.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import { CONTENT_VERSION_KEY } from "./openclaw-state-db-schema-version.js";
import { buildStateDatabaseByCopy } from "./openclaw-state-db-swap.js";
import {
  insertSetAsideRows,
  UPGRADE_SET_ASIDE_SCOPE,
  type SetAsideRow,
  type SqliteSwapReport,
} from "./sqlite-copy-swap.js";
import { createDoctorChain, type StateUpgradeChain } from "./state-upgrade-doctor.js";
import {
  APPLIED_UPGRADE_PREFIX as APPLIED_PREFIX,
  UPGRADE_WORK_PREFIX as WORK_PREFIX,
} from "./state-upgrade-receipts.js";
import {
  applyPlan,
  companionRemovals,
  fsyncPath,
  isMachineFailure,
  isSqliteFile,
  listFiles,
  normalizeSqliteText,
  pruneGenerations,
  readPlan,
  restorePreImages,
  takeStateUpgradePreImage,
  withRecoveredSource,
  writePlan,
  type UpgradeOp,
  type UpgradePlan,
} from "./state-upgrade-tree.js";
import {
  ChainStepError,
  conservationMismatches,
  validateShadow,
} from "./state-upgrade-validate.js";

const UPGRADE_REPORT_SCOPE = "upgrade.report";
const UPGRADE_PIN_SCOPE = "upgrade.pin";

// Previous files are kept as `<name>.pre-<generation>`, named after the build that replaced
// them: commits of one version can each upgrade, and a failed Git release trial restores
// exactly what its build replaced. A build without a build ID names them by version, as
// every build did before; those files stay readable and prunable by the same rules.
const generation = () => resolveRuntimeServiceBuildId() ?? VERSION;
// An applied plan is kept as `.upgraded-<generation>.json` until a later upgrade: a failed
// Git release trial reads it to remove the files that upgrade added (no `.pre-*` to restore).

function retainAppliedPlan(stateDir: string, plan: UpgradePlan): void {
  const file = path.join(stateDir, `${APPLIED_PREFIX}${plan.appVersion}.json`);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(plan), { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}

type DatabaseTarget = { kind: "state" | "agent"; agentId?: string; path: string; version: number };

export type StateUpgradeResult =
  | { status: "current" }
  | {
      status: "upgraded";
      mode: "chain" | "fallback";
      failedStep?: string;
      pinned: boolean;
      conservationMismatches: string[];
      setAside: number;
      warnings: string[];
    }
  | { status: "resumed" }
  | { status: "refused"; reason: string };

function readVersion(db: DatabaseSync, kind: DatabaseTarget["kind"]): number {
  const user = readSqliteUserVersion(db);
  if (kind !== "state") {
    return user;
  }
  try {
    const row = db
      .prepare("SELECT value_json FROM config_machine_state WHERE state_key = ?")
      // SAFETY: the statement fixes the column names and types of each row.
      .get(CONTENT_VERSION_KEY) as { value_json?: string } | undefined;
    return Math.max(user, Number(row?.value_json ?? 0) || 0);
  } catch {
    return user;
  }
}

function openReadOnly(pathname: string): DatabaseSync {
  return openNodeSqliteDatabase(pathname, { readOnly: true });
}

function discoverDatabases(stateDir: string): {
  targets: DatabaseTarget[];
  retainedAgentDirectories: string[];
} {
  const targets: DatabaseTarget[] = [];
  const retainedAgentDirectories: string[] = [];
  let retainedAgentIds = new Set<string>();
  const realStateDir = fs.realpathSync(stateDir);
  const add = (kind: DatabaseTarget["kind"], pathname: string, agentId?: string) => {
    if (!isSqliteFile(pathname)) {
      return;
    }
    // Accepted edge case: the swap cannot rename across a symlinked directory, so a
    // database there keeps the previous upgrade path (Doctor) instead.
    if (
      path.relative(realStateDir, fs.realpathSync(path.dirname(pathname))) !==
      path.relative(stateDir, path.dirname(pathname))
    ) {
      return;
    }
    const version = withRecoveredSource(pathname, (readable) => {
      const db = openReadOnly(readable);
      try {
        if (kind === "state") {
          retainedAgentIds = new Set(readRetainedAgentDeletionIds(db));
        }
        return readVersion(db, kind);
      } finally {
        db.close();
      }
    });
    targets.push({ kind, agentId, path: pathname, version });
  };
  add("state", path.join(stateDir, "state", "openclaw.sqlite"));
  let agents: string[] = [];
  try {
    agents = fs.readdirSync(path.join(stateDir, "agents"));
  } catch {
    // No agents yet.
  }
  for (const agentId of agents) {
    const agentDirectory = path.join(stateDir, "agents", agentId);
    if (retainedAgentIds.has(agentId)) {
      // Completed retention belongs to deletion, including during another store's upgrade.
      retainedAgentDirectories.push(agentDirectory);
      continue;
    }
    add("agent", path.join(stateDir, "agents", agentId, "agent", "openclaw-agent.sqlite"), agentId);
  }
  return { targets, retainedAgentDirectories };
}

const expectedVersion = (target: Pick<DatabaseTarget, "kind">) =>
  target.kind === "state" ? OPENCLAW_STATE_SCHEMA_VERSION : OPENCLAW_AGENT_SCHEMA_VERSION;

/**
 * Databases this build upgrades. Version 0 is no released schema (2026.7.1 is v1): a
 * PostgreSQL anchor or a catalog a native client created before the first Gateway; the
 * normal bootstrap owns those. Accepted edge case: with the shared state on PostgreSQL
 * the report and set-aside rows have no SQLite home, so SQLite agent databases there
 * keep the previous path (Doctor).
 */
function outdatedDatabases(targets: readonly DatabaseTarget[]): DatabaseTarget[] {
  if (targets.some((target) => target.kind === "state" && target.version === 0)) {
    return [];
  }
  return targets.filter((target) => target.version > 0 && target.version < expectedVersion(target));
}

/**
 * Whether this start must take state ownership: an interrupted swap to finish or a
 * database older than this build. Read-only, so a start that another live owner
 * refuses learns that from its usual admission check.
 */
export function isStateUpgradePending(env: NodeJS.ProcessEnv): boolean {
  const stateDir = path.resolve(resolveStateDir(env));
  return (
    fs.existsSync(stateDir) &&
    (fs.readdirSync(stateDir).some((entry) => entry.startsWith(WORK_PREFIX)) ||
      outdatedDatabases(discoverDatabases(stateDir).targets).length > 0)
  );
}

function readUpgradeConfig(configPath: string): OpenClawConfig {
  try {
    // Doctor owns validation and migration; path resolvers tolerate legacy shapes.
    return coerceConfig(
      resolveConfigIncludes(JSON5.parse(fs.readFileSync(configPath, "utf8")), configPath),
    );
  } catch {
    return {};
  }
}

/** Generic rebuild of every outdated database into the shadow. */
function buildFallback(
  targets: readonly DatabaseTarget[],
  toShadow: (p: string) => string,
  scratchDir: string,
): { reports: SqliteSwapReport[]; foldInFailures: string[] } {
  const reports: SqliteSwapReport[] = [];
  const foldInFailures: string[] = [];
  for (const target of targets) {
    const out = toShadow(target.path);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const built =
      target.kind === "agent"
        ? buildAgentDatabaseByCopy(target.agentId!, target.path, out, scratchDir)
        : buildStateDatabaseByCopy(target.path, out, scratchDir);
    reports.push(built.report);
    foldInFailures.push(...built.foldInFailures);
  }
  return { reports, foldInFailures };
}

function checkpointShadowDatabases(files: readonly string[]): void {
  for (const file of files) {
    if (!isSqliteFile(file)) {
      continue;
    }
    const db = openNodeSqliteDatabase(file);
    try {
      // A rollback-journal file needs no WAL or SHM companion, so read-only openers
      // can admit it before the first writer switches it back to WAL.
      db.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE;");
    } finally {
      db.close();
    }
    for (const suffix of ["-wal", "-shm", "-journal", ".seal"]) {
      fs.rmSync(`${file}${suffix}`, { force: true });
    }
  }
}

function recordDiagnostics(
  shadowStatePath: string,
  report: Record<string, unknown>,
  setAside: Array<{ report: SqliteSwapReport; rows: readonly SetAsideRow[] }>,
  pinned: boolean,
): void {
  if (!fs.existsSync(shadowStatePath)) {
    return;
  }
  const db = openNodeSqliteDatabase(shadowStatePath);
  try {
    const now = Date.now();
    const insert = db.prepare(
      `INSERT INTO diagnostic_events (scope, event_key, payload_json, created_at, sequence) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (scope, event_key) DO UPDATE SET payload_json = excluded.payload_json,
         created_at = excluded.created_at, sequence = excluded.sequence`,
    );
    insert.run(UPGRADE_REPORT_SCOPE, `${VERSION}:${now}`, JSON.stringify(report), now, now);
    if (pinned) {
      insert.run(UPGRADE_PIN_SCOPE, generation(), JSON.stringify({ version: VERSION }), now, now);
    }
    for (const entry of setAside) {
      insertSetAsideRows(
        db,
        { ...entry.report, previousFile: `.pre-${generation()}` },
        entry.rows,
        now,
      );
    }
  } finally {
    db.close();
  }
}

function readPinnedVersions(statePath: string): Set<string> {
  try {
    const db = openReadOnly(statePath);
    try {
      return new Set(
        (
          db
            .prepare("SELECT event_key FROM diagnostic_events WHERE scope = ?")
            // SAFETY: the statement fixes the column names and types of each row.
            .all(UPGRADE_PIN_SCOPE) as Array<{ event_key: string }>
        ).map((row) => row.event_key),
      );
    } finally {
      db.close();
    }
  } catch {
    return new Set();
  }
}

function finish(
  stateDir: string,
  workDir: string | undefined,
  ownedFiles: ReadonlySet<string>,
  // A resumed plan's generation is the state it just replaced; it stays like this build's.
  resumedGenerations: ReadonlySet<string> = new Set(),
): void {
  pruneGenerations(
    stateDir,
    generation(),
    new Set([
      ...readPinnedVersions(path.join(stateDir, "state", "openclaw.sqlite")),
      ...resumedGenerations,
    ]),
    ownedFiles,
  );
  const kept = new Set(
    [generation(), ...resumedGenerations].map((g) => `${APPLIED_PREFIX}${g}.json`),
  );
  for (const entry of fs.readdirSync(stateDir)) {
    if (entry.startsWith(APPLIED_PREFIX) && !kept.has(entry)) {
      fs.rmSync(path.join(stateDir, entry), { force: true });
    }
  }
  if (workDir) {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

/**
 * Bring every database in the state directory to this build's schema in place.
 * The caller holds exclusive state ownership.
 */
export async function upgradeStateDirectory(params: {
  env: NodeJS.ProcessEnv;
  log: { info: (message: string) => void; warn: (message: string) => void };
  runChain?: StateUpgradeChain;
  /** Release this process's handles on the live files before they are renamed. */
  beforeSwap?: () => Promise<void>;
  /**
   * The start's exclusive custody: `run` writes the live state under it; `handOff`
   * lends it to the in-place chain, which takes its own, and takes it back after.
   */
  custody?: {
    run: <T>(operation: () => Promise<T>) => Promise<T>;
    handOff: <T>(operation: () => Promise<T>) => Promise<T>;
  };
  /**
   * Whether this build would start on the upgraded config. On a refusal the
   * pre-images are restored when every outdated database has one, so the start's own
   * refusal keeps the previous package's state; otherwise the state stays migrated.
   */
  admitConfig?: (live: { configPath: string; stateDir: string }) => Promise<string | undefined>;
}): Promise<StateUpgradeResult> {
  const env = params.env;
  const stateDir = path.resolve(resolveStateDir(env));
  const configPath = path.resolve(resolveConfigPath(env, stateDir));
  if (!fs.existsSync(stateDir)) {
    return { status: "current" };
  }
  const config = readUpgradeConfig(configPath);
  const excludedRoots = [
    resolveDefaultAgentWorkspaceDir(env),
    ...listAgentWorkspaceDirs(config, env),
    ...(config.agents?.defaults?.workspace
      ? [resolveUserPath(config.agents.defaults.workspace, env)]
      : []),
    resolveManagedWorktreeRoot(env),
    resolveManagedWorktreeRoot(env, config.worktreeRoot),
    // Plugin storage is not a core migration input. Knowledge Doctor only
    // normalizes config; browser profile storage belongs to the browser plugin.
    // Git release installations are code, never state; copying them doubles every release.
    ...["knowledge", "browser", "backups", "cache", "locks", "tmp", "git-install"].map((name) =>
      path.join(stateDir, name),
    ),
  ].flatMap((dir) => {
    const absolute = path.resolve(dir);
    return fs.existsSync(absolute) ? [absolute, fs.realpathSync(absolute)] : [absolute];
  });
  const media = getMediaDir({ ...env, OPENCLAW_STATE_DIR: stateDir });
  const mediaRecords = path.join(media, "outgoing", "records");
  const within = (file: string, dir: string) =>
    file === dir || file.startsWith(`${dir}${path.sep}`);
  const skip = (absolute: string) => {
    const top = path.relative(stateDir, absolute).split(path.sep)[0] ?? "";
    return (
      top.startsWith(WORK_PREFIX) ||
      top.startsWith(APPLIED_PREFIX) ||
      excludedRoots.some((dir) => within(absolute, dir)) ||
      // Managed outgoing JSON is still a Doctor input; payloads are not.
      (within(absolute, media) &&
        !within(mediaRecords, absolute) &&
        !within(absolute, mediaRecords))
    );
  };
  const resumedFiles = new Set<string>();
  const resumedGenerations = new Set<string>();
  // A durable plan from an interrupted swap is finished before anything else.
  let resumed = false;
  let interruptedChain = false;
  // An interrupted in-place run's record: kept until this run has written its own.
  const interruptedDirs: string[] = [];
  let priorInventory: Set<string> | undefined;
  const priorOutdated = new Set<string>();
  for (const entry of fs.readdirSync(stateDir)) {
    if (!entry.startsWith(WORK_PREFIX)) {
      continue;
    }
    const dir = path.join(stateDir, entry);
    const plan = readPlan(dir);
    if (plan) {
      // Environment selection may already hold the shared database being replaced.
      await params.beforeSwap?.();
      applyPlan(plan);
      retainAppliedPlan(stateDir, plan);
      resumedGenerations.add(plan.appVersion);
      for (const op of plan.ops) {
        if (!skip(op.live)) {
          resumedFiles.add(op.live);
        }
      }
      params.log.info(`Finished an interrupted state upgrade to ${plan.appVersion}.`);
      resumed = true;
    } else if (entry.startsWith(`${WORK_PREFIX}${generation()}-`)) {
      // This build's in-place chain was interrupted: its databases may already be
      // current while the rest of its Doctor work (config, legacy files) is not.
      interruptedChain = true;
      interruptedDirs.push(dir);
      try {
        const text = fs.readFileSync(path.join(dir, INVENTORY_FILE), "utf8");
        // SAFETY: only this module writes the inventory.
        const record = JSON.parse(text) as { files: string[]; outdated: string[] };
        priorInventory = new Set([...(priorInventory ?? []), ...record.files]);
        for (const file of record.outdated) {
          priorOutdated.add(file);
        }
      } catch {
        // Killed before the inventory was written: nothing had changed yet.
      }
      continue;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const { targets, retainedAgentDirectories } = discoverDatabases(stateDir);
  excludedRoots.push(...retainedAgentDirectories);
  let outdated = outdatedDatabases(targets);
  // Finish an interrupted chain on every database it started on, current or not, imaged or
  // not: the images stay the baseline, and a refusal or fallback covers all of them together.
  if (interruptedChain) {
    const started = targets.filter(
      (target) =>
        target.version > 0 &&
        (priorOutdated.has(target.path) || fs.existsSync(`${target.path}.pre-${generation()}`)),
    );
    outdated = [...outdated, ...started.filter((target) => !outdated.includes(target))];
    if (outdated.length === 0) {
      outdated = targets.filter((target) => target.version > 0);
    }
  }
  if (outdated.length === 0) {
    for (const dir of interruptedDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    if (resumed) {
      finish(stateDir, undefined, resumedFiles, resumedGenerations);
    }
    return resumed ? { status: "resumed" } : { status: "current" };
  }
  // Logs and fallback builds only; a per-attempt name keeps an orphan out of the next start.
  const workDir = path.join(stateDir, `${WORK_PREFIX}${generation()}-${process.pid}-${Date.now()}`);
  const runChain = params.runChain ?? createDoctorChain();
  const chainLog = path.join(workDir, "chain.log");
  const suffix = `.pre-${generation()}`;
  const liveState = path.join(stateDir, "state", "openclaw.sqlite");
  const warnings: string[] = [];
  const warn = (message: string) => {
    warnings.push(message);
    params.log.warn(message);
  };
  let planWritten = false;
  let migrationStarted = false;
  const inCustody = params.custody?.run ?? (<T>(operation: () => Promise<T>) => operation());
  // The chain's own output stays next to the other logs for diagnosis, whatever the outcome.
  const keepChainLog = () => {
    if (fs.existsSync(chainLog)) {
      fs.mkdirSync(path.join(stateDir, "logs"), { recursive: true });
      fs.copyFileSync(chainLog, path.join(stateDir, "logs", `state-upgrade-${VERSION}.log`));
    }
  };
  const handOff = params.custody?.handOff ?? (<T>(operation: () => Promise<T>) => operation());
  try {
    fs.mkdirSync(workDir, { recursive: true, mode: 0o700 });
    params.log.info(
      `Upgrading state to ${VERSION} in place: ${outdated.map((t) => `${path.relative(stateDir, t.path)} v${t.version}`).join(", ")}`,
    );
    // The one pre-migration image: of each outdated database, taken before it changes.
    const images = new Map<string, string>();
    const before = await inCustody(async () => {
      for (const target of outdated) {
        // A resumed chain keeps the interrupted start's images; it never images new data.
        const image =
          interruptedChain &&
          !fs.existsSync(`${target.path}${suffix}`) &&
          target.version >= expectedVersion(target)
            ? { skipped: "the interrupted start had already migrated it without one" }
            : await takeStateUpgradePreImage(target.path, suffix, interruptedChain);
        if ("skipped" in image) {
          warn(
            `No pre-migration image of ${path.relative(stateDir, target.path)}: ${image.skipped}. It is migrated in place; once its migration commits, the previous release cannot open it, so a failed start stays on this release and is fixed forward.`,
          );
        } else {
          images.set(target.path, image.path);
          params.log.info(
            `Kept ${path.relative(stateDir, target.path)} as ${path.basename(image.path)} (${image.method}).`,
          );
        }
      }
      // The config is small; its pre-image lets a failed trial restore it with the databases.
      if (
        fs.existsSync(configPath) &&
        (!interruptedChain || !fs.existsSync(`${configPath}${suffix}`))
      ) {
        const partial = `${configPath}${suffix}.partial-${process.pid}`;
        try {
          // A symlinked config is read through its link: the image holds the bytes, and
          // it is private like the config whatever mode the link's target has.
          fs.rmSync(partial, { force: true });
          fs.writeFileSync(partial, fs.readFileSync(configPath), { mode: 0o600, flag: "wx" });
          fsyncPath(partial);
          fs.renameSync(partial, `${configPath}${suffix}`);
        } catch (error) {
          fs.rmSync(partial, { force: true });
          if (!isMachineFailure(error)) {
            throw error;
          }
          // SAFETY: node:fs throws Error instances; only the message is read.
          warn(`No pre-migration image of the config: ${(error as Error).message}.`);
        }
      }
      // The inventory before Doctor runs; a resumed run keeps the interrupted one's.
      const listed = priorInventory ?? listFiles(stateDir, skip);
      // Durable before the interrupted records it replaces are removed.
      const inventory = path.join(workDir, INVENTORY_FILE);
      fs.writeFileSync(
        `${inventory}.tmp`,
        JSON.stringify({ files: [...listed], outdated: outdated.map((target) => target.path) }),
        { mode: 0o600 },
      );
      fsyncPath(`${inventory}.tmp`);
      fs.renameSync(`${inventory}.tmp`, inventory);
      fsyncPath(workDir, true);
      // This run's record holds the inventory now; the interrupted ones it replaces can go.
      for (const dir of interruptedDirs) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
      migrationStarted = true;
      for (const target of outdated) {
        const db = openNodeSqliteDatabase(target.path);
        try {
          normalizeSqliteText(db);
        } finally {
          db.close();
        }
      }
      return listed;
    });
    let mode: "chain" | "fallback" = "chain";
    let failedStep: string | undefined;
    const setAside: Array<{ report: SqliteSwapReport; rows: readonly SetAsideRow[] }> = [];
    let mismatches: string[] = [];
    let ops: UpgradeOp[] = [];
    try {
      // Each schema step commits in one SQLite transaction with its version bump, so
      // an interrupted or failed run leaves every database at its old or new version.
      const chain = await handOff(() => runChain({ stateDir, configPath, env, logPath: chainLog }));
      warnings.push(...chain.warnings);
      await inCustody(async () => {
        validateShadow(outdated, (live) => live, readVersion, expectedVersion);
        // Row conservation compares against the pre-image; a skipped image has no baseline.
        const imaged = outdated.filter((target) => images.has(target.path));
        mismatches = conservationMismatches(
          imaged.map((target) => ({ ...target, path: images.get(target.path)! })),
          (image) => imaged.find((target) => images.get(target.path) === image)!.path,
        );
      });
    } catch (error) {
      if (
        error instanceof StateUpgradeCustodyLostError ||
        (!(error instanceof ChainStepError) && isMachineFailure(error))
      ) {
        throw error;
      }
      mode = "fallback";
      failedStep = error instanceof ChainStepError ? error.step : "chain";
      params.log.warn(
        // SAFETY: node:fs and node:sqlite throw Error instances; only optional fields are read.
        `State upgrade chain failed at ${failedStep}: ${(error as Error).message}. Rebuilding the outdated databases with the generic copy; the previous files are kept and pinned.`,
      );
      // The rebuild reads each outdated database as the chain left it (each at its old or
      // new version, with whatever Doctor already imported), never its image: nothing
      // Doctor committed is dropped, and the image stays the rollback baseline.
      await inCustody(async () => {
        // The swap preserves a live WAL beside the database's preserved name, where the
        // standalone image already sits: fold it in first, or stop with nothing deleted.
        for (const live of images.keys()) {
          foldLiveWal(live);
        }
        const out = (live: string) => path.join(workDir, "fallback", path.relative(stateDir, live));
        const fallback = buildFallback(outdated, out, workDir);
        warnings.push(...fallback.foldInFailures);
        for (const report of fallback.reports) {
          setAside.push({ report, rows: report.setAside });
          mismatches.push(...report.conservationMismatches.map((t) => `${report.label}:${t}`));
        }
        checkpointShadowDatabases(outdated.map((target) => out(target.path)));
        ops = outdated.map((target) => ({
          kind: "replace" as const,
          live: target.path,
          next: out(target.path),
        }));
      });
    }
    return await inCustody(async (): Promise<StateUpgradeResult> => {
      const pinned = mode === "fallback" || mismatches.length > 0;
      const setAsideCount = setAside.reduce((sum, entry) => sum + entry.rows.length, 0);
      let refusal: string | undefined;
      try {
        refusal = await params.admitConfig?.({ configPath, stateDir });
      } finally {
        await closeOpenClawStateDatabaseByPathAsync(liveState);
      }
      if (refusal !== undefined) {
        // Without an image for every migrated database, the state cannot be put back.
        const restorable = outdated.every((target) => images.has(target.path));
        if (restorable) {
          await params.beforeSwap?.();
          restorePreImages([...images.keys(), configPath], suffix);
        }
        keepChainLog();
        fs.rmSync(workDir, { recursive: true, force: true });
        params.log.warn(
          `State upgrade to ${VERSION} not applied: ${refusal}${restorable ? " The previous databases and config were restored." : " The databases stay migrated; no pre-migration image exists to restore them."}`,
        );
        return { status: "refused", reason: refusal };
      }
      // Databases the run created with no predecessor; a failed Git release trial removes
      // them. Other new files can be archives of moved sources, so they always stay.
      const created = [...listFiles(stateDir, skip)].filter(
        (file) => !before.has(file) && !file.startsWith(`${workDir}${path.sep}`),
      );
      const databases = new Set(created.filter((file) => isSqliteFile(file)));
      const added = created.filter(
        (file) =>
          databases.has(file) ||
          ["-wal", "-shm", "-journal"].some(
            (companion) =>
              file.endsWith(companion) && databases.has(file.slice(0, -companion.length)),
          ),
      );
      const applied: UpgradeOp[] = [
        ...ops,
        ...[...added].map((live) => ({ kind: "add" as const, live })),
      ];
      recordDiagnostics(
        mode === "fallback" && outdated.some((t) => t.path === liveState)
          ? ops.find((op) => op.live === liveState)!.next!
          : liveState,
        {
          appVersion: VERSION,
          mode,
          failedStep,
          from: Object.fromEntries(
            outdated.map((t) => [path.relative(stateDir, t.path), t.version]),
          ),
          conservationMismatches: mismatches,
          setAside: setAsideCount,
          warnings,
          preserved: suffix,
          imagesSkipped: outdated
            .filter((target) => !images.has(target.path))
            .map((target) => path.relative(stateDir, target.path)),
          pinned,
        },
        setAside,
        pinned,
      );
      if (ops.length > 0) {
        ops.push(...companionRemovals(ops), ...applied.filter((op) => op.kind === "add"));
        for (const op of ops) {
          if (op.next && fs.statSync(op.next, { throwIfNoEntry: false })?.isFile()) {
            fsyncPath(op.next);
          }
        }
        await params.beforeSwap?.();
        writePlan(workDir, { appVersion: generation(), ops });
        planWritten = true;
        applyPlan({ appVersion: generation(), ops });
      }
      retainAppliedPlan(stateDir, {
        appVersion: generation(),
        ops: ops.length > 0 ? ops : applied,
      });
      keepChainLog();
      finish(
        stateDir,
        workDir,
        new Set([...outdated.map((t) => t.path), configPath].filter((file) => !skip(file))),
      );
      const summary = `State upgraded to ${VERSION} in place by ${mode === "chain" ? "migration chain" : "generic copy"}; ${images.size === outdated.length ? `previous databases kept as *${suffix}` : `${outdated.length - images.size} database(s) without a pre-migration image`}.`;
      if (pinned) {
        params.log.warn(
          `${summary} ${failedStep ? `Chain step ${failedStep} failed. ` : ""}${setAsideCount} row(s) set aside in diagnostic_events (${UPGRADE_SET_ASIDE_SCOPE}); conservation: ${mismatches.join("; ") || "ok"}. The previous generation is pinned; run openclaw doctor to review.`,
        );
      } else {
        params.log.info(summary);
      }
      return {
        status: "upgraded",
        mode,
        failedStep,
        pinned,
        conservationMismatches: mismatches,
        setAside: setAsideCount,
        warnings,
      };
    });
  } catch (error) {
    if (!planWritten) {
      try {
        keepChainLog();
      } catch {
        // A full disk can refuse the log too; the failure itself is what matters.
      }
      if (migrationStarted) {
        // Each database is at its old or new version; this record makes the next start
        // finish the chain on the same images instead of serving a half-done upgrade.
        throw error;
      }
      fs.rmSync(workDir, { recursive: true, force: true });
      throw explainMachineFailure(error, stateDir);
    }
    throw error;
  }
}

/** A full disk or I/O failure before any database migrated: name the fix instead of the raw error. */
export function explainMachineFailure(error: unknown, stateDir: string): unknown {
  return isMachineFailure(error)
    ? new Error(
        // SAFETY: node:fs and node:sqlite throw Error instances; only optional fields are read.
        `State upgrade to ${VERSION} stopped: ${(error as Error).message}. No database in ${stateDir} was migrated. Free disk space for the migration and start the Gateway again.`,
        { cause: error },
      )
    : error;
}

/**
 * Fold an imaged live database's WAL into it under custody, through SQLite only. A
 * checkpoint another connection blocks, or a mode SQLite will not switch, stops the
 * fallback with every file in place; the next start retries.
 */
function foldLiveWal(file: string): void {
  const refuse = (cause?: unknown) =>
    new Error(
      `State upgrade could not fold the write-ahead log of ${file} into it; nothing was removed, and the next start retries.`,
      { cause },
    );
  let folded = false;
  try {
    const db = openNodeSqliteDatabase(file);
    try {
      // SAFETY: SQLite fixes these pragmas' result columns.
      const checkpoint = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as
        | { busy: number }
        | undefined;
      // SAFETY: SQLite fixes these pragmas' result columns.
      const mode = db.prepare("PRAGMA journal_mode = DELETE").get() as
        | { journal_mode: string }
        | undefined;
      folded = checkpoint?.busy === 0 && mode?.journal_mode === "delete";
    } finally {
      db.close();
    }
  } catch (error) {
    throw refuse(error);
  }
  if (!folded) {
    throw refuse();
  }
}

/** Another process holds the state when the chain hands custody back; it continues. */
export class StateUpgradeCustodyLostError extends Error {}

// The file names that existed before Doctor ran, kept in the work directory.
const INVENTORY_FILE = "inventory.json";
