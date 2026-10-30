import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnSyncMock = vi.hoisted(() => vi.fn());
const testState = vi.hoisted(() => ({ zonePath: "" }));
const domain = "openclaw.internal";
const unix = process.platform === "win32" ? it.skip : it;

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

/**
 * Model a full disk during the CoreDNS configuration publication.
 *
 * The fault covers every write the publication performs in the Corefile
 * directory, so it reaches both a truncating in-place write and a staged
 * sibling write. The staged variant never touches the destination, which is
 * exactly the difference the regression asserts.
 */
function failCorefilePublicationWithNoSpace(targetDir: string): void {
  const originalWriteFileSync = fs.writeFileSync;
  const originalOpenSync = fs.openSync;
  const isPublicationPath = (target: unknown): boolean =>
    typeof target === "string" && path.dirname(target) === targetDir;
  const noSpace = () =>
    Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
  vi.spyOn(fs, "writeFileSync").mockImplementation((file, data, options) => {
    if (!isPublicationPath(file)) {
      originalWriteFileSync(file, data, options);
      return;
    }
    // A truncating write empties the destination before it fails.
    const partial =
      typeof data === "string" ? data.slice(0, Math.max(1, Math.floor(data.length / 2))) : data;
    originalWriteFileSync(file, partial, options);
    throw noSpace();
  });
  vi.spyOn(fs, "openSync").mockImplementation((target, flags, mode) => {
    if (isPublicationPath(target)) {
      throw noSpace();
    }
    return originalOpenSync(target, flags, mode);
  });
}

describe("dns-cli probe bounds", () => {
  let brewPrefix: string;

  beforeEach(() => {
    // Real writes stay in a writable prefix, including on Linux CI.
    brewPrefix = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-dns-cli-test-"));
    testState.zonePath = path.join(brewPrefix, "test.zone");
    spawnSyncMock.mockReset();
    spawnSyncMock.mockImplementation((cmd: string, args: string[], opts?: { input?: string }) => {
      if (isBrewPrefixProbe([cmd, args])) {
        return spawnOk(`${brewPrefix}\n`);
      }
      // The privileged publish fallback stages and renames through the real
      // filesystem so its staged-rename contract holds in tests; sudo itself
      // is unavailable on CI hosts, so only the file effects are simulated.
      // chown is a no-op: an unprivileged simulator cannot change ownership,
      // and the fixtures keep the invoking account's uid and gid.
      if (cmd === "sudo" && args[0] === "install") {
        const [, modeFlag, mode, , staged] = args;
        if (modeFlag === "-m" && typeof mode === "string" && typeof staged === "string") {
          fs.writeFileSync(staged, "");
          fs.chmodSync(staged, Number.parseInt(mode, 8));
        }
        return spawnOk();
      }
      if (cmd === "sudo" && args[0] === "tee" && typeof opts?.input === "string") {
        const staged = args[1];
        if (typeof staged !== "string") {
          return spawnOk();
        }
        try {
          fs.writeFileSync(staged, opts.input);
          return spawnOk();
        } catch (error) {
          return { ...spawnOk(), status: 1, error: error as Error };
        }
      }
      if (cmd === "sudo" && args[0] === "chmod") {
        const [mode, target] = args.slice(1);
        if (typeof mode === "string" && typeof target === "string") {
          fs.chmodSync(target, Number.parseInt(mode, 8));
        }
        return spawnOk();
      }
      if (cmd === "sudo" && args[0] === "mv") {
        const [source, destination] = args.slice(1).filter((arg) => !arg.startsWith("-"));
        if (typeof source === "string" && typeof destination === "string") {
          fs.renameSync(source, destination);
        }
        return spawnOk();
      }
      if (cmd === "sudo" && args[0] === "rm" && args[1] === "-f" && typeof args[2] === "string") {
        fs.rmSync(args[2], { force: true });
        return spawnOk();
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
    await expect(runDnsSetupApply()).rejects.toBe(failure);
    expect(spawnSyncMock).not.toHaveBeenCalledWith(
      "sudo",
      ["brew", "services", "restart", "coredns"],
      expect.anything(),
    );
  });

  it("preserves the existing Corefile when its publication fails", async () => {
    const etcDir = path.join(brewPrefix, "etc", "coredns");
    const corefilePath = path.join(etcDir, "Corefile");
    const original = ".:53 {\n  errors\n}\n";
    fs.mkdirSync(etcDir, { recursive: true });
    fs.writeFileSync(corefilePath, original);
    failCorefilePublicationWithNoSpace(etcDir);

    await expect(runDnsSetupApply()).rejects.toThrow(/ENOSPC|no space left on device/);

    // The failed publication left the operator's Corefile exactly as it was.
    expect(fs.readFileSync(corefilePath, "utf-8")).toBe(original);
    // CoreDNS keeps serving the previous configuration; nothing was restarted.
    expect(spawnSyncMock).not.toHaveBeenCalledWith(
      "sudo",
      ["brew", "services", "restart", "coredns"],
      expect.anything(),
    );
  });

  unix("keeps the staged configuration private until the operator's mode is restored", async () => {
    const etcDir = path.join(brewPrefix, "etc", "coredns");
    const corefilePath = path.join(etcDir, "Corefile");
    fs.mkdirSync(etcDir, { recursive: true });
    fs.writeFileSync(corefilePath, ".:53 {\n  errors\n}\n");
    fs.chmodSync(corefilePath, 0o640);
    // The staged sibling is created by the invoking account, whose group
    // differs from the operator's file group. Observe the staged file at the
    // ownership hand-off: it holds the configuration bytes there, and no
    // account outside the operator's readership may be able to read it.
    const stagedModes: number[] = [];
    const originalChownSync = fs.chownSync;
    const chownSpy = vi.spyOn(fs, "chownSync").mockImplementation((...args) => {
      const stagedPath = args[0];
      if (typeof stagedPath === "string") {
        stagedModes.push(fs.statSync(stagedPath).mode & 0o777);
      }
      return originalChownSync(...args);
    });

    try {
      await runDnsSetupApply();
    } finally {
      chownSpy.mockRestore();
    }

    // The staged file was still private while it held the configuration.
    expect(stagedModes.length).toBeGreaterThan(0);
    for (const mode of stagedModes) {
      expect(mode).toBe(0o600);
    }
    // The published file carries the operator's mode.
    expect(fs.statSync(corefilePath).mode & 0o777).toBe(0o640);
  });

  unix("keeps the operator's Corefile mode across a successful publication", async () => {
    const etcDir = path.join(brewPrefix, "etc", "coredns");
    const corefilePath = path.join(etcDir, "Corefile");
    const importGlob = path.join(etcDir, "conf.d", "*.server");
    fs.mkdirSync(etcDir, { recursive: true });
    fs.writeFileSync(corefilePath, ".:53 {\n  errors\n}\n");
    fs.chmodSync(corefilePath, 0o640);

    await runDnsSetupApply();

    expect(fs.readFileSync(corefilePath, "utf-8")).toBe(
      `.:53 {\n  errors\n}\n\nimport ${importGlob}\n`,
    );
    expect(fs.statSync(corefilePath).mode & 0o777).toBe(0o640);
  });

  unix("publishes through a symlinked Corefile to its managed target", async () => {
    const etcDir = path.join(brewPrefix, "etc", "coredns");
    const corefilePath = path.join(etcDir, "Corefile");
    const importGlob = path.join(etcDir, "conf.d", "*.server");
    fs.mkdirSync(etcDir, { recursive: true });
    const managedPath = path.join(etcDir, "managed-Corefile");
    fs.writeFileSync(managedPath, ".:53 {\n  errors\n}\n");
    fs.symlinkSync("managed-Corefile", corefilePath);

    await runDnsSetupApply();

    expect(fs.readFileSync(managedPath, "utf-8")).toBe(
      `.:53 {\n  errors\n}\n\nimport ${importGlob}\n`,
    );
    // The operator's link survives; the target's content was replaced.
    expect(fs.lstatSync(corefilePath).isSymbolicLink()).toBe(true);
  });

  unix("creates a dangling Corefile link's target like the plain write did", async () => {
    const etcDir = path.join(brewPrefix, "etc", "coredns");
    const corefilePath = path.join(etcDir, "Corefile");
    const importGlob = path.join(etcDir, "conf.d", "*.server");
    fs.mkdirSync(etcDir, { recursive: true });
    fs.symlinkSync("managed-Corefile", corefilePath);

    await runDnsSetupApply();

    expect(fs.readFileSync(path.join(etcDir, "managed-Corefile"), "utf-8")).toContain(
      `import ${importGlob}`,
    );
    expect(fs.lstatSync(corefilePath).isSymbolicLink()).toBe(true);
  });

  unix(
    "publishes through the privileged path when ownership hand-off is refused",
    { timeout: 30_000 },
    async () => {
      const etcDir = path.join(brewPrefix, "etc", "coredns");
      const corefilePath = path.join(etcDir, "Corefile");
      const importGlob = path.join(etcDir, "conf.d", "*.server");
      fs.mkdirSync(etcDir, { recursive: true });
      fs.writeFileSync(corefilePath, ".:53 {\n  errors\n}\n");
      fs.chmodSync(corefilePath, 0o640);
      // Model a Corefile whose group the invoking account cannot set (a real
      // POSIX refusal that unprivileged CI cannot arrange): the ordinary
      // publisher's ownership hand-off fails EPERM and publication routes
      // through the privileged staged path.
      const chownSpy = vi.spyOn(fs, "chownSync").mockImplementation(() => {
        throw Object.assign(new Error("EPERM: operation not permitted, chown"), {
          code: "EPERM",
        });
      });

      try {
        await runDnsSetupApply();
      } finally {
        chownSpy.mockRestore();
      }

      expect(fs.readFileSync(corefilePath, "utf-8")).toBe(
        `.:53 {\n  errors\n}\n\nimport ${importGlob}\n`,
      );
      // The privileged publisher restored the operator's metadata before the
      // rename published the staged file.
      expect(fs.statSync(corefilePath).mode & 0o777).toBe(0o640);
      // Staging stayed private: the 0600 sibling was created before any
      // configuration byte was written into it.
      const sudoCalls = spawnSyncMock.mock.calls.filter((call) => call[0] === "sudo");
      const installIndex = sudoCalls.findIndex((call) => (call[1] as string[])[0] === "install");
      const teeIndex = sudoCalls.findIndex((call) => (call[1] as string[])[0] === "tee");
      expect(installIndex).toBeGreaterThanOrEqual(0);
      expect(teeIndex).toBeGreaterThan(installIndex);
      // The privileged publisher flushed the staged bytes before publishing.
      const syncIndex = sudoCalls.findIndex((call) => (call[1] as string[])[0] === "sync");
      const moveIndex = sudoCalls.findIndex((call) => (call[1] as string[])[0] === "mv");
      expect(syncIndex).toBeGreaterThanOrEqual(0);
      expect(syncIndex).toBeLessThan(moveIndex);
      // No staging sibling survived publication.
      expect(fs.readdirSync(etcDir).filter((entry) => entry.startsWith(".Corefile"))).toEqual([]);
    },
  );

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
