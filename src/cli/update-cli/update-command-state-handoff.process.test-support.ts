// Stand-in for a Git release successor's boot upgrade: build the next shared state file
// from the live one, then replace it with the boot upgrade's own swap primitive.
import { DatabaseSync } from "node:sqlite";
import { applyPlan, companionRemovals, type UpgradeOp } from "../../state/state-upgrade-tree.js";

const [live] = process.argv.slice(2);
if (!live) {
  throw new Error("Expected the live shared state database path");
}
const next = `${live}.successor`;
const source = new DatabaseSync(live, { readOnly: true });
try {
  source.exec(`VACUUM INTO '${next.replaceAll("'", "''")}'`);
} finally {
  source.close();
}
const ops: UpgradeOp[] = [{ kind: "replace", live, next }];
ops.push(...companionRemovals(ops));
applyPlan({ appVersion: "successor", ops });
