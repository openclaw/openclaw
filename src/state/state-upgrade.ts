// Copy-and-swap state upgrade. Gateway startup is the only owner.
//
// Migration inputs are copied into a private shadow, migrated by this build's
// Doctor, validated, and published by a durable rename plan. PostgreSQL copies
// retain the original namespace for rollback. Stores whose measured copy estimate
// exceeds the update window keep the existing in-place migration owner instead;
// SQLite state still receives its normal private-copy protection.
import fs from "node:fs";
import path from "node:path";
import { resolveDefaultAgentWorkspaceDir } from "../agents/workspace-default-path.js";
import { listAgentWorkspaceDirs } from "../agents/workspace-dirs.js";
import { resolveManagedWorktreeRoot } from "../agents/worktrees/storage-root.js";
import { resolveConfigPath, resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readBackupEngine } from "../infra/database-engine/physical-store.js";
import { formatErrorMessage } from "../infra/errors.js";
import { resolveUserPath } from "../infra/home-dir.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { getMediaDir } from "../media/store-path.js";
import {
  clonePostgresUpgrade,
  preflightPostgresUpgrade,
  retirePostgresUpgrade,
  validatePostgresUpgrade,
} from "../snapshot/database-backup.js";
import { resolveRuntimeServiceBuildId, VERSION } from "../version.js";
import { buildAgentDatabaseByCopy } from "./openclaw-agent-db-swap.js";
import { closeOpenClawStateDatabaseByPathAsync } from "./openclaw-state-db-cache.js";
import { buildStateDatabaseByCopy } from "./openclaw-state-db-swap.js";
import {
  insertSetAsideRows,
  UPGRADE_SET_ASIDE_SCOPE,
  type SetAsideRow,
  type SqliteSwapReport,
} from "./sqlite-copy-swap.js";
import {
  discoverDatabases,
  expectedVersion,
  outdatedDatabases,
  postgresInPlaceUpgradeNotice,
  readUpgradeConfig,
  readVersion,
  type DatabaseTarget,
} from "./state-upgrade-databases.js";
import { createDoctorChain, type StateUpgradeChain } from "./state-upgrade-doctor.js";
import {
  APPLIED_UPGRADE_PREFIX as APPLIED_PREFIX,
  UPGRADE_WORK_PREFIX as WORK_PREFIX,
} from "./state-upgrade-receipts.js";
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
    if (!isSqliteFile(file) || readBackupEngine(file).engine === "postgres") {
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
  if (!fs.existsSync(shadowStatePath) || readBackupEngine(shadowStatePath).engine === "postgres") {
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
    const db = openNodeSqliteDatabase(statePath, { readOnly: true });
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

async function finish(
  stateDir: string,
  workDir: string | undefined,
  ownedFiles: ReadonlySet<string>,
  postgres: { config: OpenClawConfig; activeAnchors: string[]; warn: (message: string) => void },
  // A resumed plan's generation is the state it just replaced; it stays like this build's.
  resumedGenerations: ReadonlySet<string> = new Set(),
): Promise<void> {
  await pruneGenerations(
    stateDir,
    generation(),
    new Set([
      ...readPinnedVersions(path.join(stateDir, "state", "openclaw.sqlite")),
      ...resumedGenerations,
    ]),
    ownedFiles,
    postgres,
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

/** Abandoned private anchors are the ownership evidence for their server copies. */
async function discardPrivatePostgres(
  workDir: string,
  stateDir: string,
  config: OpenClawConfig,
  log: { warn: (message: string) => void },
): Promise<boolean> {
  const shadowRoot = path.join(workDir, "state");
  if (!fs.existsSync(shadowRoot)) {
    return true;
  }
  const anchors = listTreeFiles(shadowRoot).filter(
    (file) => isSqliteFile(file) && readBackupEngine(file).engine === "postgres",
  );
  const activeAnchors = anchors
    .map((file) => path.join(stateDir, path.relative(shadowRoot, file)))
    .filter((file) => fs.existsSync(file));
  const activeNamespaces = new Set(
    activeAnchors.flatMap((file) => {
      const engine = readBackupEngine(file);
      return engine.engine === "postgres" ? [engine.namespace] : [];
    }),
  );
  let removed = true;
  for (const anchor of anchors) {
    const engine = readBackupEngine(anchor);
    if (engine.engine !== "postgres" || activeNamespaces.has(engine.namespace)) {
      continue;
    }
    try {
      await retirePostgresUpgrade(anchor, config, activeAnchors);
    } catch (error) {
      removed = false;
      log.warn(
        `Private PostgreSQL recovery data was kept because cleanup could not finish: ${formatErrorMessage(error)}. Run openclaw doctor to inspect retained recovery data.`,
      );
    }
  }
  return removed;
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
      for (const op of plan.ops) {
        if (isSqliteFile(op.live)) {
          const engine = readBackupEngine(op.live);
          if (engine.engine === "postgres") {
            resumedGenerations.add(`trial-${plan.appVersion}-${engine.namespace}`);
          }
        }
      }
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
    if (await discardPrivatePostgres(dir, stateDir, config, params.log)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  const { targets, retainedAgentDirectories } = await discoverDatabases(stateDir, config, env);
  excludedRoots.push(...retainedAgentDirectories);
  const outdated = outdatedDatabases(targets);
  if (outdated.length === 0) {
    if (resumed) {
      await finish(
        stateDir,
        undefined,
        resumedFiles,
        {
          config,
          activeAnchors: targets.map((target) => target.path),
          warn: params.log.warn,
        },
        resumedGenerations,
      );
    }
    return resumed ? { status: "resumed" } : { status: "current" };
  }
  const inPlaceNotice = postgresInPlaceUpgradeNotice(targets);
  if (inPlaceNotice) {
    params.log.warn(inPlaceNotice);
    // Shared PostgreSQL previously bypassed copy-and-swap (its anchor was v0).
    // Normal boot/Doctor still owns that in-place path, including SQLite agents.
    if (targets.some((target) => target.kind === "state" && target.engine === "postgres")) {
      return resumed ? { status: "resumed" } : { status: "current" };
    }
  }
  const postgres = inPlaceNotice ? [] : targets.filter((target) => target.engine === "postgres");
  const sqliteOutdated = outdated.filter((target) => target.engine === "sqlite");
  try {
    // The size decision precedes these copy-only prerequisites.
    if (postgres.length > 0) {
      await preflightPostgresUpgrade(
        postgres.map((target) => target.path),
        config,
      );
    }
  } catch (error) {
    return { status: "refused", reason: formatErrorMessage(error) };
  }
  // A per-attempt name keeps a shadow Doctor orphaned by a crash out of the next attempt.
  const workDir = path.join(stateDir, `${WORK_PREFIX}${generation()}-${process.pid}-${Date.now()}`);
  const shadowRoot = path.join(workDir, "state");
  const configInside = !path.relative(stateDir, configPath).startsWith("..");
  const shadowConfig = configInside
    ? path.join(shadowRoot, path.relative(stateDir, configPath))
    : path.join(workDir, "config", path.basename(configPath));
  const toShadow = (live: string) => path.join(shadowRoot, path.relative(stateDir, live));
  const runChain = params.runChain ?? createDoctorChain();
  const chainLog = path.join(workDir, "chain.log");
  const trialGenerations = new Set<string>();
  const trialAnchors: string[] = [];
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
    if (postgres.length > 0) {
      params.log.info(
        `Preparing a protected PostgreSQL copy for OpenClaw ${VERSION}. The previous data will stay available for recovery.`,
      );
      for (const target of postgres) {
        const anchor = toShadow(target.path);
        const { namespace } = await clonePostgresUpgrade(target.path, anchor, config);
        // Keep cleanup evidence outside the work directory, which frozen
        // launchers remove on rollback even when server cleanup could not run.
        // Namespace identity separates repeated attempts of the same build.
        const trialGeneration = `trial-${generation()}-${namespace}`;
        const preserved = `${target.path}.pre-${trialGeneration}`;
        fs.copyFileSync(anchor, preserved);
        fsyncPath(preserved);
        fsyncPath(path.dirname(preserved), true);
        trialGenerations.add(trialGeneration);
        trialAnchors.push(preserved);
      }
    }
    for (const target of sqliteOutdated) {
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
    const warnings: string[] = inPlaceNotice ? [inPlaceNotice] : [];
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
      validateShadow(sqliteOutdated, toShadow, readVersion, expectedVersion);
      for (const target of postgres) {
        await validatePostgresUpgrade(toShadow(target.path), config, expectedVersion(target));
      }
      mismatches = conservationMismatches(sqliteOutdated, toShadow);
      if (postgres.length > 0 && mismatches.length > 0) {
        throw new Error(`The private SQLite copies lost rows: ${mismatches.join("; ")}`);
      }
    } catch (error) {
      if (postgres.length > 0) {
        throw error;
      }
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
      const fallback = buildFallback(sqliteOutdated, toShadow, workDir);
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
      if (isSqliteFile(file) && readBackupEngine(file).engine === "postgres") {
        continue;
      } else if (isSqliteFile(file)) {
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
            ...sqliteOutdated.map((t) => ({
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
        preserved: `.pre-${generation()}`,
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
    let refusal: string | undefined;
    try {
      refusal = await params.admitConfig?.({ configPath: shadowConfig, stateDir: shadowRoot });
    } finally {
      // Config admission can retain a reader on the successor inode. Retire it before
      // rename: its old shadow pathname cannot find the first live writer's WAL/SHM.
      await closeOpenClawStateDatabaseByPathAsync(toShadow(liveState));
    }
    if (refusal !== undefined) {
      params.log.warn(`State upgrade to ${VERSION} not applied: ${refusal}`);
      return { status: "refused", reason: refusal };
    }
    if (stagedConfig) {
      fs.copyFileSync(shadowConfig, stagedConfig);
      fsyncPath(stagedConfig);
    }
    await params.beforeSwap?.();
    writePlan(workDir, { appVersion: generation(), ops });
    planWritten = true;
    applyPlan({ appVersion: generation(), ops });
    retainAppliedPlan(stateDir, { appVersion: generation(), ops });
    if (fs.existsSync(chainLog)) {
      // The chain's own output stays next to the other logs for diagnosis.
      fs.mkdirSync(path.join(stateDir, "logs"), { recursive: true });
      fs.copyFileSync(chainLog, path.join(stateDir, "logs", `state-upgrade-${VERSION}.log`));
    }
    await finish(
      stateDir,
      workDir,
      new Set(ops.map((op) => op.live).filter((file) => !skip(file))),
      {
        config,
        activeAnchors: targets.map((target) => target.path),
        warn: params.log.warn,
      },
      trialGenerations,
    );
    const summary = `State upgraded to ${VERSION} by ${mode === "chain" ? "migration chain" : "generic copy"}; previous files kept as *.pre-${generation()}.`;
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
      // Private preparation can retry without migrating the protected originals.
      if (postgres.length > 0) {
        return {
          status: "refused",
          reason: `OpenClaw ${VERSION} could not prepare its database: ${formatErrorMessage(error)}. The original PostgreSQL data was not migrated. Run openclaw triage to inspect database preparation before retrying openclaw update.`,
        };
      }
      throw explainMachineFailure(error, stateDir);
    }
    throw error;
  } finally {
    if (!planWritten && (await discardPrivatePostgres(workDir, stateDir, config, params.log))) {
      for (const anchor of trialAnchors) {
        fs.rmSync(anchor, { force: true });
      }
      fs.rmSync(workDir, { recursive: true, force: true });
    }
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
