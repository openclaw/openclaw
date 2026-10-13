import { clawBootstrapStateBlocksRemove } from "./lifecycle-bootstrap-removal.js";
import type { ClawStatusRecord } from "./lifecycle-status.js";

export function clawRemoveStateBlockers(record?: ClawStatusRecord) {
  const blockers: Array<{ code: string; message: string }> = [];
  if (record?.agentState === "modified") {
    blockers.push({
      code: "agent_modified",
      message: `Agent ${JSON.stringify(record.install.agentId)} changed after add.`,
    });
  }
  for (const file of record?.workspaceFiles ?? []) {
    if (file.state === "unsafe") {
      blockers.push({
        code: "workspace_file_unsafe",
        message: `${file.path}: ${file.message ?? "unsafe file"}`,
      });
    }
  }
  if (record && clawBootstrapStateBlocksRemove(record)) {
    blockers.push({
      code: "bootstrap_cleanup_uncertain",
      message: `BOOTSTRAP.md has ${record.bootstrap.state} ownership state and must be reconciled before removal.`,
    });
  }
  for (const server of record?.mcpServers ?? []) {
    if (server.state === "pending") {
      blockers.push({
        code: "mcp_cleanup_uncertain",
        message: `MCP server ${JSON.stringify(server.name)} has ${server.state} ownership state and must be reconciled before removal.`,
      });
    }
  }
  for (const cron of record?.cronJobs ?? []) {
    if (cron.status !== "removed" && (cron.status !== "complete" || !cron.schedulerJobId)) {
      blockers.push({
        code: "cron_cleanup_uncertain",
        message: `Cron declaration ${JSON.stringify(cron.manifestId)} has ${cron.status} ownership state and must be reconciled before removal.`,
      });
    }
  }
  return blockers;
}
