import { runSqliteReadOnlyWorkerSync } from "./sqlite-readonly-worker.js";
import type { UpdateDatabaseGenerationObservation } from "./update-database-generations.js";

/** Raw descriptors stay in the child even while our native writer holds exclusion. */
export function readUpdateDoctorGeneration(pathname: string): UpdateDatabaseGenerationObservation {
  const value: unknown = JSON.parse(
    runSqliteReadOnlyWorkerSync(pathname, undefined, "update-generation"),
  );
  if (!value || typeof value !== "object" || !("generation" in value)) {
    throw new Error("Database generation child returned an invalid observation.");
  }
  const generation = value.generation;
  const emptyReaderAlternate =
    "emptyReaderAlternate" in value ? value.emptyReaderAlternate : undefined;
  const rebuiltIndexAlternate =
    "rebuiltIndexAlternate" in value ? value.rebuiltIndexAlternate : undefined;
  const isFingerprint = (entry: unknown): entry is string =>
    typeof entry === "string" && /^[a-f0-9]{64}$/u.test(entry);
  if (
    (generation !== null && !isFingerprint(generation)) ||
    (emptyReaderAlternate !== undefined && !isFingerprint(emptyReaderAlternate)) ||
    (rebuiltIndexAlternate !== undefined && !isFingerprint(rebuiltIndexAlternate))
  ) {
    throw new Error("Database generation child returned an invalid observation.");
  }
  return { generation, emptyReaderAlternate, rebuiltIndexAlternate };
}
