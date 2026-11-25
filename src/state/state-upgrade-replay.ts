// Settlement only for durable copy-and-swap plans written by shipped releases.
// New upgrades never create a work tree or a plan.
import fs from "node:fs";
import path from "node:path";
import { acquireGatewayLock } from "../infra/gateway-lock.js";
import { retireSqliteDatabaseAdmissionForPath } from "../infra/sqlite-database-admission.js";
import { closeOpenClawAgentDatabasesAsync } from "./openclaw-agent-db-lifecycle.js";
import { closeOpenClawStateDatabaseAsync } from "./openclaw-state-db-cache.js";
import { APPLIED_UPGRADE_PREFIX, UPGRADE_WORK_PREFIX } from "./state-upgrade-receipts.js";

type UpgradeOp = {
  live: string;
  next?: string;
  kind: "replace" | "add" | "remove";
};

type UpgradePlan = { appVersion: string; ops: UpgradeOp[] };

const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "latin1");

function fsyncPath(pathname: string, directory = false): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(pathname, directory ? "r" : "r+");
    fs.fsyncSync(fd);
  } catch (error) {
    // Windows cannot open directories for fsync; the rename is still durable there.
    // SAFETY: node:fs throws Error instances; only optional fields are read.
    const code = (error as NodeJS.ErrnoException).code;
    if (!(directory && (code === "EISDIR" || code === "EPERM" || code === "EACCES"))) {
      throw error;
    }
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
}

function isSqliteFile(pathname: string): boolean {
  let fd: number | undefined;
  try {
    fd = fs.openSync(pathname, "r");
    const header = Buffer.alloc(SQLITE_HEADER.length);
    return (
      fs.readSync(fd, header, 0, header.length, 0) === header.length && header.equals(SQLITE_HEADER)
    );
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
}

function readPlan(workDir: string): UpgradePlan | undefined {
  try {
    // SAFETY: shipped writePlan is the writer of this historical file format.
    return JSON.parse(fs.readFileSync(path.join(workDir, "plan.json"), "utf8")) as UpgradePlan;
  } catch {
    return undefined;
  }
}

function isSymlinkAt(pathname: string): boolean {
  try {
    return fs.lstatSync(pathname).isSymbolicLink();
  } catch {
    return false;
  }
}

function preserve(live: string, preserved: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(live);
  } catch {
    return;
  }
  if (fs.existsSync(preserved) || isSymlinkAt(preserved)) {
    return;
  }
  if (stat.isSymbolicLink()) {
    fs.symlinkSync(fs.readlinkSync(live), preserved);
  } else {
    // A hard link keeps the old bytes under the preserved name without a copy.
    fs.linkSync(live, preserved);
  }
}

/** Create missing live parents with the modes the chain gave them in the shadow, not the umask. */
function mkdirLike(live: string, shadow: string): void {
  if (fs.existsSync(live)) {
    return;
  }
  mkdirLike(path.dirname(live), path.dirname(shadow));
  fs.mkdirSync(live);
  fs.chmodSync(live, fs.statSync(shadow).mode & 0o7777);
}

/** The shipped idempotent applyPlan; only an already durable plan can reach it. */
function applyPlan(plan: UpgradePlan): void {
  const directories = new Set<string>();
  // Retire old companions before any database name changes owner.
  const ordered = [
    ...plan.ops.filter((op) => op.kind === "remove"),
    ...plan.ops.filter((op) => op.kind !== "remove"),
  ];
  for (const op of ordered) {
    directories.add(path.dirname(op.live));
    if (op.next && isSqliteFile(op.next)) {
      // Native close retains admission's identity descriptor. Windows cannot
      // replace either file until the joined swap owner releases that custody.
      retireSqliteDatabaseAdmissionForPath(op.live);
      retireSqliteDatabaseAdmissionForPath(op.next);
    }
    // Shared-memory and seal files are rebuilt on open; they carry no data.
    if (op.kind !== "add" && !/-shm$|\.seal$/u.test(op.live)) {
      preserve(op.live, `${op.live}.pre-${plan.appVersion}`);
    }
    if (op.kind === "remove") {
      fs.rmSync(op.live, { force: true });
    } else if (op.next && (fs.existsSync(op.next) || isSymlinkAt(op.next))) {
      mkdirLike(path.dirname(op.live), path.dirname(op.next));
      fs.renameSync(op.next, op.live);
    }
  }
  for (const directory of directories) {
    fsyncPath(directory, true);
  }
}

function retainAppliedPlan(stateDir: string, plan: UpgradePlan): void {
  const file = path.join(stateDir, `${APPLIED_UPGRADE_PREFIX}${plan.appVersion}.json`);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(plan), { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}

/** Finish prior durable intent before config guards or SQL-based owner inspection. */
export async function replayInterruptedStateUpgrade(
  env: NodeJS.ProcessEnv,
  stateDir: string,
  log: { info: (message: string) => void },
): Promise<void> {
  if (!fs.existsSync(stateDir)) {
    return;
  }
  const workDirs = fs
    .readdirSync(stateDir)
    .filter((entry) => entry.startsWith(UPGRADE_WORK_PREFIX))
    .map((entry) => path.join(stateDir, entry));
  if (!workDirs.some((dir) => readPlan(dir))) {
    return;
  }
  // The old physical/config-only owner does not inspect a tree whose WAL may
  // already be retired. Ordinary maintenance may inspect SQL only after settlement.
  const lock = await acquireGatewayLock({ env, databaseAccess: "none", allowInTests: true });
  try {
    await lock?.run(async () => {
      await closeOpenClawStateDatabaseAsync();
      await closeOpenClawAgentDatabasesAsync();
      for (const dir of workDirs) {
        const plan = readPlan(dir);
        if (!plan) {
          continue;
        }
        lock.assertCurrent();
        applyPlan(plan);
        // Historical inference-account repair still uses the original shadow root.
        retainAppliedPlan(stateDir, plan);
        fs.rmSync(dir, { recursive: true, force: true });
        log.info(`Finished an interrupted state upgrade to ${plan.appVersion}.`);
      }
    });
  } finally {
    await lock?.release();
  }
}
