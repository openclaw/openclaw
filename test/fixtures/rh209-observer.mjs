import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const [stateDir, phase] = process.argv.slice(2);
assert.ok(stateDir && ["before", "after"].includes(phase));
const config = JSON.parse(fs.readFileSync(path.join(stateDir, "openclaw.json"), "utf8"));
const db = new DatabaseSync(path.join(stateDir, "state", "openclaw.sqlite"), { readOnly: true });
let pending;
try {
  pending = db
    .prepare(
      "SELECT report_json FROM migration_runs WHERE id LIKE 'deferred-plugin-migration:%' AND status = 'pending' ORDER BY id",
    )
    .all()
    .map((row) => JSON.parse(row.report_json));
} finally {
  db.close();
}
assert.equal(pending.length, 1);
const [{ reason, command, ...inputs }] = pending;
assert.deepEqual(inputs, {
  pluginId: "rh209-guidance-fixture",
  requiresStateMigration: true,
  configPaths: [["plugins", "entries", "rh209-guidance-fixture", "config"]],
});
const heartbeat = config.agents.defaults.heartbeat;
assert.deepEqual(Object.keys(config.agents.entries).toSorted(), ["main", "worker"]);
assert.deepEqual(config.plugins.entries["rh209-guidance-fixture"].config, { region: "us-en" });
if (phase === "before") {
  assert.deepEqual(heartbeat, { agentId: "main", every: "30m", skipWhenBusy: true });
  assert.equal(command, "openclaw update repair");
  assert.equal(
    reason,
    "Package convergence must wait until the updating parent releases its install records.",
  );
} else {
  assert.deepEqual(heartbeat, { agentId: "main", every: "30m" });
  assert.equal(command, "openclaw doctor --fix");
  assert.match(reason, /has not confirmed/);
}
console.log(JSON.stringify({ pid: process.pid, heartbeat, pending }));
