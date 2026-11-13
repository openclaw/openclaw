// Copy-and-swap state upgrade. Gateway startup is the only owner.
//
// When a shared or agent database is older than this build, the whole state
// directory is copied into a private shadow. The shipped migration chain (this
// build's Doctor) runs on the shadow only. The result is validated, written to a
// durable plan, and renamed into place; every replaced or retired live file stays
// as `<name>.pre-<version>`. The live files are never written before the plan is
// durable. If the chain fails, the generic name-matched rebuild produces the
// databases instead and the previous generation is pinned. Data never blocks the
// upgrade; only machine failures (disk full, I/O, crash) stop it, and a crash
// before the plan leaves the live tree untouched.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { resolveConfigPath, resolveStateDir } from "../config/paths.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { VERSION } from "../version.js";
import { createAgentSwapTarget } from "./openclaw-agent-db-swap.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-schema-versions.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import { CONTENT_VERSION_KEY } from "./openclaw-state-db-schema-version.js";
import { buildStateDatabaseByCopy } from "./openclaw-state-db-swap.js";
import {
  buildSqliteByCopy,
  insertSetAsideRows,
  UPGRADE_SET_ASIDE_SCOPE,
  type SetAsideRow,
  type SqliteSwapReport,
} from "./sqlite-copy-swap.js";
import {
  applyPlan,
  companionRemovals,
  copyTree,
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
} from "./state-upgrade-tree.js";
import {
  ChainStepError,
  conservationMismatches,
  validateShadow,
} from "./state-upgrade-validate.js";

export const UPGRADE_REPORT_SCOPE = "upgrade.report";
const UPGRADE_PIN_SCOPE = "upgrade.pin";
const WORK_PREFIX = ".upgrade-";
const CHAIN_TIMEOUT_MS = 30 * 60_000;
/** Test seam: names a chain step to fail so the fallback path can be proven end to end. */
export const STATE_UPGRADE_FAIL_STEP_ENV = "OPENCLAW_TEST_STATE_UPGRADE_FAIL_STEP";
/** Test seam: `SIGKILL` this process right after the named durable step (crash proof). */
export const STATE_UPGRADE_CRASH_AFTER_ENV = "OPENCLAW_TEST_STATE_UPGRADE_CRASH_AFTER";

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
  | { status: "resumed" };

export type StateUpgradeChain = (params: {
  stateDir: string;
  configPath: string;
  env: NodeJS.ProcessEnv;
  logPath: string;
}) => Promise<{ warnings: string[] }>;

function readVersion(db: DatabaseSync, kind: DatabaseTarget["kind"]): number {
  const user = Number(
    (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
  );
  if (kind !== "state") {
    return user;
  }
  try {
    const row = db
      .prepare("SELECT value_json FROM config_machine_state WHERE state_key = ?")
      .get(CONTENT_VERSION_KEY) as { value_json?: string } | undefined;
    return Math.max(user, Number(row?.value_json ?? 0) || 0);
  } catch {
    return user;
  }
}

function openReadOnly(pathname: string): DatabaseSync {
  const { DatabaseSync } = requireNodeSqlite();
  return new DatabaseSync(pathname, { readOnly: true });
}

function discoverDatabases(stateDir: string): DatabaseTarget[] {
  const targets: DatabaseTarget[] = [];
  const add = (kind: DatabaseTarget["kind"], pathname: string, agentId?: string) => {
    if (!isSqliteFile(pathname)) {
      return;
    }
    const db = openReadOnly(pathname);
    try {
      targets.push({ kind, agentId, path: pathname, version: readVersion(db, kind) });
    } finally {
      db.close();
    }
  };
  add("state", path.join(stateDir, "state", "openclaw.sqlite"));
  let agents: string[] = [];
  try {
    agents = fs.readdirSync(path.join(stateDir, "agents"));
  } catch {
    // No agents yet.
  }
  for (const agentId of agents) {
    add("agent", path.join(stateDir, "agents", agentId, "agent", "openclaw-agent.sqlite"), agentId);
  }
  return targets;
}

const expectedVersion = (target: Pick<DatabaseTarget, "kind">) =>
  target.kind === "state" ? OPENCLAW_STATE_SCHEMA_VERSION : OPENCLAW_AGENT_SCHEMA_VERSION;

function readConfiguredWorkspaces(configPath: string, stateDir: string): string[] {
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      agents?: { defaults?: { workspace?: unknown }; list?: Array<{ workspace?: unknown }> };
    };
    return [
      config.agents?.defaults?.workspace,
      ...(config.agents?.list ?? []).map((a) => a.workspace),
    ]
      .filter((value): value is string => typeof value === "string" && path.isAbsolute(value))
      .map((value) => path.resolve(value));
  } catch {
    return [path.join(stateDir, "workspace")];
  }
}

/** This build's Doctor, run against the shadow only. */
export const runDoctorChain: StateUpgradeChain = async ({ stateDir, configPath, env, logPath }) => {
  const entry = process.argv[1];
  if (!entry) {
    throw new ChainStepError("doctor", "Cannot locate the OpenClaw entry point for Doctor.");
  }
  const childEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    // Service identity and tokens belong to the live Gateway, not the shadow run.
    if (!/^OPENCLAW_(LAUNCHD_LABEL|PROFILE|SERVICE_|GATEWAY_TOKEN|GATEWAY_PASSWORD)/u.test(key)) {
      childEnv[key] = value;
    }
  }
  Object.assign(childEnv, {
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_SERVICE_REPAIR_POLICY: "external",
    OPENCLAW_NO_RESPAWN: "1",
  });
  const log = fs.openSync(logPath, "a", 0o600);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [...process.execArgv, entry, "doctor", "--fix", "--non-interactive"],
        { env: childEnv, stdio: ["ignore", log, log] },
      );
      const timer = setTimeout(() => child.kill("SIGKILL"), CHAIN_TIMEOUT_MS);
      child.on("error", reject);
      child.on("exit", (exitCode) => {
        clearTimeout(timer);
        resolve(exitCode);
      });
    });
    // Doctor also reports unrelated repairs; the schema check below decides success.
    return { warnings: code === 0 ? [] : [`Doctor exited ${code ?? "by signal"}; see ${logPath}`] };
  } finally {
    fs.closeSync(log);
  }
};

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
    if (target.kind === "agent") {
      reports.push(buildSqliteByCopy(createAgentSwapTarget(target.agentId!), target.path, out));
      continue;
    }
    const state = buildStateDatabaseByCopy(target.path, out, scratchDir);
    reports.push(state.report);
    foldInFailures.push(...state.foldInFailures);
  }
  return { reports, foldInFailures };
}

function checkpointShadowDatabases(shadowRoot: string): void {
  const { DatabaseSync } = requireNodeSqlite();
  for (const file of listTreeFiles(shadowRoot)) {
    if (!isSqliteFile(file)) {
      continue;
    }
    const db = new DatabaseSync(file);
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
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(shadowStatePath);
  try {
    const now = Date.now();
    const insert = db.prepare(
      "INSERT OR REPLACE INTO diagnostic_events (scope, event_key, payload_json, created_at, sequence) VALUES (?, ?, ?, ?, ?)",
    );
    insert.run(UPGRADE_REPORT_SCOPE, `${VERSION}:${now}`, JSON.stringify(report), now, now);
    if (pinned) {
      insert.run(UPGRADE_PIN_SCOPE, VERSION, JSON.stringify({ version: VERSION }), now, now);
    }
    for (const entry of setAside) {
      insertSetAsideRows(db, { ...entry.report, previousFile: `.pre-${VERSION}` }, entry.rows, now);
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

function finish(stateDir: string, workDir: string | undefined, skip: (p: string) => boolean): void {
  pruneGenerations(
    stateDir,
    VERSION,
    readPinnedVersions(path.join(stateDir, "state", "openclaw.sqlite")),
    skip,
  );
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
  /** Fault-injection seam for crash tests: called after each durable step. */
  afterStep?: (step: string) => void;
}): Promise<StateUpgradeResult> {
  const env = params.env;
  const stateDir = path.resolve(resolveStateDir(env));
  const configPath = path.resolve(resolveConfigPath(env, stateDir));
  const crashAfter = env[STATE_UPGRADE_CRASH_AFTER_ENV]?.trim();
  const step = (name: string) => {
    params.afterStep?.(name);
    if (crashAfter === name) {
      process.kill(process.pid, "SIGKILL");
    }
  };
  if (!fs.existsSync(stateDir)) {
    return { status: "current" };
  }
  const workspaces = readConfiguredWorkspaces(configPath, stateDir);
  const skip = (absolute: string) => {
    const relative = path.relative(stateDir, absolute);
    const top = relative.split(path.sep)[0] ?? "";
    return (
      top.startsWith(WORK_PREFIX) ||
      top === "locks" ||
      top === "tmp" ||
      workspaces.some((dir) => absolute === dir || absolute.startsWith(`${dir}${path.sep}`))
    );
  };
  // A durable plan from an interrupted swap is finished before anything else.
  let resumed = false;
  for (const entry of fs.readdirSync(stateDir)) {
    if (!entry.startsWith(WORK_PREFIX)) {
      continue;
    }
    const dir = path.join(stateDir, entry);
    const plan = readPlan(dir);
    if (plan) {
      applyPlan(plan);
      params.log.info(`Finished an interrupted state upgrade to ${plan.appVersion}.`);
      resumed = true;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const outdated = discoverDatabases(stateDir).filter(
    (target) => target.version < expectedVersion(target),
  );
  if (outdated.length === 0) {
    if (resumed) {
      finish(stateDir, undefined, skip);
    }
    return resumed ? { status: "resumed" } : { status: "current" };
  }
  // A per-attempt name keeps a shadow Doctor orphaned by a crash out of the next attempt.
  const workDir = path.join(stateDir, `${WORK_PREFIX}${VERSION}-${process.pid}-${Date.now()}`);
  const shadowRoot = path.join(workDir, "state");
  const configInside = !path.relative(stateDir, configPath).startsWith("..");
  const shadowConfig = configInside
    ? path.join(shadowRoot, path.relative(stateDir, configPath))
    : path.join(workDir, "config", path.basename(configPath));
  const toShadow = (live: string) => path.join(shadowRoot, path.relative(stateDir, live));
  const runChain = params.runChain ?? runDoctorChain;
  const chainLog = path.join(workDir, "chain.log");
  let planWritten = false;
  try {
    fs.mkdirSync(workDir, { recursive: true, mode: 0o700 });
    params.log.info(
      `Upgrading state to ${VERSION}: ${outdated.map((t) => `${path.relative(stateDir, t.path)} v${t.version}`).join(", ")}`,
    );
    copyTree(stateDir, shadowRoot, skip);
    if (!configInside && fs.existsSync(configPath)) {
      fs.mkdirSync(path.dirname(shadowConfig), { recursive: true });
      fs.copyFileSync(configPath, shadowConfig);
    }
    for (const target of outdated) {
      const { DatabaseSync } = requireNodeSqlite();
      const db = new DatabaseSync(toShadow(target.path));
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
    step("copied");
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
      const injected = env[STATE_UPGRADE_FAIL_STEP_ENV]?.trim();
      if (injected) {
        throw new ChainStepError(injected, `Injected failure in ${injected}`);
      }
      validateShadow(outdated, toShadow, readVersion, expectedVersion);
      mismatches = conservationMismatches(outdated, toShadow);
    } catch (error) {
      if (!(error instanceof ChainStepError) && isMachineFailure(error)) {
        throw error;
      }
      mode = "fallback";
      failedStep = error instanceof ChainStepError ? error.step : "chain";
      params.log.warn(
        `State upgrade chain failed at ${failedStep}: ${(error as Error).message}. Rebuilding the databases with the generic copy; the previous files are kept and pinned.`,
      );
      // Keep what the chain finished outside the databases it upgrades: the migrated
      // config and new stores it moved data into (client credentials, services).
      const kept = path.join(workDir, "kept");
      const keep = [
        shadowConfig,
        ...listTreeFiles(shadowRoot).filter(
          (file) =>
            isSqliteFile(file) &&
            !fs.existsSync(path.join(stateDir, path.relative(shadowRoot, file))),
        ),
      ].filter((file) => fs.existsSync(file));
      for (const file of keep) {
        const target = path.join(kept, path.relative(workDir, file));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.renameSync(file, target);
      }
      fs.rmSync(shadowRoot, { recursive: true, force: true });
      const fallback = buildFallback(outdated, toShadow, workDir);
      for (const file of keep) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.renameSync(path.join(kept, path.relative(workDir, file)), file);
        if (file !== shadowConfig) {
          fallbackAdds.push({
            kind: "add",
            live: path.join(stateDir, path.relative(shadowRoot, file)),
            next: file,
          });
        }
      }
      warnings.push(...fallback.foldInFailures);
      for (const report of fallback.reports) {
        setAside.push({ report, rows: report.setAside });
        mismatches.push(...report.conservationMismatches.map((t) => `${report.label}:${t}`));
      }
    }
    step("built");
    // Paths the run wrote into the shadow point at the live tree again.
    for (const file of listTreeFiles(shadowRoot)) {
      if (isSqliteFile(file)) {
        const { DatabaseSync } = requireNodeSqlite();
        const db = new DatabaseSync(file);
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
        preserved: `.pre-${VERSION}`,
        pinned,
      },
      setAside,
      pinned,
    );
    checkpointShadowDatabases(shadowRoot);
    const ops: UpgradeOp[] =
      mode === "chain"
        ? diffTree(stateDir, shadowRoot, skip)
        : [
            ...outdated.map((t) => ({
              kind: "replace" as const,
              live: t.path,
              next: toShadow(t.path),
            })),
            ...fallbackAdds,
          ];
    if (mode === "fallback" && configInside && fs.existsSync(shadowConfig)) {
      const original = fs.existsSync(configPath) ? fs.readFileSync(configPath) : undefined;
      if (!original?.equals(fs.readFileSync(shadowConfig))) {
        ops.push({ kind: original ? "replace" : "add", live: configPath, next: shadowConfig });
      }
    }
    if (!configInside && fs.existsSync(shadowConfig)) {
      const original = fs.existsSync(configPath) ? fs.readFileSync(configPath) : undefined;
      if (!original?.equals(fs.readFileSync(shadowConfig))) {
        ops.push({ kind: original ? "replace" : "add", live: configPath, next: shadowConfig });
      }
    }
    ops.push(...companionRemovals(ops));
    for (const op of ops) {
      if (op.next && fs.statSync(op.next, { throwIfNoEntry: false })?.isFile()) {
        fsyncPath(op.next);
      }
    }
    writePlan(workDir, { appVersion: VERSION, ops });
    planWritten = true;
    step("planned");
    applyPlan({ appVersion: VERSION, ops }, (index) => step(`applied-${index}`));
    step("applied");
    if (fs.existsSync(chainLog)) {
      // The chain's own output stays next to the other logs for diagnosis.
      fs.mkdirSync(path.join(stateDir, "logs"), { recursive: true });
      fs.copyFileSync(chainLog, path.join(stateDir, "logs", `state-upgrade-${VERSION}.log`));
    }
    finish(stateDir, workDir, skip);
    const summary = `State upgraded to ${VERSION} by ${mode === "chain" ? "migration chain" : "generic copy"}; previous files kept as *.pre-${VERSION}.`;
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
      if (isMachineFailure(error)) {
        throw new Error(
          `State upgrade to ${VERSION} stopped: ${(error as Error).message}. Nothing in ${stateDir} was changed. Free disk space (about the size of the state directory) and start the Gateway again.`,
          { cause: error },
        );
      }
    }
    throw error;
  }
}

function isMachineFailure(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return (
    code === "ENOSPC" ||
    code === "EIO" ||
    code === "EDQUOT" ||
    code === "EROFS" ||
    /SQLITE_FULL|database or disk is full|disk I\/O error/iu.test(String((error as Error)?.message))
  );
}
