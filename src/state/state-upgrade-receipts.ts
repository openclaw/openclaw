import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";

const APPLIED_UPGRADE_PREFIX = ".upgraded-";
const UPGRADE_WORK_PREFIX = ".upgrade-";

/** The applied swap plan survives removal of its private copy. Never open a path from its ops. */
export function readAppliedUpgradeShadowRoots(stateDir: string): string[] {
  const roots = new Set<string>();
  const db = path.join("state", "openclaw.sqlite");
  for (const entry of fs.readdirSync(stateDir, { withFileTypes: true })) {
    if (
      !entry.isFile() ||
      !entry.name.startsWith(APPLIED_UPGRADE_PREFIX) ||
      !entry.name.endsWith(".json")
    ) {
      continue;
    }
    // This is the application build/version stamp written by retainAppliedPlan, not a session ID.
    const appVersion = entry.name.slice(APPLIED_UPGRADE_PREFIX.length, -5);
    try {
      const plan: unknown = JSON.parse(fs.readFileSync(path.join(stateDir, entry.name), "utf8"));
      if (!isRecord(plan) || plan.appVersion !== appVersion || !Array.isArray(plan.ops)) {
        continue;
      }
      for (const op of plan.ops) {
        if (
          !isRecord(op) ||
          op.kind !== "replace" ||
          op.live !== path.join(stateDir, db) ||
          typeof op.next !== "string"
        ) {
          continue;
        }
        const [work] = path.relative(stateDir, op.next).split(path.sep);
        const prefix = `${UPGRADE_WORK_PREFIX}${appVersion}-`;
        if (!work?.startsWith(prefix) || !/^\d+-\d+$/.test(work.slice(prefix.length))) {
          continue;
        }
        const root = path.join(stateDir, work, "state");
        if (op.next === path.join(root, db)) {
          roots.add(root);
        }
      }
    } catch {
      // An unreadable or interrupted receipt proves nothing about a saved account.
    }
  }
  return [...roots];
}
