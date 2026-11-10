import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import type { WorkerWriteOperationContext } from "../state/worker-operation-registry.js";

const TEMPLATE_OWNERSHIP_TABLES = [
  "template_workspace_files",
  "template_package_refs",
  "template_mcp_server_refs",
  "template_cron_refs",
  "template_installs",
] as const;

export const templateReleaseOperations = {
  /**
   * Drop every Template ownership row for one agent, leaving its files, plugins, MCP
   * servers, and cron jobs as ordinary resources. The reviewed install record must
   * still be current, so a concurrent change cannot be released unseen.
   */
  "templateRelease.apply": (
    input: { agentId: string; schemaVersion: string; agentConfigDigest: string },
    context: WorkerWriteOperationContext,
  ) =>
    context.writeAdmitted(
      ({ db }) => {
        const query = getNodeSqliteKysely<DB>(db);
        const record = executeSqliteQueryTakeFirstSync(
          db,
          query
            .selectFrom("template_installs")
            .select(["schema_version", "agent_config_digest"])
            .where("agent_id", "=", input.agentId),
        );
        if (
          record?.schema_version !== input.schemaVersion ||
          record.agent_config_digest !== input.agentConfigDigest
        ) {
          return false;
        }
        for (const table of TEMPLATE_OWNERSHIP_TABLES) {
          if (tableExists(db, table)) {
            executeSqliteQuerySync(
              db,
              query.deleteFrom(table).where("agent_id", "=", input.agentId),
            );
          }
        }
        return true;
      },
      { operationLabel: "templateRelease.apply" },
    ),
};
