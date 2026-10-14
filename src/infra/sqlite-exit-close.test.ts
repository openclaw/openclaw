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

it.each([
  {
    name: "adjacent caches beside eight startup owners",
    startupOwners: 8,
    owners: ["agent-readonly", "agent", "auth-profile"],
    nonSqlite: [],
  },
  {
    name: "caches separated by non-SQLite finalizers",
    startupOwners: 0,
    owners: ["agent", "capture-finalizer", "shared-state", "capture-store", "last-owner"],
    nonSqlite: ["capture-finalizer", "last-owner"],
  },
])("preserves order and listener budget for $name", ({ startupOwners, owners, nonSqlite }) => {
  for (let index = 0; index < startupOwners; index++) {
    exits.once("exit", () => {});
  }
  const closed: string[] = [];
  for (const owner of owners) {
    const close = () => {
      closed.push(owner);
    };
    if (nonSqlite.includes(owner)) {
      exits.once("exit", close);
    } else {
      register(close);
    }
  }
  expect(exits.listenerCount("exit")).toBeLessThanOrEqual(exits.getMaxListeners());
  exits.emit("exit", 0);
  expect(closed).toEqual(owners);
  expect(exits.listenerCount("exit")).toBe(0);
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

it.each(["unregister", "register"])("retains the emission snapshot across %s", (operation) => {
  const closed: string[] = [];
  register(() => {
    closed.push("first");
    if (operation === "unregister") {
      retireSecond();
    } else {
      register(() => closed.push("new"));
    }
  });
  const retireSecond = register(() => closed.push("second"));
  exits.emit("exit", 0);
  expect(closed).toEqual(["first", "second"]);
  if (operation === "register") {
    exits.emit("exit", 0);
    expect(closed).toEqual(["first", "second", "new"]);
  }
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
