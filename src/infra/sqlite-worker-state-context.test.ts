import { describe, expect, it, vi } from "vitest";
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

describe("SQLite worker state context across module copies", () => {
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
