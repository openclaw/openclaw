import { existsSync } from "node:fs";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";

type ClawPackageAdoption = {
  kind: "skill" | "plugin";
  source: "clawhub";
  ref: string;
  version: string;
  workspace?: string;
};

/** Records an explicit non-Claw claim through the canonical package owner. */
export function markClawPackageIndependentlyOwned(
  artifact: ClawPackageAdoption,
  options: OpenClawStateDatabaseOptions & { nowMs?: number } = {},
): number {
  const databasePath = options.path ?? resolveOpenClawStateSqlitePath(options.env ?? process.env);
  if (!existsSync(databasePath)) {
    return 0;
  }
  const nowMs = options.nowMs ?? Date.now();
  try {
    return runOpenClawStateWriteTransaction(({ db }) => {
      const workspaceScope =
        artifact.kind === "skill"
          ? `AND agent_id IN (
             SELECT agent_id FROM claw_installs WHERE workspace = @workspace
           )`
          : "";
      const statement =
        db /* sqlite-allow-raw: adopt Claw package ownership after independent install. */
          .prepare(
            `UPDATE claw_package_refs
            SET ownership = 'independently-owned', updated_at_ms = @updated_at_ms
          WHERE package_kind = @package_kind
            AND package_source = @package_source
            AND package_ref = @package_ref
            AND package_version = @package_version
            AND ownership <> 'independently-owned'
            ${workspaceScope}`,
          );
      const bindings: Record<string, string | number> = {
        package_kind: artifact.kind,
        package_source: artifact.source,
        package_ref: artifact.ref,
        package_version: artifact.version,
        updated_at_ms: nowMs,
      };
      if (artifact.kind === "skill") {
        bindings.workspace = artifact.workspace ?? "";
      }
      const result = statement.run(bindings);
      return Number(result.changes);
    }, options);
  } catch {
    // The canonical install already succeeded. Removal also checks its newer owner timestamp.
    return 0;
  }
}
