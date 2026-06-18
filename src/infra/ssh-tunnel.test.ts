// Covers SSH target parsing and tunnel setup.
import { describe, expect, it, vi } from "vitest";
import { parseSshTarget } from "./ssh-tunnel.js";

const ensurePortAvailableMock = vi.hoisted(() => vi.fn());

vi.mock("./ports.js", () => ({
  ensurePortAvailable: (...args: unknown[]) => ensurePortAvailableMock(...args),
}));

describe("parseSshTarget", () => {
  it("parses user@host:port targets", () => {
    expect(parseSshTarget("me@example.com:2222")).toEqual({
      user: "me",
      host: "example.com",
      port: 2222,
    });
  });

  it("strips an ssh prefix and keeps the default port when missing", () => {
    expect(parseSshTarget(" ssh alice@example.com ")).toEqual({
      user: "alice",
      host: "example.com",
      port: 22,
    });
  });

  it("rejects invalid hosts and ports", () => {
    expect(parseSshTarget("")).toBeNull();
    expect(parseSshTarget("me@example.com:0")).toBeNull();
    expect(parseSshTarget("me@example.com:22abc")).toBeNull();
    expect(parseSshTarget("me@example.com:70000")).toBeNull();
    expect(parseSshTarget("me@example.com:not-a-port")).toBeNull();
    expect(parseSshTarget("-V")).toBeNull();
    expect(parseSshTarget("me@-badhost")).toBeNull();
    expect(parseSshTarget("-oProxyCommand=echo")).toBeNull();
  });
});

describe("startSshPortForward", () => {
  it("passes 127.0.0.1 as the host to ensurePortAvailable", async () => {
    // Throw a non-EADDRINUSE error so the function short-circuits before spawning SSH.
    ensurePortAvailableMock.mockRejectedValue(new Error("port check failed"));

    const { startSshPortForward } = await import("./ssh-tunnel.js");

    await expect(
      startSshPortForward({
        target: "test@localhost:22",
        localPortPreferred: 12345,
        remotePort: 8080,
        timeoutMs: 1000,
      }),
    ).rejects.toThrow("port check failed");

    expect(ensurePortAvailableMock).toHaveBeenCalledWith(12345, "127.0.0.1");
  });
});
