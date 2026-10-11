import { describe, expect, it } from "vitest";
import { buildConfigSchemaCore } from "./schema.js";
import { OpenClawSchema } from "./zod-schema.js";

describe("experimental database config", () => {
  it("accepts an optional engine and a sensitive SecretRef connection", () => {
    expect(OpenClawSchema.parse({}).database).toBeUndefined();
    const database = {
      engine: "postgres",
      postgres: {
        connection: { source: "file", provider: "database", id: "/dsn" },
        schemaPrefix: "test_prefix",
      },
    };
    expect(OpenClawSchema.parse({ database }).database).toEqual(database);
    expect(buildConfigSchemaCore().uiHints["database.postgres.connection"]?.sensitive).toBe(true);
  });

  it.each([
    { engine: "unknown" },
    { postgres: { connection: 123 } },
    { postgres: { schemaPrefix: 'bad"prefix' } },
    { postgres: { schemaPrefix: "a".repeat(28) } },
  ])("rejects invalid database config %j", (database) => {
    expect(OpenClawSchema.safeParse({ database }).success).toBe(false);
  });
});
