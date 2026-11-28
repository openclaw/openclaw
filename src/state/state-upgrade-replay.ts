// Settle durable copy-and-swap intent before any reader opens the selected state.
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { hasErrnoCode } from "../infra/errno.js";
import { readPlan, UPGRADE_PLAN_FILE } from "./state-upgrade-plan.js";

export const UPGRADE_WORK_PREFIX = ".upgrade-";

function listUpgradeWorkDirs(stateDir: string): string[] {
  try {
    return fs
      .readdirSync(stateDir, { withFileTypes: true })
      .filter((entry) => entry.name.startsWith(UPGRADE_WORK_PREFIX) && entry.isDirectory())
      .map((entry) => path.join(stateDir, entry.name));
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return [];
    }
    throw error;
  }
}

export function hasInterruptedStateUpgrade(stateDir: string): boolean {
  // lstat distinguishes a missing plan from a broken link or unreadable file.
  return listUpgradeWorkDirs(stateDir).some((dir) =>
    fs.lstatSync(path.join(dir, UPGRADE_PLAN_FILE), { throwIfNoEntry: false }),
  );
}

/** Caller holds exclusive file custody. Re-read and validate all plans before applying any. */
export async function replayInterruptedStateUpgradesUnderLock(params: {
  stateDir: string;
  log: { info: (message: string) => void };
  beforeSwap?: () => Promise<void>;
  assertCurrent?: () => void;
}): Promise<Set<string> | undefined> {
  params.assertCurrent?.();
  const plans = listUpgradeWorkDirs(params.stateDir).flatMap((dir) => {
    const plan = readPlan(dir);
    return plan ? [{ dir, plan }] : [];
  });
  if (plans.length === 0) {
    return undefined;
  }
  const resumedFiles = new Set<string>();
  const { applyPlan } = await import("./state-upgrade-tree.js");
  await params.beforeSwap?.();
  for (const { dir, plan } of plans) {
    params.assertCurrent?.();
    applyPlan(plan);
    fs.rmSync(dir, { recursive: true, force: true });
    for (const op of plan.ops) {
      resumedFiles.add(op.live);
    }
  }
  // Logging can resolve config settings; do it only after every swap is settled.
  for (const { plan } of plans) {
    params.log.info(`Finished an interrupted state upgrade to ${plan.appVersion}.`);
  }
  return resumedFiles;
}

export async function settleInterruptedStateUpgrade(env: NodeJS.ProcessEnv): Promise<void> {
  const stateDir = path.resolve(resolveStateDir(env));
  if (!hasInterruptedStateUpgrade(stateDir)) {
    return;
  }
  const [{ acquireGatewayLock }, { createSubsystemLogger }, stateDb, agentDb] = await Promise.all([
    import("../infra/gateway-lock.js"),
    import("../logging/subsystem.js"),
    import("./openclaw-state-db-cache.js"),
    import("./openclaw-agent-db-lifecycle.js"),
  ]);
  // Acquiring ordinary Gateway custody could inspect a DB with its WAL already retired.
  const lock = await acquireGatewayLock({ env, databaseAccess: "none", allowInTests: true });
  if (!lock) {
    throw new Error("Cannot settle interrupted state upgrade without Gateway file ownership");
  }
  try {
    await lock.run(() =>
      replayInterruptedStateUpgradesUnderLock({
        stateDir,
        log: createSubsystemLogger("state/upgrade"),
        assertCurrent: lock.assertCurrent,
        beforeSwap: async () => {
          await stateDb.closeOpenClawStateDatabaseAsync();
          await agentDb.closeOpenClawAgentDatabasesAsync();
        },
      }),
    );
  } finally {
    await lock.release();
  }
}
