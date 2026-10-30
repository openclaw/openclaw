import { afterEach, describe, expect, it, vi } from "vitest";
import { installDatabaseEngineSelection } from "./database-engine/context.js";
import { resetDatabaseEngineSelectionForTest } from "./database-engine/context.test-support.js";
import { createSqliteFamilyEngines } from "./database-engine/selection-fixture.test-support.js";
import type { DatabaseEngineSelection } from "./database-engine/types.js";
import type { SqliteWorkerStateContext } from "./sqlite-worker-state-context.js";

const firstContext: SqliteWorkerStateContext = {
  environment: { OPENCLAW_STATE_DIR: "/fixture/first" },
};
const secondContext: SqliteWorkerStateContext = {
  environment: { OPENCLAW_STATE_DIR: "/fixture/second" },
};

async function loadModuleCopies() {
  vi.resetModules();
  const first = await import("./sqlite-worker-state-context.js");
  vi.resetModules();
  const second = await import("./sqlite-worker-state-context.js");
  expect(first).not.toBe(second);
  return { first, second };
}

afterEach(resetDatabaseEngineSelectionForTest);

describe("SQLite worker state context across module copies", () => {
  it.each(["sqlite", "postgres"] as const)(
    "hands the installed %s state selection to workers without losing SQLite family choices",
    async (state) => {
      const selection: DatabaseEngineSelection = {
        effectiveEngines: createSqliteFamilyEngines({ state }),
        ...(state === "postgres"
          ? { postgres: { connection: "postgresql://localhost/synthetic", schemaPrefix: "test" } }
          : {}),
      };
      installDatabaseEngineSelection(selection);
      const { first } = await loadModuleCopies();
      const captured = first.captureSqliteWorkerStateContext(firstContext);
      expect(captured.databaseEngineSelection).toEqual(selection);
      expect(first.captureSqliteWorkerStateContext(captured).databaseEngineSelection).toEqual(
        selection,
      );
      expect(first.sqliteWorkerRequestBytes(new Uint8Array(), captured)).toBeGreaterThan(
        first.sqliteWorkerRequestBytes(new Uint8Array(), firstContext),
      );
    },
  );

  it("keeps an uninstalled selection absent", async () => {
    const { first } = await loadModuleCopies();
    expect(
      first.captureSqliteWorkerStateContext(firstContext).databaseEngineSelection,
    ).toBeUndefined();
  });

  it("shares the current actor facts and restores nested scopes", async () => {
    const { first, second } = await loadModuleCopies();
    first.runWithSqliteWorkerStateContext(firstContext, () => {
      expect(second.getSqliteWorkerStateContext()).toEqual(firstContext);
      second.runWithSqliteWorkerStateContext(secondContext, () => {
        expect(first.getSqliteWorkerStateContext()).toEqual(secondContext);
      });
      expect(second.getSqliteWorkerStateContext()).toEqual(firstContext);
    });
    expect(() => first.getSqliteWorkerStateContext()).toThrow("requires captured host context");
    expect(() => second.getSqliteWorkerStateContext()).toThrow("requires captured host context");
  });

  it("keeps overlapping async actor scopes isolated", async () => {
    const { first, second } = await loadModuleCopies();
    await Promise.all([
      first.runWithSqliteWorkerStateContext(firstContext, async () => {
        await Promise.resolve();
        expect(second.getSqliteWorkerStateContext()).toEqual(firstContext);
      }),
      second.runWithSqliteWorkerStateContext(secondContext, async () => {
        await Promise.resolve();
        expect(first.getSqliteWorkerStateContext()).toEqual(secondContext);
      }),
    ]);
    expect(() => first.getSqliteWorkerStateContext()).toThrow("requires captured host context");
    expect(() => second.getSqliteWorkerStateContext()).toThrow("requires captured host context");
  });
});
