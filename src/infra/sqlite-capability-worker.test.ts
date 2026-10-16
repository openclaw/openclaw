import type { EventEmitter } from "node:events";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { detectCurrentSqliteCapabilities } from "../../node-sqlite.mjs";

const workers = vi.hoisted(() => ({
  created: vi.fn<(worker: EventEmitter) => void>(),
  terminate: vi.fn<() => Promise<number>>(),
}));

vi.mock("node:worker_threads", async (importOriginal) => {
  const { EventEmitter } = await import("node:events");
  return {
    ...(await importOriginal<typeof import("node:worker_threads")>()),
    Worker: class extends EventEmitter {
      constructor() {
        super();
        workers.created(this);
      }
      terminate = workers.terminate;
    },
  };
});

const capabilities = {
  available: true,
  version: "3.51.3",
  text: true,
  blob: true,
  json: true,
};

beforeEach(() => {
  Reflect.deleteProperty(globalThis, Symbol.for("openclaw.sqliteCapabilities"));
  workers.created.mockReset();
  workers.terminate.mockReset().mockResolvedValue(1);
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, Symbol.for("openclaw.sqliteCapabilities"));
});

describe("SQLite capability worker readiness", () => {
  it.each(["empty", "nonzero", "error", "messageerror", "invalid"] as const)(
    "memoizes unavailable capabilities after a %s worker result",
    async (outcome) => {
      const pending = detectCurrentSqliteCapabilities();
      let settled = false;
      void pending.then(() => (settled = true));
      await vi.waitFor(() => expect(workers.created).toHaveBeenCalledOnce());
      const worker = expectDefined(workers.created.mock.calls[0]?.[0], "capability worker");
      if (outcome === "nonzero") {
        worker.emit("message", capabilities);
      } else if (outcome === "error" || outcome === "messageerror") {
        worker.emit(outcome, new Error("worker transport failed"));
      } else if (outcome === "invalid") {
        worker.emit("message", { available: true });
      }
      await Promise.resolve();
      expect(settled).toBe(false);
      worker.emit("exit", outcome === "nonzero" ? 1 : 0);
      const result = await pending;
      expect(result).toMatchObject({
        available: false,
        version: null,
        text: false,
        blob: false,
        json: false,
        error: expect.any(String),
      });
      expect(await detectCurrentSqliteCapabilities()).toBe(result);
      expect(workers.created).toHaveBeenCalledOnce();
      expect(workers.terminate).toHaveBeenCalledTimes(
        ["error", "messageerror", "invalid"].includes(outcome) ? 1 : 0,
      );
      expect(worker.eventNames()).toEqual([]);
    },
  );

  it("memoizes constructor failure without rejecting startup readiness", async () => {
    workers.created.mockImplementation(() => {
      throw new Error("worker unavailable");
    });
    const pending = detectCurrentSqliteCapabilities();
    expect(detectCurrentSqliteCapabilities()).toBe(pending);
    await expect(pending).resolves.toMatchObject({
      available: false,
      error: "worker unavailable",
    });
    expect(detectCurrentSqliteCapabilities()).toBe(pending);
    expect(workers.created).toHaveBeenCalledOnce();
  });
});
