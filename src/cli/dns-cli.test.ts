// Regression: dns-cli subprocess probes (DNS lookup + sudo tee) must be bounded
// by a timeout so a hung binary cannot block `openclaw dns setup`.
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const { mockNodeChildProcessSpawnSync } = await import("openclaw/plugin-sdk/test-node-mocks");
  return mockNodeChildProcessSpawnSync(spawnSyncMock, () =>
    vi.importActual<typeof import("node:child_process")>("node:child_process"),
  );
});

vi.mock("../infra/widearea-dns.js", async () => {
  return {
    getWideAreaZonePath: () => "/tmp/openclaw-dns-test.zone",
    normalizeWideAreaDomain: (d: string) => d,
    resolveWideAreaDiscoveryDomain: () => "openclaw.internal.",
  };
});

vi.mock("../infra/tailnet.js", async () => {
  return {
    pickPrimaryTailnetIPv4: () => "100.64.0.1",
    pickPrimaryTailnetIPv6: () => undefined,
  };
});

vi.mock("../config/config.js", async () => {
  return { getRuntimeConfig: () => ({}) };
});

import { Command } from "commander";
import os from "node:os";
import { registerDnsCli } from "./dns-cli.js";

describe("dns-cli probe bounds", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes a timeout to spawned dns setup subprocesses", async () => {
    vi.spyOn(os, "platform").mockReturnValue("darwin");
    spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "brew" && args?.[0] === "--prefix") {
        return {
          stdout: "/opt/homebrew",
          stderr: "",
          pid: 1,
          output: [],
          status: 0,
          signal: null,
        };
      }
      return {
        stdout: "",
        stderr: "",
        pid: 1,
        output: [],
        status: 0,
        signal: null,
      };
    });

    const program = new Command();
    program.exitOverride();
    registerDnsCli(program);

    await program.parseAsync(["node", "openclaw", "dns", "setup", "--domain", "openclaw.internal", "--apply"]);

    const spawned = spawnSyncMock.mock.calls;
    expect(spawned.length).toBeGreaterThan(0);
    for (const [, , opts] of spawned) {
      expect(opts?.timeout).toBeGreaterThan(0);
    }
  });
});
