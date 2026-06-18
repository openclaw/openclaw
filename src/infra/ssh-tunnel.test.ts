// Covers SSH target parsing and SSH tunnel port allocation.
import { describe, expect, it, vi } from "vitest";

const ensurePortAvailableMock = vi.hoisted(() => vi.fn());

vi.mock("./ports.js", () => ({
  ensurePortAvailable: (...args: unknown[]) => ensurePortAvailableMock(...args),
}));

import { parseSshTarget, startSshPortForward } from "./ssh-tunnel.js";

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

describe("startSshPortForward port probe", () => {
  it("probes the IPv4 loopback owned by the forward, not the wildcard bind", async () => {
    // The SSH forward binds 127.0.0.1 (-L localPort:127.0.0.1:remotePort), so the
    // preflight must scope the probe to that interface. A host-less probe would bind
    // the IPv6 wildcard `::` and miss an IPv4-only occupant (#94596).
    const probeError = new Error("probe interrupted");
    ensurePortAvailableMock.mockImplementation(async () => {
      throw probeError;
    });

    // A non-EADDRINUSE error surfaces before ssh is spawned, so this never reaches
    // the child process.
    await expect(
      startSshPortForward({
        target: "user@example.com:22",
        localPortPreferred: 54321,
        remotePort: 22,
        timeoutMs: 1000,
      }),
    ).rejects.toBe(probeError);

    expect(ensurePortAvailableMock).toHaveBeenCalledWith(54321, "127.0.0.1");
    expect(ensurePortAvailableMock).toHaveBeenCalledTimes(1);
  });
});
