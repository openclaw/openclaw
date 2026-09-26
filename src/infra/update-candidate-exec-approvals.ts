import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { root } from "@openclaw/fs-safe";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import { hasNodeErrorCode } from "./path-guards.js";
import {
  detectLegacyExecApprovals,
  DOCTOR_CLAIM_SUFFIX,
  MAX_LEGACY_EXEC_APPROVALS_BYTES,
} from "./state-migrations.exec-approvals.js";
import { resolveLegacyMigrationSourceKey } from "./state-migrations.receipts.js";

/** Project retired policy inputs and their receipt authority into the private rehearsal copy. */
export function createUpdateCandidateExecApprovalsProjection(
  sourceRoot: string,
  targetPath: (source: string) => string,
) {
  const { sourcePath: legacySourcePath } = detectLegacyExecApprovals({ stateDir: sourceRoot });
  return {
    rebaseReceipt(db: DatabaseSync): void {
      if (!tableExists(db, "migration_sources")) {
        return;
      }
      // Receipt identity includes the absolute path; only the copied receipt is rebased.
      const queries = getNodeSqliteKysely<Pick<DB, "migration_sources">>(db);
      executeSqliteQuerySync(
        db,
        queries
          .updateTable("migration_sources")
          .set({
            source_key: resolveLegacyMigrationSourceKey(
              "exec-approvals-json",
              targetPath(legacySourcePath),
            ),
            source_path: targetPath(legacySourcePath),
          })
          .where(
            "source_key",
            "=",
            resolveLegacyMigrationSourceKey("exec-approvals-json", legacySourcePath),
          )
          .where("migration_kind", "=", "legacy-exec-approvals-json"),
      );
    },
    async copySources(): Promise<void> {
      // Copy bytes, never links: Doctor may claim or archive only private files.
      for (const source of [legacySourcePath, `${legacySourcePath}${DOCTOR_CLAIM_SUFFIX}`]) {
        // lstat keeps broken links visible to the same refusal as ordinary links.
        const exists = await fs.lstat(source).then(
          () => true,
          (error: unknown) => {
            if (hasNodeErrorCode(error, "ENOENT")) {
              return false;
            }
            throw error;
          },
        );
        if (!exists) {
          continue;
        }
        const sourceRootHandle = await root(sourceRoot);
        const opened = await sourceRootHandle.read(path.relative(sourceRoot, source), {
          hardlinks: "reject",
          symlinks: "reject",
          maxBytes: MAX_LEGACY_EXEC_APPROVALS_BYTES,
        });
        const target = targetPath(source);
        await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        await fs.writeFile(target, opened.buffer, { mode: 0o600, flag: "wx" });
      }
    },
  };
}
