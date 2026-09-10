import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ManagedHandoffLease } from "./update-managed-service-handoff-lease.js";
export type RetainedBorrowerSource = Extract<
  ManagedHandoffLease,
  { version: 3 }
>["nativeBorrower"]["source"];
/** Seed a historical record; production intentionally has no v3 writer. */
export function seedRetainedBorrower(
  databasePath: string,
  parent: ManagedHandoffLease,
  source: RetainedBorrowerSource,
  phase: "reserved" | "admitted",
) {
  const canonical = (file: string) =>
    path.join(fs.realpathSync(path.dirname(file)), path.basename(file));
  const payload = JSON.stringify({
    version: 3,
    executor: parent.executor,
    helper: parent.helper,
    action: { kind: "update" },
    nativeBorrower: {
      id: "11111111-1111-4111-8111-111111111111",
      phase,
      source: {
        ...source,
        serviceKey: canonical(source.serviceKey),
        configPaths: [...new Set(source.configPaths.map(canonical))].toSorted(),
      },
    },
  });
  const db = new DatabaseSync(databasePath);
  try {
    db.prepare(
      "UPDATE managed_update_handoffs SET payload_json=? WHERE install_root=? AND payload_json=?",
    ).run(payload, parent.key, parent.payload);
  } finally {
    db.close();
  }
}

/** Coordinates from the real held sidecar, never source or release authority. */
export function heldServiceLockCoordinate(directory: string): string {
  const names = fs
    .readdirSync(directory)
    .filter((name) => name.startsWith("service-lifecycle-") && name.endsWith(".lock"));
  if (names.length !== 1) {
    throw new Error("Expected exactly one real held service sidecar.");
  }
  return path.join(directory, names[0]!.slice(0, -".lock".length));
}
