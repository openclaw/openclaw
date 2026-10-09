import net from "node:net";
import { describe, expect, it, vi } from "vitest";
import { probePortUsage } from "./ports-probe.js";

function denyBind() {
  return vi.spyOn(net.Server.prototype, "listen").mockImplementation(function (this: net.Server) {
    process.nextTick(() =>
      this.emit("error", Object.assign(new Error("listen EACCES"), { code: "EACCES" })),
    );
    return this;
  });
}

describe("denied port binds", () => {
  it.for([
    { platform: "win32", answer: "connect", expected: "busy" },
    { platform: "win32", answer: "ECONNREFUSED", expected: "unknown" },
    { platform: "win32", answer: "EACCES", expected: "unknown" },
    { platform: "win32", answer: "timeout", expected: "unknown" },
    { platform: "linux", answer: "connect", expected: "unknown" },
    { platform: "darwin", answer: "connect", expected: "unknown" },
  ] as const)(
    "reports $expected on $platform with TCP answer $answer",
    async ({ platform, answer, expected }) => {
      const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue(platform);
      const listen = denyBind();
      let socket: net.Socket | undefined;
      const connect = vi.spyOn(net, "connect").mockImplementation(() => {
        socket = new net.Socket();
        const current = socket;
        vi.spyOn(current, "setTimeout").mockImplementation((timeout, callback) => {
          expect(timeout).toBe(250);
          if (callback) {
            current.once("timeout", callback);
          }
          return current;
        });
        process.nextTick(() => {
          if (answer === "connect" || answer === "timeout") {
            current.emit(answer);
          } else {
            current.destroy(Object.assign(new Error(`connect ${answer}`), { code: answer }));
          }
        });
        return current;
      });
      try {
        await expect(probePortUsage(18889, ["127.0.0.1"])).resolves.toBe(expected);
        expect(connect).toHaveBeenCalledTimes(platform === "win32" ? 1 : 0);
        if (socket) {
          expect(socket.destroyed).toBe(true);
        }
      } finally {
        socket?.destroy();
        listen.mockRestore();
        connect.mockRestore();
        platformSpy.mockRestore();
      }
    },
  );

  it("cancels TCP confirmation before probing another host", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const controller = new AbortController();
    const reason = new Error("port observation cancelled");
    const listen = denyBind();
    const socket = new net.Socket();
    const connect = vi.spyOn(net, "connect").mockImplementation(() => {
      process.nextTick(() => controller.abort(reason));
      return socket;
    });
    try {
      await expect(
        probePortUsage(18889, ["127.0.0.1", "127.0.0.2"], controller.signal),
      ).rejects.toBe(reason);
      expect(connect).toHaveBeenCalledOnce();
      expect(listen).toHaveBeenCalledOnce();
      expect(socket.destroyed).toBe(true);
    } finally {
      socket.destroy();
      listen.mockRestore();
      connect.mockRestore();
      platformSpy.mockRestore();
    }
  });
});
