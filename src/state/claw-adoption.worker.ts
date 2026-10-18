import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { ClawPackageAdoption } from "./claw-adoption.types.js";
import type { DB } from "./openclaw-state-db.generated.js";
import type { WorkerOperations, WorkerWriteOperationContext } from "./worker-operation-registry.js";

export const clawAdoptionOperations = {
  "clawAdoption.mcp": (
    input: { name: string; nowMs: number },
    context: WorkerWriteOperationContext,
  ) =>
    context.write(({ db }) => {
      const result = executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<Pick<DB, "claw_mcp_server_refs">>(db)
          .updateTable("claw_mcp_server_refs")
          .set({ independent_owner: 1, updated_at_ms: input.nowMs })
          .where("name", "=", input.name)
          .where("independent_owner", "!=", 1),
      );
      return Number(result.numAffectedRows);
    }),
  "clawAdoption.package": (
    input: { artifact: ClawPackageAdoption; nowMs: number },
    context: WorkerWriteOperationContext,
  ) =>
    context.write(({ db }) => {
      const { artifact, nowMs } = input;
      const kysely = getNodeSqliteKysely<Pick<DB, "claw_package_refs" | "claw_installs">>(db);
      let query = kysely
        .updateTable("claw_package_refs")
        .set({ independent_owner: 1, updated_at_ms: nowMs })
        .where("package_kind", "=", artifact.kind)
        .where("package_source", "=", artifact.source)
        .where("package_ref", "=", artifact.ref)
        .where("independent_owner", "!=", 1);
      if (artifact.version) {
        query = query.where("package_version", "=", artifact.version);
      }
      if (artifact.kind === "skill") {
        query = query.where(
          "agent_id",
          "in",
          kysely
            .selectFrom("claw_installs")
            .select("agent_id")
            .where("workspace", "=", artifact.workspace ?? ""),
        );
      }
      return Number(executeSqliteQuerySync(db, query).numAffectedRows);
    }),
};

export type ClawAdoptionWorkerOperations = WorkerOperations<typeof clawAdoptionOperations>;
