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

  it("refuses a request the macOS app cannot read before opening a socket", async () => {
    const connect = vi.spyOn(net.Socket.prototype, "connect");
    try {
      // Half a MiB of two-byte characters exceeds the wire limit, but not in UTF-16 units.
      const response = await requestExecHostViaSocket({
        socketPath: "/tmp/socket",
        token: "secret",
        request: { command: ["/bin/sh", "-c", `echo ${"é".repeat(512 * 1024)}`] },
      });
      expect(response).toMatchObject({
        ok: false,
        error: { code: "INVALID_REQUEST", reason: "too-large" },
      });
      expect(connect).not.toHaveBeenCalled();
    } finally {
      connect.mockRestore();
    }
  });
});
