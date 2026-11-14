import type { EngineConnection } from "../infra/sql-connection.js";
import { readAllTemplateCronRefsInDatabase } from "./cron-records.js";
import { readAllTemplateMcpServerRefsInDatabase } from "./mcp-records.js";
import {
  readTemplateInstallRecordsInDatabase,
  readTemplatePackageRefsInDatabase,
} from "./provenance-read.kernel.js";
import { readAllTemplateWorkspaceFilesInDatabase } from "./workspace-state.js";

/** Return persisted Template ownership facts before any asynchronous resource inspection. */
export function readTemplateInventoryInDatabase(db: EngineConnection) {
  const installs = readTemplateInstallRecordsInDatabase(db);
  const packages = readTemplatePackageRefsInDatabase(db);
  const workspaceFiles = readAllTemplateWorkspaceFilesInDatabase(db);
  return {
    installs,
    packages,
    workspaceFiles,
    mcpServers: readAllTemplateMcpServerRefsInDatabase(db),
    cronJobs: readAllTemplateCronRefsInDatabase(db),
  };
}

export type TemplateInventory = ReturnType<typeof readTemplateInventoryInDatabase>;
