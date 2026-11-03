// Missing credentials must refuse the request before opening a socket on every platform.
import net from "node:net";
import { describe, expect, it, vi } from "vitest";
import { requestExecHostViaSocket } from "./exec-host.js";

describe("requestExecHostViaSocket", () => {
  it("returns null when socket credentials are missing", async () => {
    const connect = vi.spyOn(net.Socket.prototype, "connect");
    try {
      await expect(
        requestExecHostViaSocket({
          socketPath: "",
          token: "secret",
          request: { command: ["echo", "hi"] },
        }),
      ).resolves.toBeNull();
      await expect(
        requestExecHostViaSocket({
          socketPath: "/tmp/socket",
          token: "",
          request: { command: ["echo", "hi"] },
        }),
      ).resolves.toBeNull();
      expect(connect).not.toHaveBeenCalled();
    } finally {
      connect.mockRestore();
    }
  });
});
