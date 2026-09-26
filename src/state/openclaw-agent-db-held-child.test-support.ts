import fs from "node:fs";
import path from "node:path";
import {
  closeOpenClawAgentDatabases,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "./openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "./openclaw-state-db.js";

const options = {
  agentId: process.argv[2] ?? "worker",
  path: process.argv[3] || undefined,
};
const fixtureRoot = process.argv[4];
if (fixtureRoot) {
  const root = process.env.OPENCLAW_STATE_DIR;
  if (!root || !path.isAbsolute(root) || fs.realpathSync.native(root) !== fixtureRoot) {
    throw new Error("Held database fixture requires its explicit private state root");
  }
  const databasePath = resolveOpenClawAgentSqlitePath(options);
  const relative = path.relative(fixtureRoot, fs.realpathSync.native(databasePath));
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("Held database fixture must stay inside its private state root");
  }
}
openOpenClawAgentDatabase(options);
process.send?.("ready");
process.once("message", () => {
  closeOpenClawAgentDatabases();
  closeOpenClawStateDatabaseForTest();
  process.disconnect?.();
});
