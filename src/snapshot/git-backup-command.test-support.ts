import { backupGitCreateCommand } from "../commands/backup-git.js";
import { defaultRuntime } from "../runtime.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";

try {
  const agentId = process.argv[3];
  await backupGitCreateCommand(defaultRuntime, {
    repository: process.argv[2],
    ...(agentId ? { agents: [agentId] } : { all: true }),
    json: true,
  });
} finally {
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
}
