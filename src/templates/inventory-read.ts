import { executeExistingOpenClawStateRead } from "../state/openclaw-state-db-readonly.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import type { OpenClawStateReadOptions } from "../state/openclaw-state-read.types.js";
import type { TemplateInventory } from "./inventory-read.kernel.js";

export async function readTemplateInventory(
  options: OpenClawStateDatabaseOptions = {},
  readOptions?: OpenClawStateReadOptions,
): Promise<TemplateInventory> {
  const reply = await executeExistingOpenClawStateRead(
    options,
    { type: "templates.inventory" },
    readOptions,
  );
  if (!reply) {
    return { installs: [], packages: [], workspaceFiles: [], mcpServers: [], cronJobs: [] };
  }
  return reply.inventory;
}
