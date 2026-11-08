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
vi.mock("../infra/widearea-dns.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/widearea-dns.js")>()),
  getWideAreaZonePath: () => testState.zonePath,
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
import * as tailnet from "../infra/tailnet.js";
import { replaceWideAreaZoneFile } from "../infra/widearea-dns.js";
import { defaultRuntime } from "../runtime.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import { registerDnsCli } from "./dns-cli.js";

function spawnOk(stdout = "") {
  return { stdout, stderr: "", pid: 1, output: [], status: 0, signal: null };
}

function isBrewPrefixProbe(call: unknown[]): boolean {
  return call[0] === "brew" && Array.isArray(call[1]) && call[1][0] === "--prefix";
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

  function runDnsSetup(args = ["--domain", domain, "--apply"]) {
    const program = new Command().exitOverride();
    registerDnsCli(program);
    return withMockedPlatform("darwin", () =>
      program.parseAsync(["node", "openclaw", "dns", "setup", ...args]),
    );
  }

  it("escapes the dry-run zone path without writing it or starting setup", async () => {
    testState.zonePath = path.join(brewPrefix, "café\x1b[31m\nforged\tzone\r\x00\x85end.db");
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);
    const json = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => undefined);
    await runDnsSetup(["--domain", domain]);

    const report = String(log.mock.calls[1]?.[0]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("DNS setup"));
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

  it("does not restart CoreDNS when asynchronous zone publication fails", async () => {
    const failure = new Error("zone publication failed");
    vi.mocked(replaceWideAreaZoneFile).mockRejectedValueOnce(failure);
    await expect(runDnsSetup()).rejects.toBe(failure);
    expect(spawnSyncMock.mock.calls.filter(([cmd]) => cmd === "sudo")).toEqual([]);
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

      await runDnsSetup();
      const probeCall = spawnSyncMock.mock.calls.find(isBrewPrefixProbe);
      expect(probeCall?.[2]).toMatchObject({ timeout: 15_000, killSignal: "SIGKILL" });
      const nonProbeCalls = spawnSyncMock.mock.calls.filter((call) => !isBrewPrefixProbe(call));
      expect(nonProbeCalls.length).toBeGreaterThan(0);
      for (const call of nonProbeCalls) {
        expect(call[2]?.timeout).toBeUndefined();
      }
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
      return spawnOk(isBrewPrefixProbe([cmd, args]) ? `${brewPrefix}\n` : "");
    });
    return expect(runDnsSetup()).rejects.toThrow(
      timeout
        ? "brew --prefix failed: timed out after 15 seconds (signal SIGKILL)"
        : "sudo brew services restart coredns failed: signal SIGTERM",
    );
  });

  it("keeps the previous Corefile when publication fails (#184888)", async () => {
    const corefilePath = path.join(brewPrefix, "etc", "coredns", "Corefile");
    fs.mkdirSync(path.dirname(corefilePath), { recursive: true });
    fs.writeFileSync(corefilePath, "old");
    // A crash or ENOSPC between staging and publication must not truncate it.
    const renameSync = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (to === corefilePath) {
        throw Object.assign(new Error("crash"), { code: "EIO" });
      }
      return renameSync(from, to);
    });

    await expect(runDnsSetup()).rejects.toThrow("crash");
    expect(fs.readFileSync(corefilePath, "utf-8")).toBe("old");
  });

  it("keeps an existing Corefile mode, group, and directory mode (#184888)", async () => {
    const etcDir = path.join(brewPrefix, "etc", "coredns");
    const corefilePath = path.join(etcDir, "Corefile");
    fs.mkdirSync(etcDir, { recursive: true });
    fs.chmodSync(etcDir, 0o755);
    fs.writeFileSync(corefilePath, "x", { mode: 0o640 });
    const groups = process.getgroups?.() ?? [];
    const gid = groups.find((group) => group !== fs.statSync(corefilePath).gid);
    if (gid !== undefined) {
      fs.chownSync(corefilePath, -1, gid);
    }

    await runDnsSetup();

    const published = fs.statSync(corefilePath);
    expect([published.mode & 0o7777, fs.statSync(etcDir).mode & 0o7777]).toEqual([0o640, 0o755]);
    if (gid !== undefined) {
      // A rename publishes a new inode; the operator's group must survive it.
      expect(published.gid).toBe(gid);
    }
  });

  it.each(["dangling chain", "linked import dir"])(
    "publishes the Corefile through a %s (#184888)",
    async (shape) => {
      const etcDir = path.join(brewPrefix, "etc", "coredns");
      fs.mkdirSync(etcDir, { recursive: true });
      if (shape === "dangling chain") {
        fs.symlinkSync("missing.conf", path.join(etcDir, "Corefile.link"));
        fs.symlinkSync("Corefile.link", path.join(etcDir, "Corefile"));
      } else {
        fs.symlinkSync(".", path.join(etcDir, "conf.d"));
      }

      await runDnsSetup();

      expect(fs.readFileSync(path.join(etcDir, "Corefile"), "utf-8")).toContain("import ");
    },
  );

  it("reports missing tailnet IP before starting setup", async () => {
    vi.spyOn(tailnet, "pickPrimaryTailnetIPv4").mockReturnValue(undefined);
    await expect(runDnsSetup()).rejects.toMatchObject({
      humanOutput: "no tailnet IP detected; check that Tailscale is running on this machine",
    });
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });
});
