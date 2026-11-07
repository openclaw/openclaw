import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnSyncMock = vi.hoisted(() => vi.fn());
const testState = vi.hoisted(() => ({ zonePath: "" }));
const domain = "openclaw.internal";
const realPlatform = process.platform;
const unix = process.platform === "win32" ? it.skip : it;

vi.mock("node:child_process", async () => {
  const { mockNodeChildProcessSpawnSync } = await import("openclaw/plugin-sdk/test-node-mocks");
  return mockNodeChildProcessSpawnSync(spawnSyncMock, () =>
    vi.importActual<typeof import("node:child_process")>("node:child_process"),
  );
});

const fsSafeMock = vi.hoisted(() => ({ failPublication: null as Error | null }));
vi.mock("@openclaw/fs-safe/atomic", async (original) => {
  const actual = await original<typeof import("@openclaw/fs-safe/atomic")>();
  return {
    ...actual,
    replaceFileAtomicSync: (options: Parameters<typeof actual.replaceFileAtomicSync>[0]) => {
      if (fsSafeMock.failPublication) {
        throw fsSafeMock.failPublication;
      }
      return actual.replaceFileAtomicSync(options);
    },
  };
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

const { spawnSync: actualSpawnSync } =
  await vi.importActual<typeof import("node:child_process")>("node:child_process");

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
  // Assigned in beforeEach; every test runs after it, so the mock layering
  // below can delegate to it through optional chaining.
  let baseSpawnImplementation:
    | ((
        cmd: string,
        args: string[],
        opts?: { input?: string },
      ) => import("node:child_process").SpawnSyncReturns<string>)
    | undefined;

  beforeEach(() => {
    // Real writes stay in a writable prefix, including on Linux CI.
    brewPrefix = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-dns-cli-test-"));
    testState.zonePath = path.join(brewPrefix, "test.zone");
    spawnSyncMock.mockReset();
    baseSpawnImplementation = (cmd: string, args: string[], opts?: { input?: string }) => {
      if (isBrewPrefixProbe([cmd, args])) {
        return spawnOk(`${brewPrefix}\n`);
      }
      if (cmd === "sudo" && args[0] === process.execPath && args[1] === "-e") {
        const script = args[2];
        if (typeof script !== "string") {
          return spawnOk();
        }
        if (script.includes("fsyncSync")) {
          return spawnOk();
        }
        if (script.includes("lstatSync")) {
          const requested = args[3];
          if (typeof requested !== "string") {
            return spawnOk();
          }
          try {
            let cur = path.resolve(requested);
            for (let hops = 0; hops < 32; hops += 1) {
              const st = fs.lstatSync(cur, { throwIfNoEntry: false });
              if (!st?.isSymbolicLink()) {
                break;
              }
              const link = fs.readlinkSync(cur);
              cur = path.isAbsolute(link) ? link : path.join(path.dirname(cur), link);
            }
            const inspected = fs.statSync(cur, { throwIfNoEntry: false });
            let acl: string[] = [];
            if (realPlatform === "darwin") {
              const listed = actualSpawnSync("/bin/ls", ["-lde", cur], { encoding: "utf-8" });
              if (listed.status !== 0) {
                return { ...spawnOk(), status: 1, stderr: listed.stderr ?? "" };
              }
              acl = (listed.stdout ?? "")
                .split("\n")
                .map((line) => line.trim())
                .filter((line) => /^\d+:\s/.test(line))
                .map((line) => line.replace(/^\d+:\s*/, ""));
            }
            // Fresh destinations carry the parent's inherited policy in the
            // real inspection; the emulation keeps it empty off macOS.
            let inheritedParent: string[] = [];
            if (realPlatform === "darwin" && !inspected) {
              const parentListing = actualSpawnSync("/bin/ls", ["-lde", path.dirname(cur)], {
                encoding: "utf-8",
              });
              inheritedParent = String(parentListing.stdout ?? "")
                .split("\n")
                .map((line) => line.trim())
                .filter((line) => /^\d+:\s/.test(line) && line.includes("file_inherit"))
                .map((line) =>
                  line
                    .replace(/^\d+:\s*/, "")
                    .replace(/file_inherit/g, "")
                    .replace(/directory_inherit/g, "")
                    .replace(/limit_inherit/g, "")
                    .replace(/only_inherit/g, "")
                    .replace(/\s+/g, " ")
                    .trim(),
                )
                .filter((entry) => entry.length > 0);
            }
            return spawnOk(
              JSON.stringify({
                target: cur,
                existing: inspected
                  ? {
                      uid: inspected.uid,
                      gid: inspected.gid,
                      mode: inspected.mode & 0o7777,
                    }
                  : undefined,
                acl,
                inheritedParent,
              }),
            );
          } catch {
            return spawnOk(
              JSON.stringify({
                target: requested,
                existing: undefined,
                acl: [],
                inheritedParent: [],
              }),
            );
          }
        }
        return spawnOk();
      }
      if (cmd === "chmod" || cmd === "/bin/chmod") {
        // The ACL forms (+a#/-N) delegate to the real chmod so the policy
        // survives; numeric modes apply directly.
        if (args[0] !== undefined && ["+a#", "+a", "-N"].includes(String(args[0]))) {
          return actualSpawnSync("chmod", args, { encoding: "utf-8" });
        }
        if (cmd === "/bin/chmod") {
          return actualSpawnSync("chmod", args, { encoding: "utf-8" });
        }
        const [mode, target] = args;
        if (typeof mode === "string" && typeof target === "string") {
          fs.chmodSync(target, Number.parseInt(mode, 8));
        }
        return spawnOk();
      }
      if (cmd === "ls" || cmd === "/bin/ls") {
        if (realPlatform !== "darwin") {
          const target = args.at(-1);
          const listing =
            typeof target === "string" ? `-rw-r--r--@ 1 operator staff 0 0 ${target}\n` : "";
          return { ...spawnOk(listing), status: 0 };
        }
        return actualSpawnSync("ls", args, { encoding: "utf-8" });
      }
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
        // The access-policy restore uses the ACL forms of chmod (+a# for the
        // positional restore, -N for the inherited-grant strip); both have to
        // run for real so the policy survives the publication. The -N strip
        // is macOS-only behavior: hosts without macOS ACL semantics have
        // nothing inherited to strip.
        if (mode === "+a#" || mode === "+a") {
          return actualSpawnSync("chmod", args.slice(1), { encoding: "utf-8" });
        }
        if (mode === "-N") {
          if (realPlatform !== "darwin") {
            return spawnOk();
          }
          return actualSpawnSync("chmod", args.slice(1), { encoding: "utf-8" });
        }
        if (typeof mode === "string" && typeof target === "string") {
          fs.chmodSync(target, Number.parseInt(mode, 8));
        }
        return spawnOk();
      }
      if ((cmd === "chmod" || cmd === "/bin/chmod") && args[0] === "+a#") {
        return actualSpawnSync("chmod", args, { encoding: "utf-8" });
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
    };
    spawnSyncMock.mockImplementation((cmd: string, args: string[], opts?: { input?: string }) =>
      baseSpawnImplementation?.(cmd, args, opts),
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

  // The privileged first creation runs the real inspection script end to end:
  // a root-owned setup directory forces the fallback, the CLI's own sudo calls
  // execute for real, and a destination that has never been created must come
  // back with an empty access policy instead of a capture failure.
  it.runIf(realPlatform === "darwin")(
    "creates a fresh Corefile behind a root-owned setup directory",
    { timeout: 30_000 },
    async () => {
      const etcDir = path.join(brewPrefix, "etc", "coredns");
      const corefilePath = path.join(etcDir, "Corefile");
      const importGlob = path.join(etcDir, "conf.d", "*.server");
      fs.mkdirSync(etcDir, { recursive: true });
      fs.mkdirSync(path.join(etcDir, "conf.d"));
      // Modes are set while the runner still owns the tree; the chown is the
      // last fixture step, because a runner-side chmod after it would EPERM.
      fs.chmodSync(etcDir, 0o755);
      fs.chmodSync(path.join(etcDir, "conf.d"), 0o700);
      const grant = actualSpawnSync("sudo", ["-n", "chown", "root:wheel", etcDir], {
        encoding: "utf-8",
      });
      if (grant.status !== 0) {
        // Passwordless sudo is unavailable; the boundary stays covered by the
        // mocked regressions.
        return;
      }

      spawnSyncMock.mockImplementation((cmd: string, args: string[], opts?: { input?: string }) => {
        // The CLI's privileged publication calls execute for real; only the
        // brew steps stay simulated, so no service is touched.
        if (cmd === "sudo" && args[0] !== "brew") {
          return actualSpawnSync(cmd, args, { encoding: "utf-8", ...opts });
        }
        return baseSpawnImplementation?.(cmd, args, opts);
      });

      try {
        await runDnsSetup();
      } finally {
        spawnSyncMock.mockImplementation((cmd: string, args: string[], opts?: { input?: string }) =>
          baseSpawnImplementation?.(cmd, args, opts),
        );
        actualSpawnSync("sudo", ["-n", "chown", "-R", process.env.USER ?? "runner", etcDir], {
          encoding: "utf-8",
        });
      }

      expect(fs.readFileSync(corefilePath, "utf-8")).toBe(`import ${importGlob}\n`);
    },
  );

  // The excluded reader's denial has to hold while the staged file holds the
  // configuration: sample the root-written staging file in the wrapper, at the
  // call that widens its mode, and confirm the access policy is already in
  // place and its mode is still private at that moment.
  it.runIf(realPlatform === "darwin")(
    "keeps the excluded reader denied through the privileged restoration",
    { timeout: 30_000 },
    async () => {
      const etcDir = path.join(brewPrefix, "etc", "coredns");
      const corefilePath = path.join(etcDir, "Corefile");
      const importGlob = path.join(etcDir, "conf.d", "*.server");
      // Traversable ancestors first: an excluded principal must be able to
      // reach the files, or a denial proves nothing about the file policy.
      fs.chmodSync(brewPrefix, 0o755);
      fs.mkdirSync(etcDir, { recursive: true });
      fs.mkdirSync(path.join(etcDir, "conf.d"));
      fs.writeFileSync(corefilePath, ".:53 {\n  errors\n}\n");
      fs.chmodSync(corefilePath, 0o644);
      const controlFile = path.join(etcDir, "control.txt");
      fs.writeFileSync(controlFile, "readable control\n");
      const denied = actualSpawnSync("chmod", ["+a", "user:nobody deny read", corefilePath], {
        encoding: "utf-8",
      });
      expect(denied.status).toBe(0);
      // The same principal reads the unrestricted control file, so the later
      // refusal on the configured file is the file's own policy.
      const control = actualSpawnSync("sudo", ["-n", "-u", "nobody", "cat", controlFile], {
        encoding: "utf-8",
      });
      expect(control.status).toBe(0);
      const grant = actualSpawnSync("sudo", ["-n", "chown", "root:wheel", etcDir], {
        encoding: "utf-8",
      });
      if (grant.status !== 0) {
        return;
      }
      // The modes were set above, while the runner still owned the tree; a
      // runner-side chmod after the chown would EPERM even for a matching mode.

      // The widen call names the staged file; it is inspected synchronously
      // before being forwarded, while the staged bytes still exist.
      const observations: {
        mode: number;
        deniedPolicy: boolean;
        readerRefused: boolean;
        bytes: string;
      }[] = [];
      spawnSyncMock.mockImplementation((cmd: string, args: string[], opts?: { input?: string }) => {
        if (
          cmd === "sudo" &&
          args[0] === "chmod" &&
          typeof args[2] === "string" &&
          // Only the final numeric mode-widening call: the earlier chmod -N
          // runs on an empty inode before the bytes and policy exist.
          /^\d+$/.test(args[1] ?? "") &&
          path.basename(args[2]).includes("openclaw-")
        ) {
          const staged = args[2];
          const mode = actualSpawnSync("sudo", ["-n", "stat", "-f", "%Lp", staged], {
            encoding: "utf-8",
          });
          const policy = actualSpawnSync("sudo", ["-n", "/bin/ls", "-lde", staged], {
            encoding: "utf-8",
          });
          const asReader = actualSpawnSync("sudo", ["-n", "-u", "nobody", "cat", staged], {
            encoding: "utf-8",
          });
          const asRoot = actualSpawnSync("sudo", ["-n", "cat", staged], {
            encoding: "utf-8",
          });
          observations.push({
            mode: Number.parseInt(mode.stdout ?? "", 8),
            deniedPolicy: (policy.stdout ?? "").includes("deny read"),
            readerRefused: asReader.status !== 0,
            bytes: asRoot.stdout ?? "",
          });
        }
        if (cmd === "sudo" && args[0] !== "brew") {
          return actualSpawnSync(cmd, args, { encoding: "utf-8", ...opts });
        }
        return baseSpawnImplementation?.(cmd, args, opts);
      });

      try {
        await runDnsSetup();
      } finally {
        spawnSyncMock.mockImplementation((cmd: string, args: string[], opts?: { input?: string }) =>
          baseSpawnImplementation?.(cmd, args, opts),
        );
        actualSpawnSync("sudo", ["-n", "chown", "-R", process.env.USER ?? "runner", etcDir], {
          encoding: "utf-8",
        });
      }

      expect(fs.readFileSync(corefilePath, "utf-8")).toBe(
        `.:53 {\n  errors\n}\n\nimport ${importGlob}\n`,
      );
      // The synchronous observation is mandatory: at the widening call the
      // staged file still existed, its access policy was in place, its mode
      // was still private, and the excluded account was refused.
      expect(observations.length).toBeGreaterThan(0);
      for (const observed of observations) {
        expect(observed.mode).toBe(0o600);
        expect(observed.deniedPolicy).toBe(true);
        expect(observed.readerRefused).toBe(true);
        // The staged inode genuinely holds the configuration bytes.
        expect(observed.bytes).toContain(`import ${importGlob}`);
      }
    },
  );

  it("preserves the existing Corefile when its publication fails", async () => {
    const etcDir = path.join(brewPrefix, "etc", "coredns");
    const corefilePath = path.join(etcDir, "Corefile");
    const original = ".:53 {\n  errors\n}\n";
    fs.mkdirSync(etcDir, { recursive: true });
    fs.writeFileSync(corefilePath, original);
    failCorefilePublicationWithNoSpace(etcDir);

    await expect(runDnsSetup()).rejects.toThrow(/ENOSPC|no space left on device/);

    // The failed publication left the operator's Corefile exactly as it was.
    expect(fs.readFileSync(corefilePath, "utf-8")).toBe(original);
    expect(spawnSyncMock).not.toHaveBeenCalledWith(
      "sudo",
      ["brew", "services", "restart", "coredns"],
      expect.anything(),
    );
  });

  // macOS carries per-file ACLs beside the mode; a replacement inode does not
  // inherit them, so the access policy has to be restored explicitly.
  it.runIf(process.platform === "darwin")(
    "keeps the operator's macOS access policy across a publication",
    async () => {
      const etcDir = path.join(brewPrefix, "etc", "coredns");
      const corefilePath = path.join(etcDir, "Corefile");
      const importGlob = path.join(etcDir, "conf.d", "*.server");
      // Traversable ancestors and a control read: the refusal later must be
      // the file's own policy, not an unreachable ancestor.
      fs.chmodSync(brewPrefix, 0o755);
      fs.mkdirSync(etcDir, { recursive: true });
      fs.writeFileSync(corefilePath, ".:53 {\n  errors\n}\n");
      fs.chmodSync(corefilePath, 0o644);
      const controlFile = path.join(etcDir, "control.txt");
      fs.writeFileSync(controlFile, "readable control\n");
      const denied = actualSpawnSync("chmod", ["+a", "user:nobody deny read", corefilePath], {
        encoding: "utf-8",
      });
      expect(denied.status).toBe(0);
      const control = actualSpawnSync("sudo", ["-n", "-u", "nobody", "cat", controlFile], {
        encoding: "utf-8",
      });
      expect(control.status).toBe(0);
      const policy = actualSpawnSync("ls", ["-lde", corefilePath], { encoding: "utf-8" });
      expect(policy.stdout).toContain("deny read");

      await runDnsSetup();

      expect(fs.readFileSync(corefilePath, "utf-8")).toBe(
        `.:53 {\n  errors\n}\n\nimport ${importGlob}\n`,
      );
      const published = actualSpawnSync("ls", ["-lde", corefilePath], { encoding: "utf-8" });
      expect(published.stdout).toContain("deny read");
      const asReader = actualSpawnSync("sudo", ["-n", "-u", "nobody", "cat", corefilePath], {
        encoding: "utf-8",
      });
      expect(asReader.status).not.toBe(0);
    },
  );

  // The same policy preservation on the symlinked managed target: the link
  // survives, the target's deny entry survives, and the excluded principal is
  // still refused after the target is replaced.
  it.runIf(process.platform === "darwin")(
    "keeps the managed target's access policy across a symlinked publication",
    async () => {
      const etcDir = path.join(brewPrefix, "etc", "coredns");
      const corefilePath = path.join(etcDir, "Corefile");
      const managedPath = path.join(etcDir, "managed-Corefile");
      const importGlob = path.join(etcDir, "conf.d", "*.server");
      // Traversable ancestors and a control read prove that the later refusal
      // is the file's own policy, not an unreachable ancestor.
      fs.chmodSync(brewPrefix, 0o755);
      fs.mkdirSync(etcDir, { recursive: true });
      fs.writeFileSync(managedPath, ".:53 {\n  errors\n}\n");
      fs.chmodSync(managedPath, 0o644);
      fs.symlinkSync("managed-Corefile", corefilePath);
      const controlFile = path.join(etcDir, "control.txt");
      fs.writeFileSync(controlFile, "readable control\n");
      const denied = actualSpawnSync("chmod", ["+a", "user:nobody deny read", managedPath], {
        encoding: "utf-8",
      });
      expect(denied.status).toBe(0);
      const control = actualSpawnSync("sudo", ["-n", "-u", "nobody", "cat", controlFile], {
        encoding: "utf-8",
      });
      expect(control.status).toBe(0);

      await runDnsSetup();

      expect(fs.lstatSync(corefilePath).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(managedPath, "utf-8")).toBe(
        `.:53 {\n  errors\n}\n\nimport ${importGlob}\n`,
      );
      const published = actualSpawnSync("ls", ["-lde", managedPath], { encoding: "utf-8" });
      expect(published.stdout).toContain("deny read");
      const asReader = actualSpawnSync("sudo", ["-n", "-u", "nobody", "cat", managedPath], {
        encoding: "utf-8",
      });
      expect(asReader.status).not.toBe(0);
    },
  );

  // An ordinary-path failure that is not a permission error must abort
  // without routing to the privileged fallback: the operator's file, its
  // policy and the CoreDNS restart decision all stay untouched.
  it("aborts an ordinary-path publication without the privileged fallback", async () => {
    const etcDir = path.join(brewPrefix, "etc", "coredns");
    const corefilePath = path.join(etcDir, "Corefile");
    fs.mkdirSync(etcDir, { recursive: true });
    fs.writeFileSync(corefilePath, ".:53 {\n  errors\n}\n");
    const original = fs.readFileSync(corefilePath, "utf-8");
    const fullDisk = Object.assign(new Error("ENOSPC: no space left on device, write"), {
      code: "ENOSPC",
    });
    fsSafeMock.failPublication = fullDisk;

    try {
      await expect(runDnsSetup()).rejects.toBe(fullDisk);
    } finally {
      fsSafeMock.failPublication = null;
    }

    expect(fs.readFileSync(corefilePath, "utf-8")).toBe(original);
    expect(fs.readdirSync(etcDir).filter((entry) => entry.startsWith("."))).toEqual([]);
    // CoreDNS was not restarted.
    expect(spawnSyncMock).not.toHaveBeenCalledWith(
      "sudo",
      ["brew", "services", "restart", "coredns"],
      expect.anything(),
    );
  });

  // A capture failure must not silently strip the operator's policy: the
  // publication aborts with the operator's file untouched.
  it.runIf(process.platform === "darwin")(
    "aborts the publication when the access policy cannot be captured",
    async () => {
      const etcDir = path.join(brewPrefix, "etc", "coredns");
      const corefilePath = path.join(etcDir, "Corefile");
      fs.mkdirSync(etcDir, { recursive: true });
      fs.writeFileSync(corefilePath, ".:53 {\n  errors\n}\n");
      fs.chmodSync(corefilePath, 0o644);
      const original = fs.readFileSync(corefilePath, "utf-8");
      const denied = actualSpawnSync("chmod", ["+a", "user:nobody deny read", corefilePath], {
        encoding: "utf-8",
      });
      expect(denied.status).toBe(0);
      // The production import is the named spawnSync export, which the mock
      // factory routes through spawnSyncMock; the capture failure has to be
      // injected at that boundary with a correctly shaped failed result.
      const failedCapture = {
        ...spawnOk(),
        status: 1,
        stdout: "",
        stderr: "/bin/ls: capture failed",
      };
      // The mock may not be primed yet; a missing implementation is a test
      // setup failure, not a reason to weaken the injection.
      const baseImplementation =
        spawnSyncMock.getMockImplementation() ??
        (() => {
          throw new Error("spawnSync was called before the test primed the mock");
        });
      spawnSyncMock.mockImplementation((command: string, args: string[], opts?: unknown) => {
        if (command === "/bin/ls") {
          return failedCapture;
        }
        return baseImplementation(command, args, opts);
      });

      try {
        await expect(runDnsSetup()).rejects.toThrow(/access policy/);
      } finally {
        spawnSyncMock.mockImplementation(baseImplementation);
      }

      expect(fs.readFileSync(corefilePath, "utf-8")).toBe(original);
      const policy = actualSpawnSync("ls", ["-lde", corefilePath], { encoding: "utf-8" });
      expect(policy.stdout).toContain("deny read");
      expect(fs.readdirSync(etcDir).filter((entry) => entry.startsWith("."))).toEqual([]);
    },
  );

  unix("keeps the operator's Corefile mode across a successful publication", async () => {
    const etcDir = path.join(brewPrefix, "etc", "coredns");
    const corefilePath = path.join(etcDir, "Corefile");
    const importGlob = path.join(etcDir, "conf.d", "*.server");
    fs.mkdirSync(etcDir, { recursive: true });
    fs.writeFileSync(corefilePath, ".:53 {\n  errors\n}\n");
    fs.chmodSync(corefilePath, 0o640);

    await runDnsSetup();

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

    await runDnsSetup();

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

    await runDnsSetup();

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
        await runDnsSetup();
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
      // macOS `sync` ignores path operands, so the flush runs a descriptor
      // synchronization through the same runtime that owns the command.
      const flushIndexes = sudoCalls
        .map((call, index) => ({ call, index }))
        .filter(
          ({ call }) =>
            (call[1] as string[])[0] === process.execPath &&
            (call[1] as string[])[1] === "-e" &&
            ((call[1] as string[])[2] ?? "").includes("fsyncSync"),
        )
        .map(({ index }) => index);
      const moveIndex = sudoCalls.findIndex((call) => (call[1] as string[])[0] === "mv");
      expect(flushIndexes.length).toBeGreaterThanOrEqual(2);
      expect(flushIndexes[0]!).toBeLessThan(moveIndex);
      expect(flushIndexes[1]!).toBeGreaterThan(moveIndex);
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
    spawnSyncMock.mockImplementation((cmd: string, args: string[], opts?: { input?: string }) => {
      if (timeout ? isBrewPrefixProbe([cmd, args]) : cmd === "sudo" && args[0] === "brew") {
        return { ...spawnOk(), status: null, signal, ...(error ? { error } : {}) };
      }
      return baseSpawnImplementation?.(cmd, args, opts);
    });
    return expect(runDnsSetup()).rejects.toThrow(
      timeout
        ? "brew --prefix failed: timed out after 15 seconds (signal SIGKILL)"
        : "sudo brew services restart coredns failed: signal SIGTERM",
    );
  });

  it("reports missing tailnet IP before starting setup", async () => {
    vi.spyOn(tailnet, "pickPrimaryTailnetIPv4").mockReturnValue(undefined);
    await expect(runDnsSetup()).rejects.toMatchObject({
      humanOutput: "no tailnet IP detected; check that Tailscale is running on this machine",
    });
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });
});
