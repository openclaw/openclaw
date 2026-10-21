import { describe, expect, it } from "vitest";
import { buildConfigSchemaCore } from "./schema.js";
import { validateConfigObjectRaw } from "./validation-core.js";
import { OpenClawSchema } from "./zod-schema.js";

describe("database config", () => {
  it.each([
    { source: "env", provider: "default", id: "OPENCLAW_DATABASE_DSN" },
    { source: "file", provider: "database", id: "/dsn" },
    { source: "exec", provider: "database", id: "dsn" },
  ])("accepts a bootstrap connection from $source", (connection) => {
    const database = { engine: "postgres", postgres: { connection } };
    expect(OpenClawSchema.parse({ database }).database).toEqual(database);
  });

  it.each(["sqlite", "postgres"])(
    "reports a store-backed DSN for Doctor with %s selected",
    (engine) => {
      const result = validateConfigObjectRaw({
        database: {
          engine,
          postgres: {
            connection: { source: "store", provider: "default", id: "OPENCLAW_DATABASE_DSN" },
          },
        },
      });
      expect(result).toMatchObject({
        ok: false,
        issues: [
          {
            path: "database.postgres.connection",
            message: expect.stringMatching(/use an env, file or exec SecretRef/),
          },
        ],
      });
    },
  );

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
    const hints = buildConfigSchemaCore().uiHints;
    expect(hints["database.postgres.connection"]?.sensitive).toBe(true);
    expect(hints.database?.label).toBe("Database");
    expect(hints.database?.docsUrl).toBe("https://docs.openclaw.ai/reference/database-engines");
  });

  it.each([
    {},
    { engine: "sqlite" },
    { engine: "postgres" },
    { engine: "postgres", families: { agent: { engine: "postgres" } } },
    { families: { agent: { engine: "postgres" } } },
    { engine: "postgres", families: { state: { engine: "sqlite" } } },
    { engine: "postgres", families: { workboard: { engine: "sqlite" } } },
    {
      families: {
        state: { engine: "postgres" },
        agent: { engine: "postgres" },
        workboard: { engine: "postgres" },
        logbook: { engine: "postgres" },
        "team-reports": { engine: "postgres" },
      },
    },
    { families: {} },
    { families: { state: { engine: "postgres" }, agent: { engine: "sqlite" } } },
    {
      engine: "postgres",
      families: {
        state: { engine: "sqlite" },
        agent: { engine: "sqlite" },
        workboard: { engine: "postgres" },
        logbook: { engine: "sqlite" },
        "team-reports": { engine: "postgres" },
      },
    },
  ])("preserves optional database config %j for runtime admission", (database) => {
    expect(OpenClawSchema.parse({ database }).database).toEqual(database);
  });

  it.each([
    { engine: "unknown" },
    { postgres: { connection: 123 } },
    { postgres: { schemaPrefix: 'bad"prefix' } },
    { postgres: { schemaPrefix: "a".repeat(28) } },
    { families: { state: {} } },
    { families: { state: "postgres" } },
    { families: { state: { engine: "unknown" } } },
    { families: { state: { engine: "postgres", postgres: { schemaPrefix: "state" } } } },
    { families: { agents: { engine: "sqlite" } } },
    { families: { quarantine: { engine: "sqlite" } } },
    { families: { "managed-update": { engine: "sqlite" } } },
    { families: { "package-activation": { engine: "sqlite" } } },
  ])("rejects invalid database config %j", (database) => {
    expect(OpenClawSchema.safeParse({ database }).success).toBe(false);
  });
});
