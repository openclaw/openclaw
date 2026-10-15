import { afterEach, describe, expect, it, vi } from "vitest";
import { installDatabaseEngineSelection } from "./database-engine/context.js";
import { resetDatabaseEngineSelectionForTest } from "./database-engine/context.test-support.js";
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
  it("hands the installed selection to generic agent workers that can also open shared state", async () => {
    const input = { connection: "postgresql://localhost/synthetic", schemaPrefix: "test" };
    installDatabaseEngineSelection({ input });
    const { first } = await loadModuleCopies();
    const captured = first.captureSqliteWorkerStateContext(firstContext);
    expect(captured.databaseEngineInput).toBe(input);
    expect(first.captureSqliteWorkerStateContext(captured).databaseEngineInput).toBe(input);
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
