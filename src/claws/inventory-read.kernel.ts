import type { EngineConnection } from "../infra/sql-connection.js";
import { readAllClawCronRefsInDatabase } from "./cron-records.js";
import { readAllClawMcpServerRefsInDatabase } from "./mcp-records.js";
import {
  readClawInstallRecordsInDatabase,
  readClawPackageRefsInDatabase,
} from "./provenance-read.kernel.js";
import { readAllClawWorkspaceFilesInDatabase } from "./workspace-state.js";

/** Return persisted Claw ownership facts before any asynchronous resource inspection. */
export function readClawInventoryInDatabase(db: EngineConnection) {
  const installs = readClawInstallRecordsInDatabase(db);
  const packages = readClawPackageRefsInDatabase(db);
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
