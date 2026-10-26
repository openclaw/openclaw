import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnSyncMock = vi.hoisted(() => vi.fn());
const testState = vi.hoisted(() => ({ zonePath: "" }));
const domain = "openclaw.internal";

vi.mock("node:child_process", async () => {
  const { mockNodeChildProcessSpawnSync } = await import("openclaw/plugin-sdk/test-node-mocks");
  return mockNodeChildProcessSpawnSync(spawnSyncMock, () =>
    vi.importActual<typeof import("node:child_process")>("node:child_process"),
  );
});

// mock-isolation: DNS setup uses only synthetic zone paths and never writes an operator zone.
vi.mock("../infra/widearea-dns.js", () => ({
  getWideAreaZonePath: () => testState.zonePath,
  normalizeWideAreaDomain: (d: string) => d,
  replaceWideAreaZoneFile: vi.fn(),
  resolveWideAreaDiscoveryDomain: () => "openclaw.internal.",
}));

// mock-isolation: Fixed Tailnet addresses keep setup independent of host network state.
vi.mock("../infra/tailnet.js", () => ({
  pickPrimaryTailnetIPv4: () => "100.64.0.1",
  pickPrimaryTailnetIPv6: () => undefined,
}));

// mock-isolation: DNS fixtures use empty config without loading operator state.
vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => ({}),
  loadConfig: () => ({}),
  captureRuntimeConfigAsyncReader: () => async () => ({}),
}));

import { Command } from "commander";
import { replaceWideAreaZoneFile } from "../infra/widearea-dns.js";
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
    // Real writes stay in a writable prefix, including on Linux CI.
    brewPrefix = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-dns-cli-test-"));
    testState.zonePath = path.join(brewPrefix, "test.zone");
    spawnSyncMock.mockReset();
    spawnSyncMock.mockImplementation((cmd: string, args: string[]) =>
      spawnOk(isBrewPrefixProbe([cmd, args]) ? `${brewPrefix}\n` : ""),
    );
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
      program.parseAsync(["node", "openclaw", "dns", "setup", "--domain", domain, "--apply"]),
    );
  }

  it("escapes the dry-run zone path without writing it or starting setup", async () => {
    testState.zonePath = path.join(brewPrefix, "café\x1b[31m\nforged\tzone\r\x00\x85end.db");
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);
    const json = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => undefined);
    const program = new Command().exitOverride();
    registerDnsCli(program);
    await program.parseAsync(["node", "openclaw", "dns", "setup", "--domain", domain]);

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

  it("bounds only the brew prefix probe with a SIGKILL-backed timeout", async () => {
    await runDnsSetupApply();

    const probeCall = spawnSyncMock.mock.calls.find(isBrewPrefixProbe);
    expect(probeCall?.[2]).toMatchObject({ timeout: 15_000, killSignal: "SIGKILL" });
    const nonProbeCalls = spawnSyncMock.mock.calls.filter((call) => !isBrewPrefixProbe(call));
    expect(nonProbeCalls.length).toBeGreaterThan(0);
    for (const call of nonProbeCalls) {
      expect(call[2]?.timeout).toBeUndefined();
    }
  });

  it("does not restart CoreDNS when asynchronous zone publication fails", async () => {
    const failure = new Error("zone publication failed");
    vi.mocked(replaceWideAreaZoneFile).mockRejectedValueOnce(failure);
    await expect(runDnsSetupApply()).rejects.toBe(failure);
    expect(spawnSyncMock).not.toHaveBeenCalledWith(
      "sudo",
      ["brew", "services", "restart", "coredns"],
      expect.anything(),
    );
  });

  it.each([true, false])(
    "finishes setup for an existing Corefile with the import already present: %s",
    async (hasImport) => {
      const etcDir = path.join(brewPrefix, "etc", "coredns");
      const importGlob = path.join(etcDir, "conf.d", "*.server");
      const corefilePath = path.join(etcDir, "Corefile");
      const original = `.:53 {\n  errors\n}\n${hasImport ? `import ${importGlob}\n` : ""}`;
      fs.mkdirSync(etcDir, { recursive: true });
      fs.writeFileSync(corefilePath, original);

      await runDnsSetupApply();

      expect(fs.readFileSync(corefilePath, "utf-8")).toBe(
        hasImport ? original : `.:53 {\n  errors\n}\n\nimport ${importGlob}\n`,
      );
      const serverPath = path.join(etcDir, "conf.d", "openclaw.internal.server");
      const server = fs.readFileSync(serverPath, "utf-8");
      expect(server).toContain("openclaw.internal:53 {");
      expect(server).toContain("  bind 100.64.0.1");
      expect(server).toContain(`  file ${testState.zonePath} {`);
      expect(spawnSyncMock).toHaveBeenCalledWith(
        "sudo",
        ["brew", "services", "restart", "coredns"],
        expect.objectContaining({ stdio: "inherit" }),
      );
    },
  );

  it.each(["SIGKILL", "SIGTERM"])("reports %s subprocess failures", (signal) => {
    const timeout = signal === "SIGKILL";
    const error = timeout
      ? Object.assign(new Error("spawnSync brew ETIMEDOUT"), { code: "ETIMEDOUT" })
      : undefined;
    spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (timeout ? isBrewPrefixProbe([cmd, args]) : cmd === "sudo" && args[0] === "brew") {
        return { ...spawnOk(), status: null, signal, ...(error ? { error } : {}) };
      }
      if (cmd === "brew" && args[0] === "--prefix") {
        return spawnOk(`${brewPrefix}\n`);
      }
      return spawnOk();
    });
    return expect(runDnsSetupApply()).rejects.toThrow(
      timeout
        ? "brew --prefix failed: timed out after 15 seconds (signal SIGKILL)"
        : "sudo brew services restart coredns failed: signal SIGTERM",
    );
  });
});
