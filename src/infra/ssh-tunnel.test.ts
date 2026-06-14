// Covers SSH target parsing and the trusted ssh client resolution guard.
import { describe, expect, it, vi } from "vitest";
import { resolveSystemBin } from "./resolve-system-bin.js";
import { parseSshTarget, startSshPortForward } from "./ssh-tunnel.js";

vi.mock("./resolve-system-bin.js", () => ({
  resolveSystemBin: vi.fn(() => "/usr/bin/ssh"),
}));

const resolveSystemBinMock = vi.mocked(resolveSystemBin);

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
  it("fails closed with a clear diagnostic when no trusted ssh client is found", async () => {
    resolveSystemBinMock.mockReturnValueOnce(null);

    await expect(
      startSshPortForward({
        target: "me@example.com",
        localPortPreferred: 12345,
        remotePort: 8080,
        timeoutMs: 100,
      }),
    ).rejects.toThrow(/no trusted SSH client found/);
  });
});
