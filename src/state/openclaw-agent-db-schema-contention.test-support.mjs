import { DatabaseSync } from "node:sqlite";

const agent = new DatabaseSync(process.argv[2]);
const shared = new DatabaseSync(process.argv[3]);
agent.exec("BEGIN IMMEDIATE");
shared.exec("PRAGMA busy_timeout = 100");
process.send?.("ready");
process.once("message", () => {
  let outcome;
  try {
    agent.exec("INSERT INTO auth_profile_state VALUES ('schema-lock-order', '{}', 1)");
    shared.exec("BEGIN IMMEDIATE");
    shared.exec("INSERT INTO config_machine_state VALUES ('schema-lock-order', '{}', 1)");
    shared.exec("COMMIT");
    agent.exec("COMMIT");
    outcome = { status: "committed" };
  } catch (error) {
    if (shared.isTransaction) {
      shared.exec("ROLLBACK");
    }
    if (agent.isTransaction) {
      agent.exec("ROLLBACK");
    }
    outcome = { status: "blocked", message: String(error) };
  } finally {
    shared.close();
    agent.close();
  }
  process.send?.(outcome, () => process.disconnect?.());
});
