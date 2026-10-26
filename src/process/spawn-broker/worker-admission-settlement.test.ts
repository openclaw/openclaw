import type { spawn } from "node:child_process";
import { setImmediate } from "node:timers/promises";
import { beforeEach, expect, it, vi } from "vitest";
import type { killProcessTree } from "../kill-tree.js";
import type { startBrokerExeca } from "./execa-worker.js";
import type { BrokerRequest, BrokerResponse } from "./protocol.js";
import type { BrokerBootstrap } from "./resource-protocol.js";
import type { createWorkerSender } from "./worker-sender.js";

type Sender = ReturnType<typeof createWorkerSender>;
const boundary = vi.hoisted(() => ({
  spawn: vi.fn<typeof spawn>(),
  execa: vi.fn<typeof startBrokerExeca>(),
  killTree: vi.fn<typeof killProcessTree>(),
  reserve: vi.fn<Sender["reserve"]>(),
  send: vi.fn<(message: BrokerResponse) => Promise<void>>(),
  close: vi.fn<Sender["close"]>(),
  acknowledge: vi.fn<Sender["acknowledge"]>(),
}));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: boundary.spawn,
}));
vi.mock("./execa-worker.js", () => ({ startBrokerExeca: boundary.execa }));
vi.mock("../kill-tree.js", () => ({ killProcessTree: boundary.killTree }));
vi.mock("./worker-sender.js", () => ({
  createWorkerSender: () => ({
    reserve: boundary.reserve,
    send: boundary.send,
    close: boundary.close,
    acknowledge: boundary.acknowledge,
  }),
}));

function unexpectedEffect(): never {
  throw new Error("This worker admission fixture cannot launch, signal, inspect, or exit");
}

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  boundary.reserve.mockRejectedValue(new Error("synthetic reservation refused before startup"));
  boundary.send.mockResolvedValue(undefined);
  boundary.spawn.mockImplementation(unexpectedEffect);
  boundary.execa.mockRejectedValue(new Error("This worker admission fixture cannot start execa"));
  boundary.killTree.mockImplementation(unexpectedEffect);
});

it.each(["spawn", "spawn-execa"] as const)(
  "reports authoritative no-start before the %s capacity refusal",
  async (type) => {
    let receive: ((message: BrokerBootstrap | BrokerRequest) => void) | undefined;
    const connected = Object.getOwnPropertyDescriptor(process, "connected");
    const originalOn = process.on.bind(process);
    const originalOnce = process.once.bind(process);
    vi.spyOn(process, "on").mockImplementation((event, listener) => {
      if (event === "message") {
        receive = listener;
        return process;
      }
      return event === "SIGTERM" || event === "SIGINT" ? process : originalOn(event, listener);
    });
    vi.spyOn(process, "once").mockImplementation((event, listener) => {
      return event === "disconnect" ? process : originalOnce(event, listener);
    });
    const kill = vi.spyOn(process, "kill").mockImplementation(unexpectedEffect);
    const exit = vi.spyOn(process, "exit").mockImplementation(unexpectedEffect);
    Object.defineProperty(process, "connected", { configurable: true, value: true });
    try {
      await import("./worker.js");
      if (!receive) {
        throw new Error("The worker did not register its message entrypoint");
      }
      // Keep loader scheduling real; bootstrap and admission own the clock checked below.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      receive({ type: "bootstrap" });
      await setImmediate();
      // Reservations reject on the next microtask. Synchronous delivery fills
      // the real admission count without invoking either native launch path.
      for (let id = 1; id <= 257; id += 1) {
        receive({ type, id, argv: ["synthetic-command"], options: {} });
      }
      await setImmediate();
      const responses = boundary.send.mock.calls.map(([message]) => message);
      const refusal = responses.filter((message) => "id" in message && message.id === 257);
      const error = { code: "ERR_SPAWN_BROKER_UNAVAILABLE" };
      expect(refusal).toMatchObject([
        {
          type: "execa-result",
          result: { failed: true, ...error, error },
        },
        { type: "error", error },
      ]);
      expect(
        responses.some((message) => message.type === "owned" || message.type === "spawned"),
      ).toBe(false);
      expect(boundary.reserve).toHaveBeenCalledTimes(256);
      expect(responses.filter((message) => message.type === "error")).toHaveLength(257);
      expect(boundary.spawn).not.toHaveBeenCalled();
      expect(boundary.execa).not.toHaveBeenCalled();
      expect(boundary.killTree).not.toHaveBeenCalled();
      expect(kill).not.toHaveBeenCalled();
      expect(exit).not.toHaveBeenCalled();
      expect(boundary.close).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      // Reservation and report mocks settle in microtasks; join their tails before restoring hooks.
      await setImmediate();
      vi.clearAllTimers();
      vi.useRealTimers();
      if (connected) {
        Object.defineProperty(process, "connected", connected);
      } else {
        Reflect.deleteProperty(process, "connected");
      }
      vi.restoreAllMocks();
    }
  },
);
