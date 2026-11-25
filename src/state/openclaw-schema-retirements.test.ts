import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { z } from "zod";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-agent-db-contract.js";
import retirementManifest from "./openclaw-schema-retirements.json" with { type: "json" };
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";

const manifestSchema = z.object({
  retirements: z.array(
    z.object({
      database: z.enum(["state", "agent"]),
      status: z.enum(["planned", "completed"]),
      targetVersion: z.number().int().nonnegative(),
      table: z.string().min(1),
      indexes: z.array(z.string().min(1)),
      note: z.string().optional(),
    }),
  ),
});

function hasSchemaObject(database: DatabaseSync, type: "table" | "index", name: string): boolean {
  return (
    database.prepare("SELECT 1 FROM sqlite_schema WHERE type = ? AND name = ?").get(type, name) !==
    undefined
  );
}

it("keeps the schema retirement ledger aligned with canonical database schemas", () => {
  const { retirements } = manifestSchema.parse(retirementManifest);
  const keys = retirements.map(({ database, table }) => `${database}/${table}`);
  expect(new Set(keys).size, "duplicate database/table retirement").toBe(keys.length);

  using state = new DatabaseSync(":memory:");
  using agent = new DatabaseSync(":memory:");
  const databases = { state, agent };
  const versions = { state: OPENCLAW_STATE_SCHEMA_VERSION, agent: OPENCLAW_AGENT_SCHEMA_VERSION };
  for (const [owner, database] of Object.entries(databases)) {
    database.exec(readFileSync(new URL(`./openclaw-${owner}-schema.sql`, import.meta.url), "utf8"));
  }

  for (const retirement of retirements) {
    const database = databases[retirement.database];
    const currentVersion = versions[retirement.database];
    const shouldExist = retirement.status === "planned";

    if (shouldExist) {
      expect(retirement.targetVersion).toBe(currentVersion + 1);
    } else {
      expect(retirement.targetVersion).toBeLessThanOrEqual(currentVersion);
    }

    expect(hasSchemaObject(database, "table", retirement.table)).toBe(shouldExist);
    for (const index of retirement.indexes) {
      expect(hasSchemaObject(database, "index", index)).toBe(shouldExist);
    }
  }
});
