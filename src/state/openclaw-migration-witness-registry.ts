import type { OpenClawMigrationWitness } from "./openclaw-migration-witness.schema.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-schema-versions.js";

/** Unrefreshed aliases retain the exact registry observations from the original backup. */
export function assertMigrationWitnessRegistryPreserved(
  original: OpenClawMigrationWitness,
  current: OpenClawMigrationWitness,
): void {
  if (!current.registryMigrationBinding) {
    return;
  }
  const originalRows = new Map(
    (original.tables.find((table) => table.name === "agent_databases")?.registryRows ?? []).map(
      (row) => [row.locator, row],
    ),
  );
  const currentRows = current.tables.find(
    (table) => table.name === "agent_databases",
  )?.registryRows;
  if (!currentRows || originalRows.size !== currentRows.length) {
    throw new Error("Missing registry row witnesses");
  }
  for (const row of currentRows) {
    const before = originalRows.get(row.locator);
    if (
      !before ||
      before.store !== row.store ||
      (row.schemaVersion !== OPENCLAW_AGENT_SCHEMA_VERSION && row.sha256 !== before.sha256)
    ) {
      throw new Error("Unrefreshed registry alias changed during migration");
    }
  }
}
