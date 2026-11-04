import { expect, it, vi } from "vitest";
import { stateEngineSchema } from "./openclaw-state-db-engine.js";
import { createStatePostgresRuntime } from "./postgres-schema.generated/runtime.js";

vi.mock("./postgres-schema.generated/runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./postgres-schema.generated/runtime.js")>();
  return { ...actual, createStatePostgresRuntime: vi.fn(actual.createStatePostgresRuntime) };
});

it("constructs PostgreSQL runtime data once on first engine use and reuses fragments", () => {
  expect(createStatePostgresRuntime).not.toHaveBeenCalled();
  const sql = stateEngineSchema.postgres;
  const fragments = stateEngineSchema.postgresFragments;
  expect(sql).toContain('CREATE TABLE "schema_meta"');
  expect(fragments?.find(({ id }) => id === "user_background_images")?.dependencies).toContain(
    "user_profiles",
  );
  expect(stateEngineSchema.postgres).toBe(sql);
  expect(stateEngineSchema.postgresFragments).toBe(fragments);
  expect(createStatePostgresRuntime).toHaveBeenCalledTimes(1);
});
