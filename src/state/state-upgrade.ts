// Copy-and-swap state upgrade. Gateway startup is the only owner.
//
// When a shared or agent database is older than this build, the migration-owned state
// inputs are copied into a private shadow. The shipped migration chain (this
// build's Doctor) runs on the shadow only. The result is validated, written to a
// durable plan, and renamed into place; every replaced or retired live file stays
// as `<name>.pre-<generation>`. The live files are never written before the plan is
// durable. If the chain fails, the generic name-matched rebuild produces the
// databases instead and the previous generation is pinned. Data never blocks the
// upgrade; only machine failures (disk full, I/O, crash) stop it, and a crash
// before the plan leaves the live tree untouched.
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
  applyPlan,
  companionRemovals,
  changedShadowFiles,
  copyTree,
  copySqliteFamily,
  countSqlitePrefix,
  diffTree,
  fsyncPath,
  isSqliteFile,
  listTreeFiles,
  normalizeSqliteText,
  pruneGenerations,
  readPlan,
  rewriteFilePrefix,
  rewriteSqlitePrefix,
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
const WORK_PREFIX = ".upgrade-";
// Previous files are kept as `<name>.pre-<generation>`, named after the build that replaced
// them: commits of one version can each upgrade, and a failed Git release trial restores
// exactly what its build replaced. A build without a build ID names them by version, as
// every build did before; those files stay readable and prunable by the same rules.
const GENERATION = resolveRuntimeServiceBuildId() ?? VERSION;
// An applied plan is kept as `.upgraded-<generation>.json` until a later upgrade: a failed
// Git release trial reads it to remove the files that upgrade added (no `.pre-*` to restore).
const APPLIED_PREFIX = ".upgraded-";

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
      insert.run(UPGRADE_PIN_SCOPE, GENERATION, JSON.stringify({ version: VERSION }), now, now);
    }
    for (const entry of setAside) {
      insertSetAsideRows(
        db,
        { ...entry.report, previousFile: `.pre-${GENERATION}` },
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
    GENERATION,
    new Set([
      ...readPinnedVersions(path.join(stateDir, "state", "openclaw.sqlite")),
      ...resumedGenerations,
    ]),
    ownedFiles,
  );
  const kept = new Set(
    [GENERATION, ...resumedGenerations].map((g) => `${APPLIED_PREFIX}${g}.json`),
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
 * Bring every database in the state directory to this build's schema by copy
 * and swap. The caller holds exclusive state ownership.
 */
export async function upgradeStateDirectory(params: {
  env: NodeJS.ProcessEnv;
  log: { info: (message: string) => void; warn: (message: string) => void };
  runChain?: StateUpgradeChain;
  /** Release this process's handles on the live files before they are renamed. */
  beforeSwap?: () => Promise<void>;
  /**
   * Whether this build would start on the upgraded config. A refusal leaves the live
   * tree untouched, so the start's own refusal keeps the previous package's state.
   */
  admitConfig?: (shadow: { configPath: string; stateDir: string }) => Promise<string | undefined>;
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
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const { targets, retainedAgentDirectories } = discoverDatabases(stateDir);
  excludedRoots.push(...retainedAgentDirectories);
  const outdated = outdatedDatabases(targets);
  if (outdated.length === 0) {
    if (resumed) {
      finish(stateDir, undefined, resumedFiles, resumedGenerations);
    }
    return resumed ? { status: "resumed" } : { status: "current" };
  }
  // A per-attempt name keeps a shadow Doctor orphaned by a crash out of the next attempt.
  const workDir = path.join(stateDir, `${WORK_PREFIX}${GENERATION}-${process.pid}-${Date.now()}`);
  const shadowRoot = path.join(workDir, "state");
  const configInside = !path.relative(stateDir, configPath).startsWith("..");
  const shadowConfig = configInside
    ? path.join(shadowRoot, path.relative(stateDir, configPath))
    : path.join(workDir, "config", path.basename(configPath));
  const toShadow = (live: string) => path.join(shadowRoot, path.relative(stateDir, live));
  const runChain = params.runChain ?? createDoctorChain();
  const chainLog = path.join(workDir, "chain.log");
  let planWritten = false;
  try {
    fs.mkdirSync(workDir, { recursive: true, mode: 0o700 });
    params.log.info(
      `Upgrading state to ${VERSION}: ${outdated.map((t) => `${path.relative(stateDir, t.path)} v${t.version}`).join(", ")}`,
    );
    const baseline = new Map<string, string | undefined>();
    const liveState = path.join(stateDir, "state", "openclaw.sqlite");
    const requiredSqlite = new Set([...outdated.map((target) => target.path), liveState]);
    const copyScope = await copyTree(stateDir, shadowRoot, skip, baseline, {
      requiredSqlite,
      log: params.log,
      additionalCopyBytes: configInside
        ? 0
        : (fs.statSync(configPath, { throwIfNoEntry: false })?.size ?? 0),
    });
    if (!configInside && fs.existsSync(configPath)) {
      fs.mkdirSync(path.dirname(shadowConfig), { recursive: true });
      fs.copyFileSync(configPath, shadowConfig);
    }
    for (const target of outdated) {
      const db = openNodeSqliteDatabase(toShadow(target.path));
      try {
        normalizeSqliteText(db);
      } finally {
        db.close();
      }
    }
    // Absolute paths into the live tree must resolve to the shadow during the run.
    if (fs.existsSync(shadowConfig)) {
      rewriteFilePrefix(shadowConfig, stateDir, shadowRoot);
    }
    let mode: "chain" | "fallback" = "chain";
    let failedStep: string | undefined;
    const warnings: string[] = [];
    const setAside: Array<{ report: SqliteSwapReport; rows: readonly SetAsideRow[] }> = [];
    let mismatches: string[] = [];
    const fallbackAdds: UpgradeOp[] = [];
    try {
      const chain = await runChain({
        stateDir: shadowRoot,
        configPath: shadowConfig,
        env,
        logPath: chainLog,
      });
      warnings.push(...chain.warnings);
      validateShadow(outdated, toShadow, readVersion, expectedVersion);
      mismatches = conservationMismatches(outdated, toShadow);
    } catch (error) {
      if (!(error instanceof ChainStepError) && isMachineFailure(error)) {
        throw error;
      }
      mode = "fallback";
      failedStep = error instanceof ChainStepError ? error.step : "chain";
      params.log.warn(
        // SAFETY: node:fs and node:sqlite throw Error instances; only optional fields are read.
        `State upgrade chain failed at ${failedStep}: ${(error as Error).message}. Rebuilding the databases with the generic copy; the previous files are kept and pinned.`,
      );
      // The fallback swaps only the rebuilt databases plus what the chain finished
      // outside them: the migrated config and new stores it moved data into (client
      // credentials, services). Those stay in the shadow, in directories with the
      // chain's modes; the rest of the shadow is never swapped.
      for (const file of listTreeFiles(shadowRoot)) {
        if (
          isSqliteFile(file) &&
          !fs.existsSync(path.join(stateDir, path.relative(shadowRoot, file)))
        ) {
          fallbackAdds.push({
            kind: "add",
            live: path.join(stateDir, path.relative(shadowRoot, file)),
            next: file,
          });
        }
      }
      const fallback = buildFallback(outdated, toShadow, workDir);
      // The upgrade report, set-aside rows and pin live in the shared database, so a
      // current one is copied too and swapped with them.
      if (
        !outdated.some((t) => t.kind === "state") &&
        baseline.has(toShadow(liveState)) &&
        isSqliteFile(liveState)
      ) {
        for (const suffix of ["-wal", "-shm", "-journal"]) {
          fs.rmSync(`${toShadow(liveState)}${suffix}`, { force: true });
        }
        await copySqliteFamily(liveState, toShadow(liveState), params.log);
        fallbackAdds.push({ kind: "replace", live: liveState, next: toShadow(liveState) });
      }
      warnings.push(...fallback.foldInFailures);
      for (const report of fallback.reports) {
        setAside.push({ report, rows: report.setAside });
        mismatches.push(...report.conservationMismatches.map((t) => `${report.label}:${t}`));
      }
    }
    // Paths the run wrote into the shadow point at the live tree again. Only files the
    // run wrote can hold them; the rest of the copy is never read again.
    const written = changedShadowFiles(shadowRoot, baseline);
    for (const file of written) {
      if (isSqliteFile(file)) {
        const db = openNodeSqliteDatabase(file);
        try {
          rewriteSqlitePrefix(db, shadowRoot, stateDir);
          if (countSqlitePrefix(db, shadowRoot) > 0) {
            warnings.push(`${path.relative(shadowRoot, file)} still names the private copy`);
          }
        } finally {
          db.close();
        }
      } else {
        rewriteFilePrefix(file, shadowRoot, stateDir);
      }
    }
    if (fs.existsSync(shadowConfig) && !configInside) {
      rewriteFilePrefix(shadowConfig, shadowRoot, stateDir);
    }
    const pinned = mode === "fallback" || mismatches.length > 0;
    const setAsideCount = setAside.reduce((sum, entry) => sum + entry.rows.length, 0);
    const warn = (message: string) => {
      warnings.push(message);
      params.log.warn(message);
    };
    checkpointShadowDatabases(changedShadowFiles(shadowRoot, baseline));
    // Decide before recording diagnostics so uncopied-file warnings survive restart.
    const ops: UpgradeOp[] =
      mode === "chain"
        ? diffTree(stateDir, shadowRoot, baseline, warn)
        : [
            ...outdated.map((t) => ({
              kind: "replace" as const,
              live: t.path,
              next: toShadow(t.path),
            })),
            ...fallbackAdds,
          ];
    if (
      mode === "chain" &&
      baseline.has(toShadow(liveState)) &&
      !ops.some((op) => op.live === liveState)
    ) {
      ops.push({ kind: "replace", live: liveState, next: toShadow(liveState) });
    }
    if (mode === "fallback" && configInside && fs.existsSync(shadowConfig)) {
      const original = fs.existsSync(configPath) ? fs.readFileSync(configPath) : undefined;
      if (!original?.equals(fs.readFileSync(shadowConfig))) {
        ops.push({ kind: original ? "replace" : "add", live: configPath, next: shadowConfig });
      }
    }
    // A config outside the state directory may be on another filesystem; its new
    // bytes are staged beside it so the plan's rename stays on one filesystem.
    let stagedConfig: string | undefined;
    if (!configInside && fs.existsSync(shadowConfig)) {
      const original = fs.existsSync(configPath) ? fs.readFileSync(configPath) : undefined;
      if (!original?.equals(fs.readFileSync(shadowConfig))) {
        stagedConfig = path.join(
          path.dirname(configPath),
          `.${path.basename(configPath)}.upgrade-${VERSION}`,
        );
        ops.push({ kind: original ? "replace" : "add", live: configPath, next: stagedConfig });
      }
    }
    for (let index = ops.length - 1; index >= 0; index--) {
      const op = ops[index]!;
      if (op.live === configPath && !configInside) {
        continue;
      }
      if (fs.lstatSync(op.live, { throwIfNoEntry: false }) && !baseline.has(toShadow(op.live))) {
        warn(`Left uncopied live file unchanged: ${path.relative(stateDir, op.live)}`);
        ops.splice(index, 1);
      }
    }
    const retired = copyScope.retiredBackups;
    params.log.info(
      `State upgrade retained ${retired.count} retired backup file(s), ${retired.bytes} bytes; cleanup remains with the operator or Doctor.`,
    );
    recordDiagnostics(
      toShadow(path.join(stateDir, "state", "openclaw.sqlite")),
      {
        appVersion: VERSION,
        mode,
        failedStep,
        from: Object.fromEntries(outdated.map((t) => [path.relative(stateDir, t.path), t.version])),
        conservationMismatches: mismatches,
        setAside: setAsideCount,
        warnings,
        retiredBackups: retired,
        preserved: `.pre-${GENERATION}`,
        pinned,
      },
      setAside,
      pinned,
    );
    checkpointShadowDatabases([toShadow(liveState)]);
    ops.push(...companionRemovals(ops));
    for (const op of ops) {
      if (op.next && fs.statSync(op.next, { throwIfNoEntry: false })?.isFile()) {
        fsyncPath(op.next);
      }
    }
    const refusal = await params.admitConfig?.({ configPath: shadowConfig, stateDir: shadowRoot });
    if (refusal !== undefined) {
      fs.rmSync(workDir, { recursive: true, force: true });
      params.log.warn(`State upgrade to ${VERSION} not applied: ${refusal}`);
      return { status: "refused", reason: refusal };
    }
    if (stagedConfig) {
      fs.copyFileSync(shadowConfig, stagedConfig);
      fsyncPath(stagedConfig);
    }
    await params.beforeSwap?.();
    writePlan(workDir, { appVersion: GENERATION, ops });
    planWritten = true;
    applyPlan({ appVersion: GENERATION, ops });
    retainAppliedPlan(stateDir, { appVersion: GENERATION, ops });
    if (fs.existsSync(chainLog)) {
      // The chain's own output stays next to the other logs for diagnosis.
      fs.mkdirSync(path.join(stateDir, "logs"), { recursive: true });
      fs.copyFileSync(chainLog, path.join(stateDir, "logs", `state-upgrade-${VERSION}.log`));
    }
    finish(stateDir, workDir, new Set(ops.map((op) => op.live).filter((file) => !skip(file))));
    const summary = `State upgraded to ${VERSION} by ${mode === "chain" ? "migration chain" : "generic copy"}; previous files kept as *.pre-${GENERATION}.`;
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
  } catch (error) {
    if (!planWritten) {
      // Nothing live changed; the next start retries from scratch.
      fs.rmSync(workDir, { recursive: true, force: true });
      throw explainMachineFailure(error, stateDir);
    }
    throw error;
  }
}

/** A full disk or I/O failure before any live change: name the fix instead of the raw error. */
export function explainMachineFailure(error: unknown, stateDir: string): unknown {
  return isMachineFailure(error)
    ? new Error(
        // SAFETY: node:fs and node:sqlite throw Error instances; only optional fields are read.
        `State upgrade to ${VERSION} stopped: ${(error as Error).message}. Nothing in ${stateDir} was changed. Free disk space for the migration inputs and scratch margin and start the Gateway again.`,
        { cause: error },
      )
    : error;
}

function isMachineFailure(error: unknown): boolean {
  // SAFETY: node:fs and node:sqlite throw Error instances; only optional fields are read.
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  // SAFETY: node:fs and node:sqlite throw Error instances; only optional fields are read.
  const message = (error as Error | undefined)?.message ?? "";
  return (
    code === "ENOSPC" ||
    code === "EIO" ||
    code === "EDQUOT" ||
    code === "EROFS" ||
    /SQLITE_FULL|database or disk is full|disk I\/O error/iu.test(message)
  );
}
