import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { registerProcessExitLeaseCleanup } from "../state/openclaw-state-lease-process-exit.js";
import { registerProcessExitCleanup } from "./process-exit-cleanup.js";

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
  const dispose = registerProcessExitCleanup(close);
  unregister.push(dispose);
  return dispose;
}

it("keeps interleaved stores and leases within the startup listener budget", () => {
  for (let index = 0; index < 8; index++) {
    exits.once("exit", () => {});
  }
  const close = vi.fn();
  const release = vi.fn();
  for (let index = 0; index < 32; index++) {
    register(close);
    unregister.push(registerProcessExitLeaseCleanup(() => release()));
    expect(exits.listenerCount("exit")).toBeLessThanOrEqual(exits.getMaxListeners());
  }
  exits.emit("exit", 0);
  expect(close).toHaveBeenCalledTimes(32);
  expect(release).toHaveBeenCalledTimes(32);
});

it.each([false, true])("preserves order and listener budget (interleaved: %s)", (interleaved) => {
  const startupOwners = interleaved ? 0 : 8;
  const owners = interleaved
    ? ["agent", "finalizer", "shared-state"]
    : ["agent", "readonly", "auth"];
  for (let index = 0; index < startupOwners; index++) {
    exits.once("exit", () => {});
  }
  const closed: string[] = [];
  for (const owner of owners) {
    const close = () => {
      closed.push(owner);
    };
    if (owner === "finalizer") {
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
