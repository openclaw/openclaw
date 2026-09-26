import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import { readGatewayLockProcessCmdline } from "./gateway-lock-process.js";
import {
  findVerifiedGatewayListenerPidsOnPortSync,
  signalVerifiedGatewayPidSync,
} from "./gateway-processes.js";
import {
  cleanStaleGatewayProcessesSync,
  findGatewayPidsOnPortSync,
  inspectSelfAndAncestorPidsSync,
} from "./restart-stale-pids.js";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  read: vi.fn(),
  readlink: vi.fn(),
  darwinCommand: vi.fn(),
  warn: vi.fn(),
  windowsListeners: vi.fn(),
  windowsArgs: vi.fn(),
}));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: mocks.spawn,
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  mocks.read.mockImplementation(actual.readFileSync);
  mocks.readlink.mockImplementation(actual.readlinkSync);
  const overrides = { readFileSync: mocks.read, readlinkSync: mocks.readlink };
  return { ...actual, ...overrides, default: { ...actual, ...overrides } };
});
vi.mock("./ports-lsof.js", () => ({ resolveLsofCommandSync: () => "lsof" }));
vi.mock("./gateway-owner-lease.js", () => ({ readGatewayOwnerLease: vi.fn() }));
vi.mock("../logging/subsystem.js", () => ({ createSubsystemLogger: () => ({ warn: mocks.warn }) }));
vi.mock("./windows-port-pids.js", () => ({
  readWindowsListeningPidsResultSync: mocks.windowsListeners,
  readWindowsProcessArgsResultSync: mocks.windowsArgs,
}));
vi.mock("./windows-process-start.js", () => ({
  readWindowsProcessAncestorsSync: () => ({ pids: [], complete: false }),
}));
vi.mock("../process/supervisor/darwin-process-command.js", () => ({
  readDarwinProcessCommand: mocks.darwinCommand,
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it.each(
  (["linux", "darwin"] as const).flatMap((platform) =>
    [true, false].map((complete) => ({ platform, complete })),
  ),
)(
  "distinguishes complete ancestry from unavailable parents on $platform ($complete)",
  ({ platform, complete }) => {
    vi.stubGlobal("process", { ...process, platform, pid: 41, ppid: 40 });
    mocks.read.mockImplementation(() => {
      if (!complete) {
        throw new Error("process ancestry unavailable");
      }
      return "PPid:\t1\n";
    });
    mocks.spawn.mockReturnValue({ status: complete ? 0 : 1, stdout: complete ? "1\n" : "" });
    expect(inspectSelfAndAncestorPidsSync()).toEqual({
      pids: new Set(complete ? [41, 40, 1] : [41, 40]),
      complete,
    });
  },
);

it("reports an unclassified Windows listener without reclaiming its process", () => {
  const pid = process.pid + 901;
  mocks.windowsListeners.mockReturnValue({ ok: true, pids: [pid] });
  mocks.windowsArgs.mockReturnValue({ ok: true, args: ["node", "dist/index.js", "gateway"] });
  const kill = vi.spyOn(process, "kill").mockReturnValue(true);
  withMockedPlatform("win32", () => {
    expect(cleanStaleGatewayProcessesSync(18789)).toEqual([]);
  });
  expect(mocks.warn).toHaveBeenCalledWith(
    expect.stringContaining(`Could not classify PID ${pid}:`),
  );
  expect(kill).not.toHaveBeenCalled();
});

it.each(["linux", "darwin"] as const)(
  "verifies relative gateway scripts against each listener's native cwd on %s",
  async (platform) => {
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const root = tempDirs.make("gateway-pid-cwd-");
    const ownedPid = process.pid + 401;
    const unrelatedPid = process.pid + 402;
    const unknownPid = process.pid + 403;
    const directories = new Map<number, string>();
    mocks.darwinCommand.mockReturnValue({ argv: ["node", "dist/index.js", "gateway"] });
    for (const [pid, name] of [
      [ownedPid, "openclaw"],
      [unrelatedPid, "other-service"],
    ] as const) {
      const directory = path.join(
        root,
        platform === "darwin" && process.platform !== "win32"
          ? `${pid}\nworking directory`
          : String(pid),
      );
      fs.mkdirSync(path.join(directory, "dist"), { recursive: true });
      fs.writeFileSync(path.join(directory, "dist", "index.js"), "");
      fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name }));
      directories.set(pid, directory);
    }
    mocks.read.mockImplementation((file: string) => {
      if (/^\/proc\/\d+\/cmdline$/.test(file)) {
        return "node\0dist/index.js\0gateway\0";
      }
      if (file.startsWith("/proc/")) {
        throw Object.assign(new Error("ancestor unavailable"), { code: "ENOENT" });
      }
      return actualFs.readFileSync(file, "utf8");
    });
    mocks.readlink.mockImplementation((file: unknown) => {
      const pid = Number(/^\/proc\/(\d+)\/cwd$/.exec(String(file))?.[1]);
      const directory = directories.get(pid);
      if (!directory) {
        throw Object.assign(new Error("working directory unavailable"), { code: "EACCES" });
      }
      return directory;
    });
    mocks.spawn.mockImplementation((command: string, args: string[]) => {
      const result = { error: null, status: 0, stdout: "", stderr: "" };
      if (command === "lsof") {
        return {
          ...result,
          stdout: [ownedPid, unrelatedPid, unknownPid].map((pid) => `p${pid}\ncnode\n`).join(""),
        };
      }
      if (command === "/usr/sbin/lsof") {
        const pid = Number(args[2]);
        const directory = directories.get(pid);
        return directory
          ? { ...result, stdout: `p${pid}\0\nfcwd\0n${directory}\0\n` }
          : { ...result, status: 1 };
      }
      return { ...result, stdout: args[0] === "-ww" ? "node dist/index.js gateway\n" : "" };
    });
    withMockedPlatform(platform, () => {
      expect(findGatewayPidsOnPortSync(18789)).toEqual([ownedPid]);
    });
  },
);

it.each([
  { packageName: "openclaw", command: "node", verified: true },
  { packageName: "unrelated-indexer", command: "openclaw-indexer", verified: false },
])(
  "classifies the Darwin $command listener from native argv and package ownership",
  async ({ packageName, command, verified }) => {
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const root = path.join(tempDirs.make("gateway-native-argv-"), "application with spaces");
    const script = path.join(root, "dist", "index.js");
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.writeFileSync(script, "");
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: packageName }));
    const pid = process.pid + 701;
    const argv = ["node", script, "gateway"];
    mocks.read.mockImplementation(actualFs.readFileSync);
    mocks.darwinCommand.mockReturnValue({ argv });
    mocks.spawn.mockImplementation((executable: string) => ({
      error: null,
      status: 0,
      stderr: "",
      stdout: executable === "lsof" ? `p${pid}\nc${command}\n` : "",
    }));
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    withMockedPlatform("darwin", () => {
      expect(findGatewayPidsOnPortSync(18789)).toEqual(verified ? [pid] : []);
      expect(findVerifiedGatewayListenerPidsOnPortSync(18789)).toEqual(verified ? [pid] : []);
      if (verified) {
        signalVerifiedGatewayPidSync(pid, "SIGTERM");
        expect(kill).toHaveBeenCalledWith(pid, "SIGTERM");
      } else {
        expect(() => signalVerifiedGatewayPidSync(pid, "SIGTERM")).toThrow(
          "refusing to signal non-gateway process",
        );
        expect(kill).not.toHaveBeenCalled();
      }
      expect(readGatewayLockProcessCmdline(pid, "darwin", 1000)).toEqual(argv);
    });
  },
);

it.each(["linux", "darwin"] as const)(
  "verifies node listener argv and rejects malformed lsof PID tokens on %s",
  async (platform) => {
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const root = tempDirs.make("gateway-lsof-argv-");
    const script = path.join(root, "dist", "index.js");
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.writeFileSync(script, "");
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "openclaw" }));
    const pid = process.pid + 801;
    mocks.read.mockImplementation((file: string) => {
      if (file.startsWith("/proc/")) {
        throw Object.assign(new Error("procfs unavailable"), { code: "ENOENT" });
      }
      return actualFs.readFileSync(file, "utf8");
    });
    mocks.darwinCommand.mockReturnValue({
      argv: ["node", script, "gateway"],
    });
    mocks.spawn.mockImplementation((command: string, args: string[]) => ({
      error: null,
      status: 0,
      stderr: "",
      stdout:
        command === "lsof"
          ? `p111abc\ncnode\np${pid}\ncnode\n`
          : args[0] === "-ww"
            ? `node "${script}" gateway\n`
            : "",
    }));
    withMockedPlatform(platform, () => {
      expect(findGatewayPidsOnPortSync(18789)).toEqual([pid]);
    });
    if (platform === "linux") {
      const psCall = mocks.spawn.mock.calls.find(
        (call) => call[0] === "ps" && call[1]?.[0] === "-ww",
      );
      expect(psCall?.[1]).toEqual(["-ww", "-p", String(pid), "-o", "command="]);
      expect(psCall?.[2]).toEqual({
        env: expect.any(Object),
        encoding: "utf8",
        killSignal: "SIGKILL",
        timeout: 2000,
      });
    } else {
      expect(mocks.darwinCommand).toHaveBeenCalledWith(pid);
      expect(mocks.spawn.mock.calls.some((call) => call[1]?.includes("command="))).toBe(false);
    }
  },
);
