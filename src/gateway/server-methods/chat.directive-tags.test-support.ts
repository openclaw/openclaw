import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { drainAgentDatabaseResources } from "../../state/openclaw-agent-db-resources.js";
import {
  disposeOpenClawAgentDatabaseByPath,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../../state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";

export function createChatDirectiveSuiteResources() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-chat-directive-suite-"));
  const databasePath = path.join(root, "openclaw-agent.sqlite");
  const env = { ...process.env, OPENCLAW_STATE_DIR: root };
  return {
    root,
    databasePath,
    env,
    // The caller retains cleanup ownership before opening can fail.
    open() {
      openOpenClawAgentDatabase({ agentId: "main", env, path: databasePath });
    },
    async close() {
      await drainAgentDatabaseResources({ path: databasePath, agentId: "main" }, async () =>
        disposeOpenClawAgentDatabaseByPath(databasePath, { env }),
      );
      await closeOpenClawStateDatabaseByPathAsync(resolveOpenClawStateSqlitePath(env));
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
