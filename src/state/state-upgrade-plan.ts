import fs from "node:fs";
import path from "node:path";

export const UPGRADE_PLAN_FILE = "plan.json";

export type UpgradeOp = {
  /** Live path to replace, create or retire. */
  live: string;
  /** Prepared file to rename into place; absent for `remove`. */
  next?: string;
  kind: "replace" | "add" | "remove";
};

export type UpgradePlan = { appVersion: string; ops: UpgradeOp[] };

function isPlanPath(value: unknown): value is string {
  return typeof value === "string" && path.isAbsolute(value) && !value.includes("\0");
}

function isUpgradeOp(value: unknown): value is UpgradeOp {
  if (!value || typeof value !== "object" || !("live" in value) || !isPlanPath(value.live)) {
    return false;
  }
  const next = "next" in value ? value.next : undefined;
  return (
    "kind" in value &&
    (value.kind === "remove"
      ? next === undefined
      : (value.kind === "replace" || value.kind === "add") && isPlanPath(next))
  );
}

export function readPlan(workDir: string): UpgradePlan | undefined {
  const file = path.join(workDir, UPGRADE_PLAN_FILE);
  try {
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!stat) {
      return undefined;
    }
    if (!stat.isFile()) {
      throw new Error("expected a regular file");
    }
    const plan: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (
      !plan ||
      typeof plan !== "object" ||
      !("appVersion" in plan) ||
      typeof plan.appVersion !== "string" ||
      !/^[\w.+-]+$/u.test(plan.appVersion) ||
      !("ops" in plan) ||
      !Array.isArray(plan.ops) ||
      !plan.ops.every(isUpgradeOp)
    ) {
      throw new Error("invalid upgrade plan");
    }
    return { appVersion: plan.appVersion, ops: plan.ops };
  } catch (error) {
    throw new Error(
      `Cannot read interrupted state upgrade plan ${file}; retained for recovery. Gateway startup refused.`,
      { cause: error },
    );
  }
}
