import type { spawn } from "node:child_process";
import { setImmediate } from "node:timers/promises";
import { beforeEach, expect, it, vi } from "vitest";
import type { killProcessTree } from "../kill-tree.js";
import type { startBrokerExeca } from "./execa-worker.js";
import type { BrokerRequest, BrokerResponse } from "./protocol.js";
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

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  boundary.reserve.mockRejectedValue(new Error("synthetic reservation refused before startup"));
  boundary.send.mockResolvedValue(undefined);
  boundary.spawn.mockImplementation(() => {
    throw new Error("This worker admission fixture cannot spawn a process");
  });
  boundary.execa.mockRejectedValue(new Error("This worker admission fixture cannot start execa"));
  boundary.killTree.mockImplementation(() => {
    throw new Error("This worker admission fixture cannot signal a process");
  });
});

it.each(["spawn", "spawn-execa"] as const)(
  "reports authoritative no-start before the %s capacity refusal",
  async (type) => {
    let receive: ((message: BrokerRequest) => void) | undefined;
    const originalOn = process.on.bind(process);
    const originalOnce = process.once.bind(process);
    vi.spyOn(process, "on").mockImplementation((event, listener) => {
      if (event === "message") {
        receive = listener;
        return process;
      }
      if (event === "SIGTERM" || event === "SIGINT") {
        return process;
      }
      return originalOn(event, listener);
    });
    vi.spyOn(process, "once").mockImplementation((event, listener) => {
      if (event === "disconnect") {
        return process;
      }
      return originalOnce(event, listener);
    });
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("This worker admission fixture cannot signal or inspect a process");
    });
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("This worker admission fixture cannot exit the test process");
    });
    try {
      await import("./worker.js");
      if (!receive) {
        throw new Error("The worker did not register its message entrypoint");
      }
      // Reservations reject on the next microtask. Synchronous delivery fills
      // the real admission count without invoking either native launch path.
      for (let id = 1; id <= 257; id += 1) {
        receive(
          type === "spawn"
            ? {
                type,
                id,
                argv: ["synthetic-command"],
                options: { stdio: ["ignore", "ignore", "ignore"] },
              }
            : {
                type,
                id,
                argv: ["synthetic-command"],
                options: { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
              },
        );
      }
      await setImmediate();
      const responses = boundary.send.mock.calls.map(([message]) => message);
      const refusal = responses.filter((message) => "id" in message && message.id === 257);
      expect(refusal.map((message) => message.type)).toEqual(["execa-result", "error"]);
      expect(refusal[0]).toMatchObject({
        result: {
          failed: true,
          code: "ERR_SPAWN_BROKER_UNAVAILABLE",
          error: { code: "ERR_SPAWN_BROKER_UNAVAILABLE" },
        },
      });
      expect(refusal[1]).toMatchObject({
        error: { code: "ERR_SPAWN_BROKER_UNAVAILABLE" },
      });
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
    } finally {
      // All launched continuations retain only these reservation/report promises;
      // the final event-loop turn joins their catch/finally tails before restoring process hooks.
      await Promise.allSettled([
        ...boundary.reserve.mock.results.flatMap((result) =>
          result.type === "return" ? [result.value] : [],
        ),
        ...boundary.send.mock.results.flatMap((result) =>
          result.type === "return" ? [result.value] : [],
        ),
      ]);
      await setImmediate();
      vi.restoreAllMocks();
    }
  },
);
