import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { waitForGatewayPortRelease } from "./schtasks-port-diagnostics.js";

vi.mock("../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/exec.js")>()),
  runCommandWithTimeout: async () => ({ stdout: "", stderr: "", code: 0 }),
}));
vi.mock("../infra/ports-lsof.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/ports-lsof.js")>()),
  resolveLsofCommand: async () => "lsof",
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Scheduled Task port settlement", () => {
  it.each([
    { answer: "ECONNREFUSED", delay: 2_000, expected: true },
    { answer: "connect", delay: 0, expected: "busy" },
    { answer: "ECONNREFUSED", delay: 6_000, expected: "unknown" },
  ] as const)(
    "settles a delayed $answer after $delay ms as $expected",
    async ({ answer, delay, expected }) => {
      // Simulate OS bind success and Windows TCP completion timing at the socket boundary.
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      vi.spyOn(net.Server.prototype, "listen").mockImplementation(function (this: net.Server) {
        queueMicrotask(() => this.emit("listening"));
        return this;
      });
      vi.spyOn(net.Server.prototype, "address").mockReturnValue({
        address: "127.0.0.1",
        family: "IPv4",
        port: 18789,
      });
      vi.spyOn(net.Server.prototype, "close").mockImplementation(function (
        this: net.Server,
        callback,
      ) {
        queueMicrotask(() => callback?.());
        return this;
      });
      const entered = createDeferred();
      const sockets: net.Socket[] = [];
      const closed = new Set<net.Socket>();
      vi.spyOn(net, "connect").mockImplementation(() => {
        const socket = new net.Socket();
        sockets.push(socket);
        const completion = setTimeout(() => {
          if (answer === "connect") {
            socket.emit("connect");
          } else {
            socket.emit("error", Object.assign(new Error("connection refused"), { code: answer }));
          }
        }, delay);
        socket.destroy = () => {
          closed.add(socket);
          queueMicrotask(() => socket.emit("close"));
          return socket;
        };
        socket.setTimeout = (timeout, callback) => {
          const timer = setTimeout(() => callback?.(), timeout);
          socket.once("close", () => clearTimeout(timer));
          return socket;
        };
        socket.once("close", () => clearTimeout(completion));
        entered.resolve();
        return socket;
      });
      const result = waitForGatewayPortRelease(0, ["127.0.0.1"]).catch((error: unknown) => error);
      await entered.promise;
      await vi.advanceTimersByTimeAsync(6_000);
      const settled = await result;
      if (expected === true) {
        expect(settled).toBe(true);
      } else if (expected === "busy") {
        expect(settled).toBe(false);
      } else {
        expect(String(settled)).toContain("inconclusive");
        expect(String(settled)).not.toContain("still busy");
      }
      expect(closed.size).toBe(sockets.length);
    },
  );
});
