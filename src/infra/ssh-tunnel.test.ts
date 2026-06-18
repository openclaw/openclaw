// Covers SSH target parsing and tunnel startup preflight behavior.
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensurePortAvailable: vi.fn<(port: number, host?: string) => Promise<void>>(),
}));

vi.mock("./ports.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ports.js")>()),
  ensurePortAvailable: mocks.ensurePortAvailable,
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

describe("startSshPortForward", () => {
  it("scopes the preferred-port preflight to the IPv4 loopback interface", async () => {
    const sentinel = new Error("stop before spawning ssh");
    mocks.ensurePortAvailable.mockRejectedValueOnce(sentinel);

    await expect(
      startSshPortForward({
        target: "me@example.com:2222",
        localPortPreferred: 43210,
        remotePort: 18789,
        timeoutMs: 250,
      }),
    ).rejects.toBe(sentinel);

    expect(mocks.ensurePortAvailable).toHaveBeenCalledWith(43210, "127.0.0.1");
  });
});
