// Regression: the dns setup brew-prefix probe must be bounded by a SIGKILL-backed
// timeout so a hung binary cannot block `openclaw dns setup`, while long-running
// setup steps (install/restart/sudo writes) stay unbounded.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnSyncMock = vi.hoisted(() => vi.fn());
const testState = vi.hoisted(() => ({ zonePath: "" }));

vi.mock("node:child_process", async () => {
  const { mockNodeChildProcessSpawnSync } = await import("openclaw/plugin-sdk/test-node-mocks");
  return mockNodeChildProcessSpawnSync(spawnSyncMock, () =>
    vi.importActual<typeof import("node:child_process")>("node:child_process"),
  );
});

vi.mock("../infra/widearea-dns.js", async () => {
  return {
    getWideAreaZonePath: () => testState.zonePath,
    normalizeWideAreaDomain: (d: string) => d,
    replaceWideAreaZoneFile: vi.fn(),
    resolveWideAreaDiscoveryDomain: () => "openclaw.internal.",
  };
});

vi.mock("../infra/tailnet.js", async () => {
  return {
    pickPrimaryTailnetIPv4: () => "100.64.0.1",
    pickPrimaryTailnetIPv6: () => undefined,
  };
});

// mock-isolation: DNS fixtures use empty config without loading operator state.
vi.mock("../config/config.js", async () => {
  return {
    getRuntimeConfig: () => ({}),
    loadConfig: () => ({}),
    captureRuntimeConfigAsyncReader: () => async () => ({}),
  };
});

import { Command } from "commander";
import { defaultRuntime } from "../runtime.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import { registerDnsCli } from "./dns-cli.js";

function spawnOk(stdout = "") {
  return { stdout, stderr: "", pid: 1, output: [], status: 0, signal: null };
}

function isBrewPrefixProbe(call: unknown[]): boolean {
  const args = call[1] as string[] | undefined;
  return call[0] === "brew" && args?.[0] === "--prefix";
}

describe("dns-cli probe bounds", () => {
  let brewPrefix: string;

  beforeEach(() => {
    // A real writable temp prefix lets the un-mocked fs writes (Corefile, conf.d,
    // zone bootstrap) succeed on Linux CI without touching sudo paths.
    brewPrefix = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-dns-cli-test-"));
    testState.zonePath = path.join(brewPrefix, "test.zone");
    spawnSyncMock.mockReset();
    spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "brew" && args?.[0] === "--prefix") {
        return spawnOk(`${brewPrefix}\n`);
      }
      return spawnOk();
    });
  });

  afterEach(() => {
    fs.rmSync(brewPrefix, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function runDnsSetupApply(): Promise<void> {
    const program = new Command();
    program.exitOverride();
    registerDnsCli(program);
    // The action gates on process.platform; os.platform() is not consulted.
    await withMockedPlatform("darwin", () =>
      program.parseAsync([
        "node",
        "openclaw",
        "dns",
        "setup",
        "--domain",
        "openclaw.internal",
        "--apply",
      ]),
    );
  }

  it("escapes the dry-run zone path without writing it or starting setup", async () => {
    testState.zonePath = path.join(brewPrefix, "café\x1b[31m\nforged\tzone\r\x00\x85end.db");
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);
    const json = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => undefined);
    const program = new Command().exitOverride();
    registerDnsCli(program);
    await program.parseAsync(["node", "openclaw", "dns", "setup", "--domain", "openclaw.internal"]);

    const report = String(log.mock.calls[1]?.[0]);
    expect(report).toContain("café\\nforged\\tzone\\rend.db");
    expect(report).toContain("openclaw.internal.");
    expect(report.replaceAll("\n", "")).not.toMatch(/\p{Cc}/u);
    expect(json).toHaveBeenCalledWith({
      gateway: { bind: "auto" },
      discovery: { wideArea: { domain: "openclaw.internal." } },
    });
    expect(fs.readdirSync(brewPrefix)).toEqual([]);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("bounds the brew prefix probe with a SIGKILL-backed timeout", async () => {
    await runDnsSetupApply();

    const probeCall = spawnSyncMock.mock.calls.find(isBrewPrefixProbe);
    expect(probeCall).toBeDefined();
    expect(probeCall?.[2]).toMatchObject({ timeout: 15_000, killSignal: "SIGKILL" });
  });

  it("leaves long-running setup subprocesses unbounded", async () => {
    await runDnsSetupApply();

    const nonProbeCalls = spawnSyncMock.mock.calls.filter((call) => !isBrewPrefixProbe(call));
    expect(nonProbeCalls.length).toBeGreaterThan(0);
    for (const call of nonProbeCalls) {
      expect(call[2]?.timeout).toBeUndefined();
    }
  });
  it("names the deadline and signal when the brew prefix probe times out", async () => {
    spawnSyncMock.mockImplementation((cmd: string, args: string[]) =>
      cmd === "brew" && args[0] === "--prefix"
        ? {
            ...spawnOk(),
            status: null,
            signal: "SIGKILL",
            error: Object.assign(new Error("spawnSync brew ETIMEDOUT"), { code: "ETIMEDOUT" }),
          }
        : spawnOk(),
    );

    await expect(runDnsSetupApply()).rejects.toThrow(
      "brew --prefix failed: timed out after 15 seconds (signal SIGKILL)",
    );
  });

  it("names the signal when a setup step is killed", async () => {
    spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "brew" && args[0] === "--prefix") {
        return spawnOk(`${brewPrefix}\n`);
      }
      return cmd === "sudo" && args[0] === "brew"
        ? { ...spawnOk(), status: null, signal: "SIGTERM" }
        : spawnOk();
    });

    await expect(runDnsSetupApply()).rejects.toThrow(
      "sudo brew services restart coredns failed: signal SIGTERM",
    );
  });
});
