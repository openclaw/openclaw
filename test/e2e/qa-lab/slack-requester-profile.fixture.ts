import path from "node:path";
import { closeOpenClawStateDatabaseAsync } from "../../../src/state/openclaw-state-db.js";
import { ensureProfileForEmail } from "../../../src/state/user-profiles.js";

const [stateDir, tempRoot] = process.argv.slice(2);
if (
  !stateDir ||
  !tempRoot ||
  process.env.OPENCLAW_STATE_DIR !== stateDir ||
  path.resolve(stateDir) !== path.join(path.resolve(tempRoot), "state") ||
  !path.basename(tempRoot).startsWith("openclaw-qa-suite-")
) {
  throw new Error("Requester fixture requires the stopped QA Gateway's isolated state directory");
}

// Only seed the personal profile prerequisite; the running Gateway owns role and link changes.
try {
  const profile = ensureProfileForEmail("slack-requester@example.test", { env: process.env });
  process.stdout.write(`${JSON.stringify({ id: profile.id })}\n`);
} finally {
  await closeOpenClawStateDatabaseAsync();
}
