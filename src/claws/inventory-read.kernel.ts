import type { DatabaseSync } from "node:sqlite";
import { readAllClawCronRefsInDatabase } from "./cron.js";
import { readAllClawMcpServerRefsInDatabase } from "./mcp.js";
import { readClawInstallRecordsInDatabase, readClawPackageRefsInDatabase } from "./provenance.js";
import { readAllClawWorkspaceFilesInDatabase } from "./workspace.js";

/** Return persisted Claw ownership facts before any asynchronous resource inspection. */
export function readClawInventoryInDatabase(db: DatabaseSync) {
  const installs = readClawInstallRecordsInDatabase(db);
  const packages = readClawPackageRefsInDatabase(db, { readOnly: true });
  const workspaceFiles = readAllClawWorkspaceFilesInDatabase(db);
  return {
    installs,
    packages,
    workspaceFiles,
    mcpServers: readAllClawMcpServerRefsInDatabase(db),
    cronJobs: readAllClawCronRefsInDatabase(db),
  };
}

export type ClawInventory = ReturnType<typeof readClawInventoryInDatabase>;
