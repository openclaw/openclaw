import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { registerSqliteCacheExitClose } from "./sqlite-wal.js";

let exits: EventEmitter;
const unregister: Array<() => void> = [];

beforeEach(() => {
  exits = new EventEmitter();
  // Exercise Node's real listener snapshots without exiting the test worker.
  for (const method of ["on", "once", "removeListener"] as const) {
    const original = process[method].bind(process);
    vi.spyOn(process, method).mockImplementation((event, listener) => {
      if (event === "exit") {
        exits[method](event, listener);
        return process;
      }
      return original(event, listener);
    });
  }
  const listeners = process.listeners.bind(process);
  vi.spyOn(process, "listeners").mockImplementation((event) =>
    event === "exit" ? exits.listeners(event) : listeners(event),
  );
});

afterEach(() => {
  for (const dispose of unregister.splice(0)) {
    dispose();
  }
  vi.restoreAllMocks();
});

function register(close: () => void): () => void {
  const dispose = registerSqliteCacheExitClose(close);
  unregister.push(dispose);
  return dispose;
}

it("keeps three SQLite caches within the exit-listener budget beside eight startup owners", () => {
  for (let index = 0; index < 8; index++) {
    exits.once("exit", () => {});
  }
  const closed: string[] = [];
  for (const cache of ["agent-readonly", "agent", "auth-profile"]) {
    register(() => closed.push(cache));
  }
  expect(exits.listenerCount("exit")).toBeLessThanOrEqual(exits.getMaxListeners());
  exits.emit("exit", 0);
  expect(closed).toEqual(["agent-readonly", "agent", "auth-profile"]);
  expect(exits.listenerCount("exit")).toBe(0);
});

it("preserves finalization order across intervening non-SQLite exit owners", () => {
  const closed: string[] = [];
  register(() => closed.push("agent"));
  exits.once("exit", () => closed.push("capture-finalizer"));
  register(() => closed.push("shared-state"));
  register(() => closed.push("capture-store"));
  exits.once("exit", () => closed.push("last-owner"));
  exits.emit("exit", 0);
  expect(closed).toEqual([
    "agent",
    "capture-finalizer",
    "shared-state",
    "capture-store",
    "last-owner",
  ]);
});

it("unregisters independently and closes duplicate callbacks once per registration despite errors", () => {
  const close = vi.fn();
  const retired = register(close);
  register(() => {
    throw new Error("native close failed");
  });
  register(close);
  register(close);
  retired();
  retired();
  exits.emit("exit", 0);
  exits.emit("exit", 0);
  expect(close).toHaveBeenCalledTimes(2);
  expect(exits.listenerCount("exit")).toBe(0);
});

it("retains the current emission snapshot when an earlier cache unregisters a later one", () => {
  const closed: string[] = [];
  register(() => {
    closed.push("first");
    retireSecond();
  });
  const retireSecond = register(() => closed.push("second"));
  exits.emit("exit", 0);
  expect(closed).toEqual(["first", "second"]);
  expect(exits.listenerCount("exit")).toBe(0);
});

it("closes remaining caches exactly once during reentrant exit dispatch", () => {
  const closed: string[] = [];
  register(() => {
    closed.push("first-start");
    exits.emit("exit", 0);
    closed.push("first-end");
  });
  register(() => closed.push("second"));
  exits.emit("exit", 0);
  expect(closed).toEqual(["first-start", "second", "first-end"]);
  expect(exits.listenerCount("exit")).toBe(0);
});

it("does not run a newly registered cache in an already captured exit batch", () => {
  const closed: string[] = [];
  register(() => {
    closed.push("first");
    register(() => closed.push("new"));
  });
  register(() => closed.push("second"));
  exits.emit("exit", 0);
  expect(closed).toEqual(["first", "second"]);
  exits.emit("exit", 0);
  expect(closed).toEqual(["first", "second", "new"]);
  expect(exits.listenerCount("exit")).toBe(0);
});
