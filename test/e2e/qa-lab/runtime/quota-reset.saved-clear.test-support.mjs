import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const [databasePath, profileId, configPath, busyTimeout] = process.argv.slice(2);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const database = new DatabaseSync(databasePath, { timeout: Number(busyTimeout) });
try {
  database.exec("BEGIN IMMEDIATE");
  const readCell = database.prepare(
    "SELECT value_json FROM config_machine_state WHERE state_key = ?",
  );
  const before = JSON.parse(readCell.get("authProfiles.state").value_json);
  const credentialsBefore = digest(readCell.get("authProfiles.store").value_json);
  const configBefore = digest(readFileSync(configPath));
  const after = structuredClone(before);
  const usage = after.usageStats[profileId];
  if (usage.blockedReason !== "subscription_limit" || !usage.blockedUntil) {
    throw new Error("Saved-only repair requires an existing provider-created quota block.");
  }
  delete usage.blockedUntil;
  delete usage.blockedReason;
  delete usage.blockedSource;
  delete usage.blockedModel;
  delete usage.blockedScope;
  // sqlite-allow-raw -- Reproduce an external manual repair of this test-owned saved row.
  database
    .prepare("UPDATE config_machine_state SET value_json = ? WHERE state_key = ?")
    .run(JSON.stringify(after), "authProfiles.state");
  database.exec("COMMIT");
  console.log(
    JSON.stringify({
      pid: process.pid,
      before,
      after: JSON.parse(readCell.get("authProfiles.state").value_json),
      credentialsBefore,
      credentialsAfter: digest(readCell.get("authProfiles.store").value_json),
      configBefore,
      configAfter: digest(readFileSync(configPath)),
    }),
  );
} finally {
  if (database.isTransaction) {
    database.exec("ROLLBACK");
  }
  database.close();
}
