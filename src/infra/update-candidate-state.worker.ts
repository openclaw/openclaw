import { collectErrorGraphCandidates, formatErrorMessageWithCode } from "./errors.js";
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
  // SAFETY: Only the updater's typed snapshot/versions launchers serialize this private worker's stdin.
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as
    | (Parameters<typeof snapshotUpdateCandidateState>[0] & { mode: "snapshot" })
    | (Parameters<typeof discoverUpdateStateSchemaInspectionInProcess>[0] & { mode: "discover" })
    | (Parameters<typeof readUpdateStateSchemaVersionsInProcess>[0] & { mode: "versions" })
    | (Parameters<typeof readUpdateCandidateStateInventoryInProcess>[0] & { mode: "inventory" });
  if (
    input.mode !== "snapshot" &&
    input.mode !== "versions" &&
    input.mode !== "inventory" &&
    input.mode !== "discover"
  ) {
    throw new Error("Unknown update state inspection mode");
  }
  if (input.mode === "inventory") {
    const { databases, ...inventory } = await readUpdateCandidateStateInventoryInProcess(input);
    process.stdout.write(JSON.stringify({ ...inventory, databases: [...databases] }));
    return;
  }
  const versions =
    input.mode === "snapshot"
      ? await snapshotUpdateCandidateState(input)
      : input.mode === "discover"
        ? await discoverUpdateStateSchemaInspectionInProcess(input)
        : await readUpdateStateSchemaVersionsInProcess(input);
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
