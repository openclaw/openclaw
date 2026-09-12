// Gateway agent database backup command.
// Creates a manual backup of an agent's SQLite database before schema migration.
import path from "node:path";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import {
  createAgentDbAutoBackup,
  resolveAgentDbBackupDir,
} from "../../state/openclaw-agent-db-safety.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const backupLog = createSubsystemLogger("cli/backup");

export type AgentDbBackupOptions = {
  agentId?: string;
  json?: boolean;
};

export async function runAgentDbBackup(options: AgentDbBackupOptions): Promise<void> {
  const { agentId, json } = options;

  if (!agentId) {
    const message =
      "Agent name is required. Use: openclaw gateway backup --agent <name>";
    if (json) {
      console.log(JSON.stringify({ ok: false, error: message }));
    } else {
      console.error(message);
    }
    process.exitCode = 1;
    return;
  }

  const dbPath = resolveOpenClawAgentSqlitePath({ agentId });
  const agentStateDir = path.dirname(dbPath);
  const backupDir = resolveAgentDbBackupDir(agentStateDir);

  const backupPath = createAgentDbAutoBackup(dbPath, agentStateDir);

  if (!backupPath) {
    const message = `No backup created — database file not found or empty: ${dbPath}`;
    if (json) {
      console.log(JSON.stringify({ ok: false, error: message, agentId, dbPath }));
    } else {
      console.error(message);
    }
    process.exitCode = 1;
    return;
  }

  backupLog("manual-backup-created", { agentId, backupPath, dbPath });

  if (json) {
    console.log(
      JSON.stringify({
        ok: true,
        agentId,
        dbPath,
        backupPath,
        backupDir,
      }),
    );
  } else {
    console.log(`Backup created: ${backupPath}`);
    console.log(`  Agent: ${agentId}`);
    console.log(`  Source: ${dbPath}`);
    console.log(`  Backup directory: ${backupDir}`);
  }
}