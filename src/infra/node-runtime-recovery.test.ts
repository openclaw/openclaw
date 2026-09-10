import {
  ChildProcess,
  type SpawnOptions,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
} from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { isUsableNode, recoverNodeRuntime } from "../../node-runtime-recovery.mjs";
import { SQLITE_CAPABILITY_PROBE } from "../../node-sqlite.mjs";
import { buildTaskScript } from "../daemon/schtasks-layout.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import { encodeWindowsLauncherScript } from "./windows-launcher-encoding.js";

const mocks = vi.hoisted(() => ({
  currentAdmitted: false,
  encoding: "utf-8",
  admissible: new Set<string>(),
  virtualPaths: new Map<string, string>(),
  probe:
    vi.fn<
      (
        file: string,
        args: string[],
        options: SpawnSyncOptionsWithStringEncoding,
      ) => SpawnSyncReturns<string>
    >(),
  spawn: vi.fn<(file: string, args: string[], options: SpawnOptions) => ChildProcess>(),
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: mocks.spawn,
  spawnSync: mocks.probe,
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    realpathSync: (filename: string) =>
      mocks.virtualPaths.get(filename) ?? actual.realpathSync(filename),
  };
});
vi.mock("../../node-sqlite.mjs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../node-sqlite.mjs")>()),
  detectCurrentSqliteCapabilities: () => ({
    available: true,
    version: "3.51.3",
    text: mocks.currentAdmitted,
    blob: true,
    json: true,
  }),
}));
vi.mock("./windows-encoding.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./windows-encoding.js")>()),
  resolveWindowsOemEncoding: () => mocks.encoding,
  resolveWindowsOemCodePage: () => 437,
}));

const originalArgv = process.argv;
const originalExecArgv = process.execArgv;
const hostPlatform = process.platform;
const windowsPath = {
  isAbsolute: path.win32.isAbsolute.bind(path.win32),
  basename: path.win32.basename.bind(path.win32),
  dirname: path.win32.dirname.bind(path.win32),
  relative: (from: string, to: string) => path.win32.relative(from, to).replaceAll("\\", path.sep),
};
const exitSentinel = new Error("replacement exited");
let child: ChildProcess;
let exitSpy: MockInstance<typeof process.exit>;
let stderrSpy: MockInstance<typeof process.stderr.write>;

beforeEach(() => {
  mockProcessPlatform("linux");
  mocks.currentAdmitted = false;
  mocks.encoding = "utf-8";
  mocks.admissible.clear();
  mocks.virtualPaths.clear();
  mocks.probe.mockReset();
  mocks.spawn.mockReset();
  mocks.probe.mockImplementation((filename) => ({
    pid: 100,
    status: 0,
    signal: null,
    output: [],
    stdout: JSON.stringify({
      version: "24.19.0",
      probe: {
        available: true,
        version: "3.51.3",
        text: mocks.admissible.has(filename),
        blob: true,
        json: true,
      },
    }),
    stderr: "",
  }));
  child = new ChildProcess();
  mocks.spawn.mockReturnValue(child);
  exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
    throw exitSentinel;
  });
  stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  process.argv = [
    process.execPath,
    "/fixture/dist/index.js",
    "doctor",
    "--non-interactive",
    "--fix",
  ];
  process.execArgv = [];
  vi.stubEnv("CI", "1");
  for (const key of [
    "OPENCLAW_NODE_UPDATE_RESPAWNED",
    "OPENCLAW_PROFILE",
    "OPENCLAW_LAUNCHD_LABEL",
    "OPENCLAW_SYSTEMD_UNIT",
    "OPENCLAW_TASK_SCRIPT",
  ]) {
    vi.stubEnv(key, undefined);
  }
});

afterEach(() => {
  if (child.listenerCount("exit")) {
    expect(() => child.emit("exit", 0, null)).toThrow(exitSentinel);
  }
  process.argv = originalArgv;
  process.execArgv = originalExecArgv;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function writeFixture(filename: string, text = "") {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, text);
  return filename;
}

async function withRecoveryHome(run: (home: string) => Promise<void>) {
  await withTempDir("openclaw-node-recovery-", async (directory) => {
    const home = await fs.realpath(directory);
    vi.stubEnv("HOME", home);
    vi.stubEnv("PATH", path.join(home, "bin"));
    vi.stubEnv("NVM_DIR", path.join(home, ".nvm"));
    vi.stubEnv("FNM_DIR", path.join(home, ".fnm"));
    vi.stubEnv("VOLTA_HOME", path.join(home, ".volta"));
    await run(home);
  });
}

async function expectRecoveryStarted(home: string) {
  void recoverNodeRuntime({ homeDir: home });
  await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
}

describe("runtime recovery discovery", () => {
  it.each(["HOME", "OPENCLAW_HOME"])(
    "reuses a private runtime when cwd equals %s",
    async (homeVariable) => {
      await withRecoveryHome(async (home) => {
        const candidate = await writeFixture(
          path.join(home, ".openclaw/tools/cli-node/tools/node/bin/node"),
        );
        vi.stubEnv("OPENCLAW_HOME", homeVariable === "OPENCLAW_HOME" ? home : undefined);
        if (homeVariable === "OPENCLAW_HOME") {
          vi.stubEnv("HOME", path.dirname(home));
        }
        vi.stubEnv("PATH", "");
        vi.spyOn(process, "cwd").mockReturnValue(home);
        mocks.admissible.add(candidate);

        void recoverNodeRuntime();
        await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
        expect(mocks.spawn.mock.calls[0]?.[0]).toBe(candidate);
        expect(mocks.probe.mock.calls.map(([file]) => file)).toEqual([candidate]);
      });
    },
  );

  it.each(["none", "executable", "parent", "root"])(
    "rejects workspace and manager Nodes from HOME (private symlink escape=%s)",
    async (privateEscape) => {
      await withRecoveryHome(async (home) => {
        vi.stubEnv("OPENCLAW_HOME", undefined);
        vi.stubEnv("PATH", ".");
        vi.spyOn(process, "cwd").mockReturnValue(home);
        const workspaceNode = await writeFixture(path.join(home, "node"));
        const managerNode = await writeFixture(
          path.join(home, ".nvm/versions/node/v24.19.0/bin/node"),
        );
        const plantedNodes = [workspaceNode, managerNode, await fs.realpath(process.execPath)];
        await writeFixture(path.join(home, ".nvm/alias/default"), "24");
        if (privateEscape !== "none") {
          const privateNode = path.join(home, ".openclaw/tools/cli-node/tools/node/bin/node");
          if (privateEscape === "root") {
            const workspaceRoot = path.join(home, "workspace-state");
            plantedNodes.push(
              await writeFixture(path.join(workspaceRoot, "tools/cli-node/tools/node/bin/node")),
            );
            await fs.symlink(workspaceRoot, path.join(home, ".openclaw"), "junction");
          } else if (privateEscape === "executable") {
            await fs.mkdir(path.dirname(privateNode), { recursive: true });
            await fs.symlink(workspaceNode, privateNode);
          } else {
            const workspaceTools = path.join(home, "workspace-tools");
            const redirectedNode = path.join(workspaceTools, "cli-node/tools/node/bin/node");
            await fs.mkdir(path.dirname(redirectedNode), { recursive: true });
            await fs.symlink(process.execPath, redirectedNode);
            await fs.mkdir(path.join(home, ".openclaw"));
            await fs.symlink(workspaceTools, path.join(home, ".openclaw/tools"), "junction");
          }
        }
        mocks.admissible.add(workspaceNode);
        mocks.admissible.add(managerNode);

        expect(await recoverNodeRuntime()).toBe(false);
        const probed = mocks.probe.mock.calls.map(([file]) => file);
        for (const planted of plantedNodes) {
          expect(probed).not.toContain(planted);
        }
        expect(mocks.spawn).not.toHaveBeenCalled();
      });
    },
  );

  it.each([
    { name: "expands the Windows service state directory against home", source: "home" },
    { name: "never reads competing cwd tilde service metadata", source: "competing" },
    { name: "rejects a relative Windows service state directory", source: "relative" },
    { name: "expands an explicit Windows task script against home", source: "home-script" },
    { name: "rejects an explicit Windows task script under cwd", source: "cwd-script" },
    { name: "rejects a Windows task script resolving under cwd", source: "symlink-script" },
    { name: "rejects a task script through a cwd-owned parent", source: "parent-script" },
  ])("$name", async ({ source }) => {
    await withRecoveryHome(async (root) => {
      const state = source === "relative" ? "state" : "~/x";
      const home = path.join(root, "daemon $& home");
      const cwd = path.join(root, "checkout");
      await fs.mkdir(home);
      await fs.mkdir(cwd);
      const installedNode = await writeFixture(path.join(root, "installed", "node.exe"));
      const workspaceNode = await writeFixture(path.join(root, "sibling", "node.exe"));
      const homeScript = path.join(home, "x", "gateway.cmd");
      const competingScript = path.join(cwd, state, "gateway.cmd");
      const writeScript = async (filename: string, node: string) => {
        await fs.mkdir(path.dirname(filename), { recursive: true });
        await fs.writeFile(
          filename,
          encodeWindowsLauncherScript({
            format: "cmd",
            content: buildTaskScript({ programArguments: [node, "/fixture/entry.js", "gateway"] }),
          }),
        );
      };
      await writeScript(homeScript, installedNode);
      if (source !== "home") {
        await writeScript(competingScript, workspaceNode);
      }
      const scriptLink = path.join(root, "gateway.cmd");
      const outsideScript = path.join(root, "outside-gateway.cmd");
      const parentLink = path.join(root, "cwd-alias");
      if (source === "symlink-script") {
        await fs.symlink(competingScript, scriptLink);
      } else if (source === "parent-script") {
        await fs.rename(competingScript, outsideScript);
        await fs.symlink(outsideScript, competingScript);
        await fs.symlink(cwd, parentLink, "junction");
      }
      const scriptOverride =
        source === "home-script"
          ? "~/x/gateway.cmd"
          : source === "cwd-script"
            ? competingScript
            : source === "symlink-script"
              ? scriptLink
              : source === "parent-script"
                ? path.join(parentLink, state, "gateway.cmd")
                : undefined;
      const report = path.join(root, "discovery.json");
      const driver = await writeFixture(
        path.join(root, "discover.mjs"),
        `
        import childProcess from "node:child_process";
        import { EventEmitter } from "node:events";
        import fs from "node:fs";
        import path from "node:path";
        import { syncBuiltinESMExports } from "node:module";
        Object.defineProperty(process, "platform", { value: "win32" });
        Object.defineProperty(process.versions, "node", { value: "20.0.0" });
        const result = { reads: [], probes: [] };
        const readFileSync = fs.readFileSync;
        fs.readFileSync = (filename, ...args) => {
          result.reads.push(path.resolve(String(filename)));
          return readFileSync(filename, ...args);
        };
        childProcess.spawnSync = (command) => {
          result.probes.push(command);
          return { status: [${JSON.stringify(installedNode)}, ${JSON.stringify(workspaceNode)}].includes(command) ? 0 : 1,
            stdout: JSON.stringify({ version: "24.19.0", probe: { available: true, version: "3.53.4", text: true, blob: true, json: true } }) };
        };
        childProcess.spawn = (command) => {
          result.selected = command;
          const child = new EventEmitter();
          child.kill = () => true;
          setImmediate(() => child.emit("exit", 23, null));
          return child;
        };
        process.on("exit", () => fs.writeFileSync(${JSON.stringify(report)}, JSON.stringify(result)));
        syncBuiltinESMExports();
        const { recoverNodeRuntime } = await import(${JSON.stringify(new URL("../../node-runtime-recovery.mjs", import.meta.url).href)});
        await recoverNodeRuntime();
      `,
      );
      const { spawnSync } =
        await vi.importActual<typeof import("node:child_process")>("node:child_process");
      const result = spawnSync(process.execPath, [driver, "doctor", "--fix", "--non-interactive"], {
        cwd,
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          OPENCLAW_HOME: path.join(root, "private-home"),
          OPENCLAW_STATE_DIR: state,
          OPENCLAW_TASK_SCRIPT: scriptOverride,
          OPENCLAW_TASK_SCRIPT_NAME: undefined,
          PATH: "",
          NVM_DIR: undefined,
          FNM_DIR: undefined,
          VOLTA_HOME: undefined,
          NODE_OPTIONS: undefined,
        },
        encoding: "utf8",
        timeout: 30_000,
      });
      const observed = JSON.parse(await fs.readFile(report, "utf8"));
      expect(observed.reads).not.toContain(competingScript);
      expect(observed.reads).not.toContain(scriptLink);
      expect(observed.reads).not.toContain(outsideScript);
      expect(observed.probes).not.toContain(workspaceNode);
      if (["home", "competing", "home-script"].includes(source)) {
        expect(result.status, result.stderr).toBe(23);
        expect(observed.reads).toContain(homeScript);
        expect(observed.selected).toBe(installedNode);
      } else {
        expect(result.status, result.stderr).toBe(0);
        expect(observed.selected).toBeUndefined();
      }
    });
  });

  it("never probes fnm through a cwd-owned parent directory", async () => {
    await withRecoveryHome(async (home) => {
      const cwd = path.join(home, "checkout");
      const candidate = await writeFixture(path.join(home, "outside", "node"));
      await fs.mkdir(path.join(cwd, "bin"), { recursive: true });
      await fs.symlink(candidate, path.join(cwd, "bin", "node"));
      const aliases = path.join(home, ".fnm", "aliases");
      await fs.mkdir(aliases, { recursive: true });
      await fs.symlink(cwd, path.join(aliases, "default"), "junction");
      vi.spyOn(process, "cwd").mockReturnValue(cwd);

      expect(await recoverNodeRuntime({ homeDir: home })).toBe(false);
      expect(mocks.probe.mock.calls.map(([file]) => file)).not.toContain(candidate);
      expect(mocks.spawn).not.toHaveBeenCalled();
    });
  });

  it.each([true, false])("recovers without an OS account record (HOME=%s)", async (hasHome) => {
    await withRecoveryHome(async (home) => {
      const candidate = await writeFixture(path.join(home, "bin", "node"));
      const account = vi.spyOn(os, "userInfo").mockImplementation(() => {
        throw new Error("OS account record unavailable");
      });
      if (!hasHome) {
        vi.stubEnv("HOME", undefined);
        vi.stubEnv("USERPROFILE", undefined);
      }
      mocks.admissible.add(candidate);
      await expect(
        Promise.race([
          recoverNodeRuntime({ homeDir: home }),
          vi.waitFor(() => {
            expect(mocks.spawn).toHaveBeenCalledOnce();
          }),
        ]),
      ).resolves.toBeUndefined();
      expect(mocks.spawn.mock.calls[0]?.[0]).toBe(candidate);
      expect(account).toHaveBeenCalledTimes(hasHome ? 0 : 1);
    });
  });

  it.each(["nvm", "fnm", "Volta"])("expands the %s manager root against home", async (manager) => {
    await withRecoveryHome(async (home) => {
      const root = path.join(home, "custom-manager");
      let candidate: string;
      if (manager === "nvm") {
        candidate = await writeFixture(path.join(root, "versions/node/v24.19.0/bin/node"));
        await writeFixture(path.join(root, "alias/default"), "24");
        vi.stubEnv("NVM_DIR", "~/custom-manager");
      } else if (manager === "fnm") {
        candidate = await writeFixture(path.join(root, "aliases/default/bin/node"));
        vi.stubEnv("FNM_DIR", "~/custom-manager");
      } else {
        candidate = await writeFixture(path.join(root, "tools/image/node/24.19.0/bin/node"));
        await writeFixture(
          path.join(root, "tools/user/platform.json"),
          JSON.stringify({ node: { runtime: "24.19.0" } }),
        );
        vi.stubEnv("VOLTA_HOME", "~/custom-manager");
      }
      mocks.admissible.add(candidate);
      await expectRecoveryStarted(home);
      expect(mocks.spawn.mock.calls[0]?.[0]).toBe(candidate);
    });
  });

  it.each(["HOME", "USERPROFILE", "OPENCLAW_HOME"])(
    "expands inherited %s before private discovery",
    async (key) => {
      await withRecoveryHome(async (home) => {
        const candidate = await writeFixture(
          path.join(home, "custom-home/.openclaw/tools/cli-node/tools/node/bin/node"),
        );
        vi.spyOn(os, "userInfo").mockReturnValue({
          homedir: home,
          username: "fixture",
          uid: 1000,
          gid: 1000,
          shell: null,
        });
        vi.stubEnv("OPENCLAW_HOME", undefined);
        vi.stubEnv("USERPROFILE", undefined);
        if (key === "USERPROFILE") {
          vi.stubEnv("HOME", undefined);
        }
        vi.stubEnv(key, "~/custom-home");
        mocks.admissible.add(candidate);

        void recoverNodeRuntime();
        await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
        expect(mocks.spawn.mock.calls[0]?.[0]).toBe(candidate);
      });
    },
  );

  it("uses inherited PATH and probe settings after process env changes", async () => {
    await withRecoveryHome(async (home) => {
      const inheritedNode = await writeFixture(path.join(home, "inherited/bin/node"));
      const workspaceNode = await writeFixture(path.join(home, "workspace/bin/node"));
      const env = { ...process.env, PATH: path.dirname(inheritedNode), TEMP: home };
      vi.stubEnv("PATH", path.dirname(workspaceNode));
      vi.stubEnv("TEMP", path.join(home, "workspace"));
      vi.stubEnv("FNM_DIR", path.join(home, "workspace-fnm"));
      mocks.admissible.add(inheritedNode);
      mocks.admissible.add(workspaceNode);

      void recoverNodeRuntime({ homeDir: home, env });
      await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());

      expect(mocks.probe.mock.calls.map(([file]) => file)).toEqual([inheritedNode]);
      expect(mocks.probe.mock.calls[0]?.[2].env).toMatchObject({ TEMP: home });
      expect(mocks.spawn.mock.calls[0]?.[2].env).toEqual({
        ...env,
        OPENCLAW_NODE_UPDATE_RESPAWNED: "1",
      });
    });
  });

  it.each([
    ["unquoted", "C:\\Node24\\node.exe", "utf-8", false, "cmd"],
    ["quoted", "C:\\Program Files\\Node24\\node.exe", "utf-8", false, "cmd"],
    ["cmd escapes", "C:\\Tools\\100% ready!\\node.exe", "utf-8", false, "cmd"],
    ["GBK marker", "C:\\Node 隆\\node.exe", "gbk", false, "cmd"],
    ["legacy GBK marker", "C:\\Node 隆\\node.exe", "gbk", false, "marker-only"],
    ["UTF-8 BOM", "C:\\Node café\\node.exe", "utf-8", false, "utf8-bom"],
    ["UTF-16 LE BOM", "C:\\Node café\\node.exe", "utf-8", false, "utf16le-bom"],
    ["UTF-16 BE BOM", "C:\\Node café\\node.exe", "utf-8", false, "utf16be-bom"],
    ["Big5 marker", "C:\\Node 文\\node.exe", "big5", false, "cmd"],
    ["CP866 marker", "C:\\Node Я\\node.exe", "cp866", false, "cmd"],
    ["CP1258 marker", "C:\\Node Đ\\node.exe", "windows-1258", false, "cmd"],
    ["OEM marker", "C:\\Node café\\node.exe", "cp850", true, "cmd"],
    ["UHC marker", "C:\\Node 똠이\\node.exe", "euc-kr", true, "cmd"],
  ] as const)(
    "reads the Windows writer's %s service executable",
    async (_label, candidate, encoding, skip, format) => {
      await withRecoveryHome(async (home) => {
        const script = path.join(home, "gateway.cmd");
        mocks.encoding = encoding;
        const content = buildTaskScript({
          programArguments: [candidate, "C:\\OpenClaw\\dist\\index.js", "gateway"],
        });
        let bytes = encodeWindowsLauncherScript({
          format: format.startsWith("utf16") ? "vbs" : "cmd",
          content,
        });
        if (format === "marker-only") {
          bytes = bytes.subarray(bytes.indexOf(0x0a) + 1);
        } else if (format === "utf8-bom") {
          bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]);
        } else if (format === "utf16be-bom") {
          bytes = bytes.swap16();
        }
        await fs.writeFile(script, bytes);
        mockProcessPlatform("win32");
        vi.spyOn(path, "isAbsolute").mockImplementation(windowsPath.isAbsolute);
        vi.spyOn(path, "basename").mockImplementation(windowsPath.basename);
        vi.spyOn(path, "dirname").mockImplementation(windowsPath.dirname);
        vi.spyOn(path, "relative").mockImplementation(windowsPath.relative);
        vi.stubEnv("OPENCLAW_TASK_SCRIPT", script);
        vi.stubEnv("PATH", "");
        mocks.virtualPaths.set(candidate, candidate);
        mocks.admissible.add(candidate);

        if (skip) {
          expect(await recoverNodeRuntime({ homeDir: home })).toBe(false);
          expect(mocks.probe).not.toHaveBeenCalled();
          expect(mocks.spawn).not.toHaveBeenCalled();
          expect(stderrSpy).toHaveBeenCalledExactlyOnceWith(
            `openclaw: service script uses code page ${encoding === "euc-kr" ? 949 : 850}; not decodable here\n`,
          );
          const fallback = await writeFixture(path.join(home, "fallback/bin/node.exe"));
          vi.stubEnv("PATH", path.dirname(fallback));
          mocks.admissible.add(fallback);
          await expectRecoveryStarted(home);
          expect(mocks.probe.mock.calls.map(([file]) => file)).toEqual([fallback]);
          expect(mocks.spawn.mock.calls[0]?.[0]).toBe(fallback);
        } else {
          await expectRecoveryStarted(home);
          expect(mocks.probe.mock.calls.map(([file]) => file)).toEqual([candidate]);
          expect(mocks.spawn.mock.calls[0]?.[0]).toBe(candidate);
        }
      });
    },
  );

  it.each([".", "bin", ""])("never probes cwd Node through relative PATH %j", async (entry) => {
    await withRecoveryHome(async (home) => {
      const cwd = path.join(home, "untrusted-checkout");
      await fs.mkdir(cwd);
      const candidate = await writeFixture(path.resolve(cwd, entry || ".", "node"));
      vi.spyOn(process, "cwd").mockReturnValue(cwd);
      vi.stubEnv("PATH", entry);

      expect(await recoverNodeRuntime({ homeDir: home })).toBe(false);
      expect(mocks.probe.mock.calls.map(([file]) => file)).not.toContain(candidate);
      expect(mocks.spawn).not.toHaveBeenCalled();
    });
  });

  it("never probes an nvm symlink under cwd pointing outside cwd", async () => {
    await withRecoveryHome(async (home) => {
      const cwd = path.join(home, "untrusted-checkout");
      const root = path.join(cwd, ".nvm");
      const candidate = path.join(root, "versions/node/v24.19.0/bin/node");
      const target = await writeFixture(path.join(home, "outside/bin/node"));
      await writeFixture(path.join(root, "alias/default"), "24");
      await fs.mkdir(path.dirname(candidate), { recursive: true });
      await fs.symlink(target, candidate);
      vi.spyOn(process, "cwd").mockReturnValue(cwd);
      vi.stubEnv("NVM_DIR", root);
      vi.stubEnv("PATH", "");

      expect(await recoverNodeRuntime({ homeDir: home })).toBe(false);
      const probed = mocks.probe.mock.calls.map(([file]) => file);
      expect(probed).not.toContain(candidate);
      expect(probed).not.toContain(target);
      expect(mocks.spawn).not.toHaveBeenCalled();
    });
  });

  it("allows an absolute PATH entry explicitly naming the cwd", async () => {
    await withRecoveryHome(async (home) => {
      const cwd = path.join(home, "explicit-bin");
      const candidate = await writeFixture(path.join(cwd, "node"));
      vi.spyOn(process, "cwd").mockReturnValue(cwd);
      vi.stubEnv("PATH", cwd);
      mocks.admissible.add(candidate);
      await writeFixture(
        path.join(home, ".config/systemd/user/openclaw-gateway.service"),
        `[Service]\nExecStart="${candidate.replaceAll("\\", "\\\\")}" /fixture/dist/index.js gateway\n`,
      );

      await expectRecoveryStarted(home);

      expect(mocks.spawn.mock.calls[0]?.[0]).toBe(candidate);
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("(PATH;"));
    });
  });

  it("keeps PATH discovery after rejecting a service executable's cwd parent", async () => {
    await withRecoveryHome(async (home) => {
      const cwd = path.join(home, "checkout");
      const candidate = await writeFixture(path.join(home, "outside", "node"));
      await fs.mkdir(cwd);
      await fs.symlink(candidate, path.join(cwd, "node"));
      const alias = path.join(home, "service-alias");
      await fs.symlink(cwd, alias, "junction");
      await writeFixture(
        path.join(home, ".config/systemd/user/openclaw-gateway.service"),
        `[Service]\nExecStart="${path.join(alias, "node").replaceAll("\\", "\\\\")}" /fixture/entry.js gateway\n`,
      );
      vi.spyOn(process, "cwd").mockReturnValue(cwd);
      vi.stubEnv("PATH", path.dirname(candidate));
      mocks.admissible.add(candidate);

      await expectRecoveryStarted(home);
      expect(mocks.spawn.mock.calls[0]?.[0]).toBe(candidate);
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("(PATH;"));
    });
  });

  it.each(["private", "service", "nvm", "fnm", "Volta", "Homebrew"])(
    "never probes a %s runtime resolving into cwd",
    async (source) => {
      await withRecoveryHome(async (home) => {
        const cwd = path.join(home, "untrusted-checkout");
        const candidate = await writeFixture(path.join(cwd, "node"));
        vi.spyOn(process, "cwd").mockReturnValue(cwd);
        vi.stubEnv("PATH", "");
        const paths = {
          private: path.join(home, ".openclaw/tools/cli-node/tools/node/bin/node"),
          service: path.join(home, "service/bin/node"),
          nvm: path.join(home, ".nvm/versions/node/v24.19.0/bin/node"),
          fnm: path.join(home, ".fnm/aliases/default/bin/node"),
          Volta: path.join(home, ".volta/tools/image/node/24.19.0/bin/node"),
          Homebrew: path.join("/opt/homebrew", "opt/node@26/bin/node"),
        };
        for (const [name, alias] of Object.entries(paths)) {
          if (name === source) {
            mocks.virtualPaths.set(alias, candidate);
          }
        }
        await writeFixture(
          path.join(home, ".config/systemd/user/openclaw-gateway.service"),
          `[Service]\nExecStart="${paths.service.replaceAll("\\", "\\\\")}" /fixture/dist/index.js gateway\n`,
        );
        await writeFixture(path.join(home, ".nvm/alias/default"), "24");
        await fs.mkdir(path.dirname(path.dirname(paths.nvm)), { recursive: true });
        await writeFixture(
          path.join(home, ".volta/tools/user/platform.json"),
          JSON.stringify({ node: { runtime: "24.19.0" } }),
        );

        expect(await recoverNodeRuntime({ homeDir: home })).toBe(false);
        const probed = mocks.probe.mock.calls.map(([file]) => file);
        expect(probed).not.toContain(candidate);
        for (const [name, alias] of Object.entries(paths)) {
          if (name === source) {
            expect(probed).not.toContain(alias);
          }
        }
        expect(mocks.spawn).not.toHaveBeenCalled();
      });
    },
  );

  it.each([
    [0, "cached OpenClaw runtime"],
    [1, "managed Gateway service"],
    [2, "PATH"],
    [3, "nvm default"],
    [4, "fnm default"],
    [5, "Volta default"],
    [6, "Homebrew node@26"],
    [7, "Homebrew node@24"],
  ] as const)("selects the first admissible runtime: %s %s", async (index, source) => {
    await withRecoveryHome(async (home) => {
      const candidates = await Promise.all(
        [
          ".openclaw/tools/cli-node/tools/node/bin/node",
          "service/bin/node",
          "bin/node",
          ".nvm/versions/node/v24.19.0/bin/node",
          ".fnm/aliases/default/bin/node",
          ".volta/tools/image/node/24.19.0/bin/node",
          "brew26/bin/node",
          "brew24/bin/node",
        ].map((relative) => writeFixture(path.join(home, relative))),
      );
      await writeFixture(
        path.join(home, ".config/systemd/user/openclaw-gateway.service"),
        `[Service]\nExecStart="${expectDefined(candidates[1], "service candidate").replaceAll("\\", "\\\\")}" /fixture/dist/index.js gateway run\n`,
      );
      await writeFixture(path.join(home, ".nvm/alias/default"), "lts/test\n");
      await writeFixture(path.join(home, ".nvm/alias/lts/test"), "24\n");
      await writeFixture(
        path.join(home, ".volta/tools/user/platform.json"),
        JSON.stringify({ node: { runtime: "24.19.0" } }),
      );
      for (const prefix of ["/opt/homebrew", "/usr/local"]) {
        mocks.virtualPaths.set(
          path.join(prefix, "opt", "node@26", "bin", "node"),
          expectDefined(candidates[6], "Node 26 candidate"),
        );
        mocks.virtualPaths.set(
          path.join(prefix, "opt", "node@24", "bin", "node"),
          expectDefined(candidates[7], "Node 24 candidate"),
        );
      }
      for (const candidate of candidates.slice(index)) {
        mocks.admissible.add(candidate);
      }

      await expectRecoveryStarted(home);

      expect(mocks.probe.mock.calls.map(([filename]) => filename)).toEqual(
        candidates.slice(0, index + 1),
      );
      expect(mocks.spawn.mock.calls[0]?.[0]).toBe(candidates[index]);
      expect(stderrSpy).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining(`(${source}; current Node failed runtime admission)`),
      );
    });
  });

  it.each(["direct", "shell wrapper", "executable wrapper"])(
    "finds the profiled launchd runtime through a %s command",
    async (form) => {
      mockProcessPlatform("darwin");
      await withRecoveryHome(async (home) => {
        const candidate = await writeFixture(path.join(home, "service & runtime/bin/node"));
        mocks.admissible.add(candidate);
        process.argv = [
          process.execPath,
          "/fixture/openclaw.mjs",
          "--profile",
          "fixture",
          "doctor",
        ];
        const wrapper = path.join(home, "service-env/ai.openclaw.fixture-env-wrapper.sh");
        const envFile = path.join(home, "service-env/ai.openclaw.fixture.env");
        const prefix =
          form === "direct"
            ? []
            : form === "shell wrapper"
              ? ["/bin/sh", wrapper, envFile]
              : [wrapper, envFile];
        const args = [...prefix, candidate, "/fixture/dist/index.js", "gateway"];
        await writeFixture(
          path.join(home, "Library/LaunchAgents/ai.openclaw.fixture.plist"),
          `<key>ProgramArguments</key><array>${args.map((arg) => `<string>${arg.replaceAll("&", "&amp;")}</string>`).join("")}</array>`,
        );

        await expectRecoveryStarted(home);

        expect(mocks.probe.mock.calls.map(([filename]) => filename)).toEqual([candidate]);
        expect(mocks.spawn.mock.calls[0]?.[0]).toBe(candidate);
      });
    },
  );

  it("ignores PATH aliases for the running executable and probes each other binary once", async () => {
    await withRecoveryHome(async (home) => {
      await fs.mkdir(path.join(home, "bin"));
      if (hostPlatform === "win32") {
        mocks.virtualPaths.set(path.join(home, "bin/node"), await fs.realpath(process.execPath));
      } else {
        await fs.symlink(process.execPath, path.join(home, "bin/node"));
      }
      const replacement = await writeFixture(path.join(home, "replacement/bin/node"));
      const alternate = path.join(home, "alternate/bin/node");
      await fs.mkdir(path.dirname(alternate), { recursive: true });
      if (hostPlatform === "win32") {
        mocks.virtualPaths.set(alternate, replacement);
      } else {
        await fs.symlink(replacement, alternate);
      }
      vi.stubEnv(
        "PATH",
        [path.join(home, "bin"), path.dirname(alternate), path.dirname(replacement)].join(
          path.delimiter,
        ),
      );

      expect(await recoverNodeRuntime({ homeDir: home })).toBe(false);

      expect(mocks.probe.mock.calls.filter(([filename]) => filename === replacement)).toHaveLength(
        1,
      );
      expect(mocks.probe.mock.calls.some(([filename]) => filename === process.execPath)).toBe(
        false,
      );
      expect(mocks.spawn).not.toHaveBeenCalled();
    });
  });

  it.each(["already admitted", "replacement child"])(
    "does not discover for an %s",
    async (reason) => {
      await withRecoveryHome(async (home) => {
        const candidate = await writeFixture(path.join(home, "bin/node"));
        mocks.admissible.add(candidate);
        mocks.currentAdmitted = reason === "already admitted";
        if (reason === "replacement child") {
          vi.stubEnv("OPENCLAW_NODE_UPDATE_RESPAWNED", "1");
        }

        expect(await recoverNodeRuntime({ homeDir: home })).toBe(false);
        expect(mocks.probe).not.toHaveBeenCalled();
        expect(mocks.spawn).not.toHaveBeenCalled();
      });
    },
  );

  it.each([
    ["webhooks", "gmail", "run"],
    ["--profile", "fixture", "webhooks", "gmail", "run"],
    ["webhooks", "--log-level=debug", "gmail", "--no-color", "run"],
    ["hooks", "relay", "--relay-id", "fixture"],
  ])("keeps exact-PID invocation %j in its original process", async (...args) => {
    await withRecoveryHome(async (home) => {
      const candidate = await writeFixture(path.join(home, "bin/node"));
      mocks.admissible.add(candidate);
      process.argv = [process.execPath, "/fixture/openclaw.mjs", ...args];

      expect(await recoverNodeRuntime({ homeDir: home })).toBe(false);
      expect(mocks.probe).not.toHaveBeenCalled();
      expect(mocks.spawn).not.toHaveBeenCalled();
    });
  });

  it.each([0, 7])(
    "preserves the invocation and propagates replacement exit %s",
    async (exitCode) => {
      await withRecoveryHome(async (home) => {
        const candidate = await writeFixture(path.join(home, "bin/node"));
        mocks.admissible.add(candidate);
        process.execArgv = ["--trace-warnings"];
        vi.stubEnv("OPENCLAW_TEST_VALUE", "preserved");
        vi.stubEnv("NODE_OPTIONS", "--no-warnings");
        const originalEnv = { ...process.env };
        const originalCwd = process.cwd();

        await expectRecoveryStarted(home);

        expect(mocks.spawn).toHaveBeenCalledExactlyOnceWith(
          candidate,
          ["--trace-warnings", "/fixture/dist/index.js", "doctor", "--non-interactive", "--fix"],
          { stdio: "inherit", env: { ...originalEnv, OPENCLAW_NODE_UPDATE_RESPAWNED: "1" } },
        );
        expect(process.cwd()).toBe(originalCwd);
        expect(exitSpy).not.toHaveBeenCalled();
        expect(() => child.emit("exit", exitCode, null)).toThrow(exitSentinel);
        expect(exitSpy).toHaveBeenCalledExactlyOnceWith(exitCode);
      });
    },
  );
});

describe("candidate admission probe", () => {
  it("never probes a non-Node symlink target", async () => {
    await withRecoveryHome(async (home) => {
      const target = await writeFixture(path.join(home, "another-executable"));
      const alias = path.join(home, "bin/node");
      mocks.virtualPaths.set(alias, target);

      expect(isUsableNode(alias)).toBe(false);
      expect(mocks.probe).not.toHaveBeenCalled();
    });
  });

  it("runs only the shared bounded probe with a sanitized environment", async () => {
    await withRecoveryHome(async (home) => {
      const candidate = await writeFixture(path.join(home, "bin/node"));
      mocks.admissible.add(candidate);
      for (const key of [
        "NODE_OPTIONS",
        "NODE_PATH",
        "LD_PRELOAD",
        "DYLD_INSERT_LIBRARIES",
        "OPENCLAW_TEST_SECRET",
      ]) {
        vi.stubEnv(key, "synthetic-untrusted-value");
      }
      vi.stubEnv("SystemRoot", "/fixture/windows");
      vi.stubEnv("TMPDIR", path.join(home, "tmp"));

      expect(isUsableNode(candidate)).toBe(true);

      expect(mocks.probe).toHaveBeenCalledOnce();
      const [, args, options] = expectDefined(mocks.probe.mock.calls[0], "runtime probe call");
      expect(args).toEqual(["-e", expect.stringContaining(SQLITE_CAPABILITY_PROBE)]);
      expect(options).toMatchObject({
        timeout: 5_000,
        maxBuffer: 65_536,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        env: {
          NODE_NO_WARNINGS: "1",
          SystemRoot: "/fixture/windows",
          TMPDIR: path.join(home, "tmp"),
        },
      });
      expect(
        Object.keys(options.env ?? {}).every((key) =>
          /^(SystemRoot|WINDIR|TEMP|TMP|TMPDIR|NODE_NO_WARNINGS)$/i.test(key),
        ),
      ).toBe(true);
    });
  });

  it.each(["timeout", "malformed response", "failed exit"])("rejects %s", async (failure) => {
    await withRecoveryHome(async (home) => {
      const candidate = await writeFixture(path.join(home, "bin/node"));
      mocks.admissible.add(candidate);
      mocks.probe.mockReturnValue({
        pid: 100,
        status: failure === "timeout" ? null : failure === "failed exit" ? 1 : 0,
        signal: failure === "timeout" ? "SIGTERM" : null,
        output: [],
        stdout:
          failure === "malformed response"
            ? "not JSON"
            : JSON.stringify({
                version: "24.19.0",
                probe: { available: true, version: "3.51.3", text: true, blob: true, json: true },
              }),
        stderr: "",
      });

      expect(isUsableNode(candidate)).toBe(false);
    });
  });
});
