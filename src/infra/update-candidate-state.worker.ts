import { collectErrorGraphCandidates, formatErrorMessageWithCode } from "./errors.js";
import { createUpdateStateInspectionReporter } from "./update-candidate-state.diagnostics.js";
import {
  discoverUpdateStateSchemaInspectionInProcess,
  readUpdateCandidateStateInventoryInProcess,
  readUpdateStateSchemaVersionsInProcess,
  snapshotUpdateCandidateState,
} from "./update-candidate-state.js";

// Internal one-shot subprocess: a hard process deadline can interrupt SQLite
// integrity checks and backup/VACUUM, which expose no AbortSignal contract.
async function snapshotCandidateState(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  // SAFETY: Only the updater's typed state inspection launchers serialize this private worker's stdin.
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as
    | (Parameters<typeof snapshotUpdateCandidateState>[0] & {
        mode: "snapshot";
        streamProgress?: boolean;
      })
    | (Parameters<typeof discoverUpdateStateSchemaInspectionInProcess>[0] & { mode: "discover" })
    | (Parameters<typeof readUpdateStateSchemaVersionsInProcess>[0] & { mode: "versions" })
    | (Parameters<typeof readUpdateCandidateStateInventoryInProcess>[0] & {
        mode: "inventory";
        streamProgress?: boolean;
      })
    | (Parameters<
        typeof import("./update-database-backup.js").createUpdateDatabaseBackupInProcess
      >[0] & { mode: "database-backup" })
    | { mode: "database-generations"; paths: string[] };
  if (
    input.mode !== "snapshot" &&
    input.mode !== "versions" &&
    input.mode !== "inventory" &&
    input.mode !== "discover" &&
    input.mode !== "database-backup" &&
    input.mode !== "database-generations"
  ) {
    throw new Error("Unknown update state inspection mode");
  }
  if (input.mode === "database-generations") {
    const { readUpdateDatabaseGenerations } = await import("./update-database-generations.js");
    process.stdout.write(JSON.stringify(readUpdateDatabaseGenerations(input.paths)));
    return;
  }
  if (input.mode === "inventory") {
    const { databases, ...inventory } = await readUpdateCandidateStateInventoryInProcess({
      ...input,
      onProgress: createUpdateStateInspectionReporter(!input.streamProgress),
    });
    process.stdout.write(JSON.stringify({ ...inventory, databases: [...databases] }));
    return;
  }
  if (input.mode === "database-backup") {
    const { createUpdateDatabaseBackupInProcess } = await import("./update-database-backup.js");
    const backup = await createUpdateDatabaseBackupInProcess({
      ...input,
      onProgress: createUpdateStateInspectionReporter(),
    });
    process.stdout.write(JSON.stringify(backup));
    return;
  }
  const versions =
    input.mode === "snapshot"
      ? await snapshotUpdateCandidateState({
          ...input,
          onProgress: createUpdateStateInspectionReporter(!input.streamProgress),
        })
      : input.mode === "discover"
        ? await discoverUpdateStateSchemaInspectionInProcess({
            ...input,
            onProgress: createUpdateStateInspectionReporter(),
          })
        : await readUpdateStateSchemaVersionsInProcess({
            ...input,
            onProgress: createUpdateStateInspectionReporter(!input.inspectionPlan),
          });
  process.stdout.write(JSON.stringify(versions));
}

void snapshotCandidateState().catch((error: unknown) => {
  process.stderr.write(formatErrorMessageWithCode(error));
  const causes = collectErrorGraphCandidates(error, (current) => [current.cause]);
  if (causes.length > 1) {
    // The update ledger retains the final diagnostic line within its existing bound.
    process.stderr.write(`\nCaused by: ${formatErrorMessageWithCode(causes.at(-1))}`);
  }
  process.exitCode = 1;
});
