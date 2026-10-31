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
import { CLI_PARENT_BOUND_PRELOAD } from "../../cli-parent-lifetime.mjs";
import {
  findUsableNodeRuntime,
  isUsableNode,
  recoverNodeRuntime,
} from "../../node-runtime-recovery.mjs";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { createCliTtyMock } from "../cli/test-runtime-capture.js";
import { buildTaskScript } from "../daemon/schtasks-layout.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import { encodeWindowsLauncherScript } from "./windows-launcher-encoding.js";

// Platform fixtures do not create host files; node discovery still uses its real bootstrap.
vi.mock("../../runtime-process-scripts.generated.mjs", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../runtime-process-scripts.generated.mjs")>();
  return {
    ...actual,
    createRuntimeProcessScriptFile: (
      name: Parameters<typeof actual.createRuntimeProcessScriptFile>[0],
      options?: Parameters<typeof actual.createRuntimeProcessScriptFile>[1],
    ) =>
      name === "daemonRuntimeProbe"
        ? { url: new URL("file:///qa/daemon-runtime-probe.mjs"), dispose() {} }
        : actual.createRuntimeProcessScriptFile(name, options),
  };
});

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
  detectCurrentSqliteCapabilities: async () => sqlite(mocks.currentAdmitted),
}));
vi.mock("./windows-encoding.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./windows-encoding.js")>()),
  resolveWindowsOemEncoding: () => mocks.encoding,
  resolveWindowsOemCodePage: () => 437,
}));

const sqlite = (text: boolean) => ({
  available: true,
  version: "3.51.3",
  text,
  blob: true,
  json: true,
});
const probeResult = (text: boolean): SpawnSyncReturns<string> => ({
  pid: 100,
  status: 0,
  signal: null,
  output: [],
  stderr: "",
  stdout: JSON.stringify({ nodeVersion: "24.22.1", sqliteProbe: sqlite(text) }),
});

const originalArgv = process.argv;
const originalExecArgv = process.execArgv;
const ttyMock = createCliTtyMock();
// Exercise the Node-only recovery branch when Bun owns Vitest; process-boundary cases still launch Node.
const bunVersionDescriptor = Object.getOwnPropertyDescriptor(process.versions, "bun");
const nodeVersionDescriptor = Object.getOwnPropertyDescriptor(process.versions, "node")!;
const execPathDescriptor = Object.getOwnPropertyDescriptor(process, "execPath")!;
const testNodeExecPath = resolveTestNodeExecPath();
const hostPlatform = process.platform;
const windowsPath = {
  isAbsolute: path.win32.isAbsolute.bind(path.win32),
  basename: path.win32.basename.bind(path.win32),
  dirname: path.win32.dirname.bind(path.win32),
  relative: (from: string, to: string) => path.win32.relative(from, to).replaceAll("\\", path.sep),
};
let home = "";
let child: ChildProcess;
let originalExitCode: typeof process.exitCode;
let spawned: ReturnType<typeof createDeferred<void>>;
const recoveries: Array<ReturnType<typeof recoverNodeRuntime>> = [];
let stderrSpy: MockInstance<typeof process.stderr.write>;

beforeEach(async () => {
  home = "";
  if (bunVersionDescriptor) {
    Object.defineProperty(process.versions, "bun", { value: undefined, configurable: true });
    Object.defineProperty(process.versions, "node", { value: "26.12.1", configurable: true });
    Object.defineProperty(process, "execPath", { value: testNodeExecPath, configurable: true });
  }
  mockProcessPlatform("linux");
  mocks.currentAdmitted = false;
  mocks.encoding = "utf-8";
  mocks.admissible.clear();
  mocks.virtualPaths.clear();
  mocks.probe.mockReset();
  mocks.spawn.mockReset();
  mocks.probe.mockImplementation((filename) => probeResult(mocks.admissible.has(filename)));
  child = new ChildProcess();
  originalExitCode = process.exitCode;
  process.exitCode = undefined;
  spawned = createDeferred();
  mocks.spawn.mockImplementation(() => {
    spawned.resolve();
    return child;
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
  home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-node-recovery-"));
  home = await fs.realpath(home);
  for (const [name, value] of Object.entries({
    HOME: home,
    PATH: path.join(home, "bin"),
    NVM_DIR: path.join(home, ".nvm"),
    FNM_DIR: path.join(home, ".fnm"),
    VOLTA_HOME: path.join(home, ".volta"),
    CI: "1",
  })) {
    vi.stubEnv(name, value);
  }
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

afterEach(async () => {
  child.emit("close", 0, null);
  await Promise.allSettled(recoveries.splice(0));
  process.exitCode = originalExitCode;
  process.argv = originalArgv;
  process.execArgv = originalExecArgv;
  ttyMock.restore();
  if (bunVersionDescriptor) {
    Object.defineProperty(process.versions, "bun", bunVersionDescriptor);
    Object.defineProperty(process.versions, "node", nodeVersionDescriptor);
    Object.defineProperty(process, "execPath", execPathDescriptor);
  }
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  if (home) {
    await fs.rm(home, { recursive: true, force: true });
  }
});

async function writeFixture(relative: string, text = "") {
  const filename = path.resolve(home, relative);
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, text);
  return filename;
}

async function expectRecoveryStarted(options: Parameters<typeof recoverNodeRuntime>[0] = {}) {
  const completion = recoverNodeRuntime(options);
  recoveries.push(completion);
  await awaitGateBeforeSettlement(
    spawned.promise,
    completion,
    "recovery did not spawn a replacement",
  );
  expect(mocks.spawn).toHaveBeenCalledOnce();
  return { completion };
}

describe("runtime recovery discovery", () => {
  it.each([
    { platform: "win32", quote: '"', relative: false, selected: true },
    { platform: "win32", quote: "", relative: false, selected: true },
    { platform: "win32", quote: '"', relative: true, selected: false },
    { platform: "linux", quote: '"', relative: false, selected: false },
  ] as const)(
    "recovers from $platform PATH (quote=$quote, relative=$relative)",
    async ({ platform, quote, relative, selected }) => {
      mockProcessPlatform(platform);
      const candidate = await writeFixture(
        path.join("Node Runtime", platform === "win32" ? "node.exe" : "node"),
      );
      mocks.admissible.add(candidate);
      const directory = relative ? "Node Runtime" : path.dirname(candidate);
      const env = {
        HOME: home,
        PATH: `${quote}${directory}${quote}${platform === "win32" ? ";" : ":"}`,
      };

      if (selected) {
        await expectRecoveryStarted({ homeDir: home, env });
        expect(mocks.spawn.mock.calls[0]?.[0]).toBe(candidate);
      } else {
        expect(await recoverNodeRuntime({ homeDir: home, env })).toBe(false);
        expect(mocks.spawn).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["HOME", "OPENCLAW_HOME"])(
    "reuses a private runtime when cwd equals %s",
    async (homeVariable) => {
      const candidate = await writeFixture(".openclaw/tools/cli-node/tools/node/bin/node");
      vi.stubEnv("OPENCLAW_HOME", homeVariable === "OPENCLAW_HOME" ? home : undefined);
      if (homeVariable === "OPENCLAW_HOME") {
        vi.stubEnv("HOME", path.dirname(home));
      }
      vi.stubEnv("PATH", "");
      vi.spyOn(process, "cwd").mockReturnValue(home);
      mocks.admissible.add(candidate);

      await expectRecoveryStarted();
      expect(mocks.spawn.mock.calls[0]?.[0]).toBe(candidate);
      expect(mocks.probe.mock.calls.map(([file]) => file)).toEqual([candidate]);
    },
  );

  it.each(["none", "executable", "parent", "root"])(
    "rejects workspace and manager Nodes from HOME (private symlink escape=%s)",
    async (privateEscape) => {
      vi.stubEnv("OPENCLAW_HOME", undefined);
      vi.stubEnv("PATH", ".");
      vi.spyOn(process, "cwd").mockReturnValue(home);
      const workspaceNode = await writeFixture("node");
      const managerNode = await writeFixture(".nvm/versions/node/v24.22.1/bin/node");
      const plantedNodes = [workspaceNode, managerNode, await fs.realpath(process.execPath)];
      await writeFixture(".nvm/alias/default", "24");
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
    },
  );

  it.each([
    { name: "never reads competing cwd tilde service metadata", source: "competing" },
    { name: "rejects a relative Windows service state directory", source: "relative" },
    { name: "expands an explicit Windows task script against home", source: "home-script" },
    { name: "rejects an explicit Windows task script under cwd", source: "cwd-script" },
    { name: "rejects a Windows task script resolving under cwd", source: "symlink-script" },
    { name: "rejects a task script through a cwd-owned parent", source: "parent-script" },
  ])("$name", async ({ source }) => {
    const root = home;

    const state = source === "relative" ? "state" : "~/x";
    const daemonHome = path.join(root, "daemon $& home");
    const cwd = path.join(root, "checkout");
    await fs.mkdir(daemonHome);
    await fs.mkdir(cwd);
    const installedNode = await writeFixture(path.join(root, "installed", "node.exe"));
    const workspaceNode = await writeFixture(path.join(root, "sibling", "node.exe"));
    const homeScript = path.join(daemonHome, "x", "gateway.cmd");
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
    await writeScript(competingScript, workspaceNode);
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
            stdout: JSON.stringify({ nodeVersion: "24.22.1", sqliteProbe: { available: true, version: "3.53.4", text: true, blob: true, json: true } }) };
        };
        childProcess.spawn = (command) => {
          result.selected = command;
          const child = new EventEmitter();
          child.kill = () => true;
          setImmediate(() => { child.emit("exit", 23, null); child.emit("close", 23, null); });
          return child;
        };
        syncBuiltinESMExports();
        const { recoverNodeRuntime } = await import(${JSON.stringify(new URL("../../node-runtime-recovery.mjs", import.meta.url).href)});
        result.handled = await recoverNodeRuntime();
        fs.writeFileSync(${JSON.stringify(report)}, JSON.stringify(result));
      `,
    );
    const { spawnSync } =
      await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const result = spawnSync(testNodeExecPath, [driver, "doctor", "--fix", "--non-interactive"], {
      cwd,
      env: {
        ...process.env,
        HOME: daemonHome,
        USERPROFILE: daemonHome,
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
    if (["competing", "home-script"].includes(source)) {
      expect(result.status, result.stderr).toBe(23);
      expect(observed.reads).toContain(homeScript);
      expect(observed.selected).toBe(installedNode);
      expect(observed.handled).toBe(true);
    } else {
      expect(result.status, result.stderr).toBe(0);
      expect(observed.selected).toBeUndefined();
      expect(observed.handled).toBe(false);
    }
  });

  it.each(["relative PATH", "nvm link", "fnm parent", "private", "service"] as const)(
    "does not probe a workspace-owned %s runtime",
    async (source) => {
      const cwd = path.join(home, "untrusted-checkout");
      await fs.mkdir(cwd);
      const candidate = await writeFixture(
        source === "relative PATH"
          ? path.join(cwd, "bin/node")
          : source === "private" || source === "service"
            ? path.join(cwd, "node")
            : "outside/node",
      );
      vi.spyOn(process, "cwd").mockReturnValue(cwd);
      vi.stubEnv("PATH", source === "relative PATH" ? "bin" : "");
      let alias = candidate;
      if (source === "nvm link") {
        const root = path.join(cwd, ".nvm");
        alias = path.join(root, "versions/node/v24.22.1/bin/node");
        await writeFixture(path.join(root, "alias/default"), "24");
        await fs.mkdir(path.dirname(alias), { recursive: true });
        await fs.symlink(candidate, alias);
        vi.stubEnv("NVM_DIR", root);
      } else if (source === "fnm parent") {
        const bin = path.join(cwd, "bin/node");
        await fs.mkdir(path.dirname(bin), { recursive: true });
        await fs.symlink(candidate, bin);
        alias = path.join(home, ".fnm/aliases/default");
        await fs.mkdir(path.dirname(alias), { recursive: true });
        await fs.symlink(cwd, alias, "junction");
      } else if (source === "private" || source === "service") {
        const service = path.join(home, "service/bin/node");
        alias =
          source === "private"
            ? path.join(home, ".openclaw/tools/cli-node/tools/node/bin/node")
            : service;
        mocks.virtualPaths.set(alias, candidate);
        await writeFixture(
          ".config/systemd/user/openclaw-gateway.service",
          `[Service]\nExecStart="${service.replaceAll("\\", "\\\\")}" /fixture/dist/index.js gateway\n`,
        );
      }
      expect(await recoverNodeRuntime({ homeDir: home })).toBe(false);
      const probed = mocks.probe.mock.calls.map(([file]) => file);
      expect(probed).not.toContain(candidate);
      expect(probed).not.toContain(alias);
      expect(mocks.spawn).not.toHaveBeenCalled();
    },
  );

  it.each([true, false])("recovers without an OS account record (HOME=%s)", async (hasHome) => {
    const candidate = await writeFixture(path.join("bin", "node"));
    const account = vi.spyOn(os, "userInfo").mockImplementation(() => {
      throw new Error("OS account record unavailable");
    });
    if (!hasHome) {
      vi.stubEnv("HOME", undefined);
      vi.stubEnv("USERPROFILE", undefined);
    }
    mocks.admissible.add(candidate);
    await expectRecoveryStarted({ homeDir: home });
    expect(mocks.spawn.mock.calls[0]?.[0]).toBe(candidate);
    expect(account).toHaveBeenCalledTimes(hasHome ? 0 : 1);
  });

  it.each([
    ["NVM_DIR", "versions/node/v24.22.1/bin/node", "alias/default", "24"],
    ["FNM_DIR", "aliases/default/bin/node", "", ""],
    [
      "VOLTA_HOME",
      "tools/image/node/24.22.1/bin/node",
      "tools/user/platform.json",
      '{"node":{"runtime":"24.22.1"}}',
    ],
  ])("expands the %s manager root against home", async (key, binary, metadata, contents) => {
    const root = path.join(home, "custom-manager");
    const candidate = await writeFixture(path.join(root, binary));
    if (metadata) {
      await writeFixture(path.join(root, metadata), contents);
    }
    vi.stubEnv(key, "~/custom-manager");
    mocks.admissible.add(candidate);
    await expectRecoveryStarted({ homeDir: home });
    expect(mocks.spawn.mock.calls[0]?.[0]).toBe(candidate);
  });

  it.each(["HOME", "USERPROFILE", "OPENCLAW_HOME"])(
    "expands inherited %s before private discovery",
    async (key) => {
      const candidate = await writeFixture(
        "custom-home/.openclaw/tools/cli-node/tools/node/bin/node",
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

      await expectRecoveryStarted();
      expect(mocks.spawn.mock.calls[0]?.[0]).toBe(candidate);
    },
  );

  it("uses inherited PATH and probe settings after process env changes", async () => {
    const inheritedNode = await writeFixture("inherited/bin/node");
    const systemNode = await writeFixture("system/bin/node");
    const workspaceNode = await writeFixture("workspace/bin/node");
    const env = {
      ...process.env,
      PATH: [path.dirname(systemNode), path.dirname(inheritedNode)].join(path.delimiter),
      TEMP: home,
      npm_config_node: "operator-choice",
    };
    vi.stubEnv("PATH", path.dirname(workspaceNode));
    vi.stubEnv("TEMP", path.join(home, "workspace"));
    vi.stubEnv("FNM_DIR", path.join(home, "workspace-fnm"));
    mocks.admissible.add(inheritedNode);
    mocks.admissible.add(workspaceNode);

    await expectRecoveryStarted({ homeDir: home, env });

    expect(mocks.probe.mock.calls.map(([file]) => file)).toEqual([systemNode, inheritedNode]);
    expect(mocks.probe.mock.calls[0]?.[2].env).toMatchObject({ TEMP: home });
    expect(mocks.spawn.mock.calls[0]?.[2].env).toEqual({
      ...env,
      PATH: [path.dirname(inheritedNode), path.dirname(systemNode)].join(path.delimiter),
      OPENCLAW_NODE_UPDATE_RESPAWNED: "1",
    });
  });

  it.each([
    ["unquoted", "C:\\Node24\\node.exe", "utf-8", false, "cmd"],
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
        const fallback = await writeFixture("fallback/bin/node.exe");
        vi.stubEnv("PATH", path.dirname(fallback));
        mocks.admissible.add(fallback);
        await expectRecoveryStarted({ homeDir: home });
        expect(mocks.probe.mock.calls.map(([file]) => file)).toEqual([fallback]);
        expect(mocks.spawn.mock.calls[0]?.[0]).toBe(fallback);
      } else {
        await expectRecoveryStarted({ homeDir: home });
        expect(mocks.probe.mock.calls.map(([file]) => file)).toEqual([candidate]);
        expect(mocks.spawn.mock.calls[0]?.[0]).toBe(candidate);
      }
    },
  );

  it.each([false, true])(
    "selects absolute PATH after rejecting cwd service metadata (alias=%s)",
    async (aliased) => {
      const cwd = path.join(home, "checkout");
      await fs.mkdir(cwd);
      const candidate = await writeFixture(aliased ? "outside/node" : path.join(cwd, "node"));
      let service = candidate;
      if (aliased) {
        await fs.symlink(candidate, path.join(cwd, "node"));
        const alias = path.join(home, "service-alias");
        await fs.symlink(cwd, alias, "junction");
        service = path.join(alias, "node");
      }
      await writeFixture(
        ".config/systemd/user/openclaw-gateway.service",
        `[Service]\nExecStart="${service.replaceAll("\\", "\\\\")}" /fixture/dist/index.js gateway\n`,
      );
      vi.spyOn(process, "cwd").mockReturnValue(cwd);
      vi.stubEnv("PATH", path.dirname(candidate));
      mocks.admissible.add(candidate);
      await expectRecoveryStarted({ homeDir: home });
      expect(mocks.spawn.mock.calls[0]?.[0]).toBe(candidate);
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("(PATH;"));
    },
  );

  it.each([
    [0, "cached OpenClaw runtime", undefined],
    [1, "managed Gateway service", undefined],
    [7, "Homebrew node@24", undefined],
    ...(hostPlatform === "win32"
      ? []
      : ([
          [1, "managed Gateway service", "/"],
          [7, "Homebrew node@24", "/"],
        ] as const)),
  ] as const)("selects runtime %s: %s (cwd=%s)", async (index, source, cwd) => {
    const candidates = await Promise.all(
      [
        ".openclaw/tools/cli-node/tools/node/bin/node",
        "service/bin/node",
        "bin/node",
        ".nvm/versions/node/v24.22.1/bin/node",
        ".fnm/aliases/default/bin/node",
        ".volta/tools/image/node/24.22.1/bin/node",
        "brew26/bin/node",
        "brew24/bin/node",
      ].map((relative) => writeFixture(relative)),
    );
    await writeFixture(
      ".config/systemd/user/openclaw-gateway.service",
      `[Service]\nExecStart="${expectDefined(candidates[1], "service candidate").replaceAll("\\", "\\\\")}" /fixture/dist/index.js gateway run\n`,
    );
    await writeFixture(".nvm/alias/default", "lts/test\n");
    await writeFixture(".nvm/alias/lts/test", "24\n");
    await writeFixture(
      ".volta/tools/user/platform.json",
      JSON.stringify({ node: { runtime: "24.22.1" } }),
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
    if (cwd) {
      vi.spyOn(process, "cwd").mockReturnValue(cwd);
    }
    for (const candidate of candidates.slice(index)) {
      mocks.admissible.add(candidate);
    }

    await expectRecoveryStarted({ homeDir: home });

    expect(mocks.probe.mock.calls.map(([filename]) => filename)).toEqual(
      candidates.slice(0, index + 1),
    );
    expect(mocks.spawn.mock.calls[0]?.[0]).toBe(candidates[index]);
    expect(stderrSpy).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining(`(${source}; current Node failed runtime admission:`),
    );
    expect(stderrSpy).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("node:sqlite truncates TEXT at embedded NUL"),
    );
  });

  it.each(["direct", "shell wrapper", "executable wrapper"])(
    "finds the profiled launchd runtime through a %s command",
    async (form) => {
      mockProcessPlatform("darwin");

      const candidate = await writeFixture("service & runtime/bin/node");
      mocks.admissible.add(candidate);
      process.argv = [process.execPath, "/fixture/openclaw.mjs", "--profile", "fixture", "doctor"];
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
        "Library/LaunchAgents/ai.openclaw.fixture.plist",
        `<key>ProgramArguments</key><array>${args.map((arg) => `<string>${arg.replaceAll("&", "&amp;")}</string>`).join("")}</array>`,
      );

      await expectRecoveryStarted({ homeDir: home });

      expect(mocks.probe.mock.calls.map(([filename]) => filename)).toEqual([candidate]);
      expect(mocks.spawn.mock.calls[0]?.[0]).toBe(candidate);
    },
  );

  it("ignores PATH aliases for the running executable and probes each other binary once", async () => {
    await fs.mkdir(path.join(home, "bin"));
    if (hostPlatform === "win32") {
      mocks.virtualPaths.set(path.join(home, "bin/node"), await fs.realpath(process.execPath));
    } else {
      await fs.symlink(process.execPath, path.join(home, "bin/node"));
    }
    const replacement = await writeFixture("replacement/bin/node");
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

    expect(mocks.probe.mock.calls.filter(([filename]) => filename === replacement)).toHaveLength(1);
    expect(mocks.probe.mock.calls.some(([filename]) => filename === process.execPath)).toBe(false);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it.each(["already admitted", "replacement child"])(
    "does not discover for an %s",
    async (reason) => {
      const candidate = await writeFixture("bin/node");
      mocks.admissible.add(candidate);
      mocks.currentAdmitted = reason === "already admitted";
      if (reason === "replacement child") {
        vi.stubEnv("OPENCLAW_NODE_UPDATE_RESPAWNED", "1");
      }

      expect(await recoverNodeRuntime({ homeDir: home })).toBe(false);
      expect(mocks.probe).not.toHaveBeenCalled();
      expect(mocks.spawn).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["--profile", "fixture", "webhooks", "gmail", "run"],
    ["webhooks", "--log-level=debug", "gmail", "--no-color", "run"],
    ["hooks", "relay", "--relay-id", "fixture"],
  ])("keeps exact-PID invocation %j in its original process", async (...args) => {
    const candidate = await writeFixture("bin/node");
    mocks.admissible.add(candidate);
    process.argv = [process.execPath, "/fixture/openclaw.mjs", ...args];

    expect(await recoverNodeRuntime({ homeDir: home })).toBe(false);
    expect(mocks.probe).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it.each([
    { terminal: "none", stdinTTY: false, stdoutTTY: false, hide: true, exitCode: 0 },
    { terminal: "stdin", stdinTTY: true, stdoutTTY: false, hide: false, exitCode: 0 },
    { terminal: "stdout", stdinTTY: false, stdoutTTY: true, hide: false, exitCode: 7 },
  ])(
    "preserves invocation and replacement exit $exitCode with $terminal terminal stdio",
    async ({ stdinTTY, stdoutTTY, hide, exitCode }) => {
      Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: stdinTTY });
      Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: stdoutTTY });

      const candidate = await writeFixture("bin/node");
      mocks.admissible.add(candidate);
      process.execArgv = ["--trace-warnings"];
      vi.stubEnv("OPENCLAW_TEST_VALUE", "preserved");
      vi.stubEnv("NODE_OPTIONS", "--no-warnings");
      const originalEnv = { ...process.env };
      const originalCwd = process.cwd();

      const { completion } = await expectRecoveryStarted({ homeDir: home });

      expect(mocks.spawn).toHaveBeenCalledExactlyOnceWith(
        candidate,
        [
          "--import",
          CLI_PARENT_BOUND_PRELOAD,
          "--trace-warnings",
          "/fixture/dist/index.js",
          "doctor",
          "--non-interactive",
          "--fix",
        ],
        {
          stdio: ["inherit", "inherit", "inherit", "ipc"],
          env: { ...originalEnv, OPENCLAW_NODE_UPDATE_RESPAWNED: "1" },
          windowsHide: hide,
        },
      );
      expect(process.cwd()).toBe(originalCwd);
      expect(process.exitCode).toBeUndefined();
      child.emit("exit", exitCode, null);
      expect(process.exitCode).toBeUndefined();
      child.emit("close", exitCode, null);
      await expect(completion).resolves.toBe(true);
      expect(process.exitCode).toBe(exitCode);
    },
  );
});

describe("candidate admission probe", () => {
  it("never probes a non-Node symlink target", async () => {
    const target = await writeFixture("another-executable");
    const alias = path.join(home, "bin/node");
    mocks.virtualPaths.set(alias, target);

    expect(isUsableNode(alias)).toBe(false);
    expect(mocks.probe).not.toHaveBeenCalled();
  });

  it("runs only the shared bounded probe with a sanitized environment", async () => {
    const candidate = await writeFixture("bin/node");
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
    expect(args).toEqual([expect.stringMatching(/daemon-runtime-probe\.mjs$/), "node"]);
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

  it.each(["timeout", "malformed response", "failed exit"])("rejects %s", async (failure) => {
    const candidate = await writeFixture("bin/node");
    mocks.admissible.add(candidate);
    mocks.probe.mockReturnValue({
      ...probeResult(true),
      status: failure === "timeout" ? null : failure === "failed exit" ? 1 : 0,
      signal: failure === "timeout" ? "SIGTERM" : null,
      stdout: failure === "malformed response" ? "not JSON" : probeResult(true).stdout,
    });

    expect(isUsableNode(candidate)).toBe(false);
  });

  it("rejects candidates when the permission model denies child processes", async () => {
    const candidate = await writeFixture("bin/node");
    mocks.admissible.add(candidate);
    mocks.probe.mockImplementation(() => {
      throw Object.assign(new Error("Access to this API has been restricted"), {
        code: "ERR_ACCESS_DENIED",
      });
    });

    expect(isUsableNode(candidate)).toBe(false);
  });
});

it("selects a target-compatible inherited runtime even when the current CLI is supported", async () => {
  mocks.currentAdmitted = true;
  const oldNode = await writeFixture(path.join("old", "node"));
  const newNode = await writeFixture(path.join("new", "node"));
  const probe = expectDefined(mocks.probe.getMockImplementation(), "runtime probe");
  mocks.admissible.add(oldNode);
  mocks.admissible.add(newNode);
  mocks.probe.mockImplementation((filename, args, options) => {
    const result = probe(filename, args, options);
    const payload = JSON.parse(result.stdout);
    payload.nodeVersion = filename === newNode ? "26.12.1" : "24.22.1";
    return { ...result, stdout: JSON.stringify(payload) };
  });
  const selected = await findUsableNodeRuntime({
    env: {
      HOME: home,
      PATH: [path.dirname(oldNode), path.dirname(newNode)].join(path.delimiter),
    },
    acceptVersion: (version) => version.startsWith("26."),
  });
  expect(selected).toEqual({ nodePath: newNode, reason: "PATH" });
  expect(mocks.spawn).not.toHaveBeenCalled();
});
