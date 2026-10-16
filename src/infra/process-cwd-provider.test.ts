import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";

const { spawn, lstat, generation } = vi.hoisted(() => ({
  spawn: vi.fn(),
  lstat: vi.fn(),
  generation: vi.fn(),
}));
vi.mock("node:child_process", () => ({ spawnSync: spawn }));
vi.mock("node:fs", () => ({ lstatSync: lstat }));
vi.mock("../process/supervisor/service-child-group-ownership.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../process/supervisor/service-child-group-ownership.js")
  >()),
  readLinuxProcessGeneration: generation,
  linuxProcessGenerationMatches: (left: unknown, right: unknown) =>
    left !== undefined && right !== undefined && JSON.stringify(left) === JSON.stringify(right),
}));
import {
  hasProcessCwdProvider,
  readProviderProcessWorkingDirectory,
} from "./process-cwd-provider.js";

const socket = `/run/openclaw-cwd-${"a".repeat(32)}/provider.sock`;
const target = {
  startTicks: "321",
  ppid: 2,
  uids: [999, 999, 999, 999],
  gids: [983, 983, 102, 983],
} as const;
const self = {
  startTicks: "123",
  ppid: 1,
  uids: [999, 999, 999, 999],
  gids: [983, 983, 983, 983],
} as const;

beforeEach(() => {
  mockProcessPlatform("linux");
  vi.spyOn(process, "getgid").mockReturnValue(983);
  vi.spyOn(process, "getuid").mockReturnValue(999);
  vi.stubEnv("OPENCLAW_PROCESS_CWD_PROVIDER", socket);
  generation.mockReset().mockImplementation((pid: number) => (pid === process.pid ? self : target));
  lstat.mockReset().mockImplementation((file: string) => ({
    dev: 1n,
    ino: file === socket ? 3n : file === "/run" ? 1n : 2n,
    uid: 0n,
    gid: file === "/run" ? 0n : 983n,
    nlink: file === socket ? 1n : 2n,
    mode: file === socket ? 0o140660n : 0o40750n,
    ctimeNs: 1n,
    isSocket: () => file === socket,
    isDirectory: () => file !== socket,
  }));
  spawn.mockReset().mockImplementation((_exe, _args, options) => {
    const { request } = JSON.parse(options.input);
    return {
      status: 0,
      signal: null,
      stderr: "",
      stdout: JSON.stringify({
        schema: request.schema,
        nonce: request.nonce,
        consumer: request.consumer,
        target: { pid: 42, ...target },
        cwd: "/safe/runtime",
      }),
    };
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("consumes positive cwd only after the bounded native client has exited and identities pair", () => {
  expect(readProviderProcessWorkingDirectory(42, target, Date.now() + 10_000)).toBe(
    "/safe/runtime",
  );
  expect(spawn).toHaveBeenCalledOnce();
  const [executable, args, options] = spawn.mock.calls[0]!;
  expect(executable).toBe(process.execPath);
  expect(args.slice(0, 2)).toEqual(["--input-type=module", "--eval"]);
  expect(options).toMatchObject({ timeout: 1500, killSignal: "SIGKILL", maxBuffer: 16384 });
  expect(options.env).not.toHaveProperty("OPENCLAW_PROCESS_CWD_PROVIDER");
});

it("caps the native client timeout at the remaining shared census budget", () => {
  vi.spyOn(Date, "now").mockReturnValue(1_000);
  expect(readProviderProcessWorkingDirectory(42, target, 1_125)).toBe("/safe/runtime");
  expect(spawn.mock.calls[0]![2].timeout).toBe(125);
});

it("does not start a client when admission consumes the remaining budget", () => {
  let now = 1_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  generation.mockImplementation((pid: number) => {
    now = 1_100;
    return pid === process.pid ? self : target;
  });
  expect(readProviderProcessWorkingDirectory(42, target, 1_100)).toBeUndefined();
  expect(spawn).not.toHaveBeenCalled();
});

it("does not consume a response returned after the census deadline", () => {
  let now = 1_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const original = spawn.getMockImplementation()!;
  spawn.mockImplementation((...args) => {
    now = 1_100;
    return original(...args);
  });
  expect(readProviderProcessWorkingDirectory(42, target, 1_100)).toBeUndefined();
  expect(spawn).toHaveBeenCalledOnce();
});

it.each([
  [0, 0, 0, 0],
  [1000, 1000, 1000, 1000],
  [999, 999, 0, 999],
] as const)("rejects a nonmatching complete UID tuple before launching a client: %j", (...uids) => {
  expect(
    readProviderProcessWorkingDirectory(42, { ...target, uids }, Date.now() + 1_000),
  ).toBeUndefined();
  expect(spawn).not.toHaveBeenCalled();
});

it.each([undefined, "/tmp/provider.sock", "@abstract", "/run/openclaw-cwd-invalid/provider.sock"])(
  "does not use an unauthenticated locator %s",
  (value) => {
    vi.stubEnv("OPENCLAW_PROCESS_CWD_PROVIDER", value);
    expect(hasProcessCwdProvider()).toBe(false);
    expect(readProviderProcessWorkingDirectory(42, target, Date.now() + 10_000)).toBeUndefined();
    expect(spawn).not.toHaveBeenCalled();
  },
);

it.each(["uid", "writable-parent", "socket-mode", "symlink", "inaccessible"])(
  "refuses %s before starting a client",
  (kind) => {
    const original = lstat.getMockImplementation()!;
    lstat.mockImplementation((file: string) => {
      if (kind === "inaccessible") {
        throw Object.assign(new Error(), { code: "EACCES" });
      }
      const value = original(file);
      if (kind === "uid") {
        value.uid = 999n;
      }
      if (kind === "writable-parent" && file !== socket) {
        value.mode = 0o40777n;
      }
      if (kind === "socket-mode" && file === socket) {
        value.mode = 0o140666n;
      }
      if (kind === "symlink") {
        value.isDirectory = value.isSocket = () => false;
      }
      return value;
    });
    expect(readProviderProcessWorkingDirectory(42, target, Date.now() + 10_000)).toBeUndefined();
    expect(spawn).not.toHaveBeenCalled();
  },
);

it.each([
  "error",
  "exit",
  "signal",
  "stderr",
  "nonce",
  "pid",
  "birth",
  "uid",
  "gid",
  "relative",
  "deleted",
  "oversize",
  "json",
  "socket-drift",
  "consumer-drift",
])("does not consume cwd after %s", (kind) => {
  const original = spawn.getMockImplementation()!;
  spawn.mockImplementation((...args) => {
    const result = original(...args);
    const response = JSON.parse(result.stdout);
    if (kind === "error") {
      result.error = new Error("timeout");
    }
    if (kind === "exit") {
      result.status = 1;
    }
    if (kind === "signal") {
      result.signal = "SIGKILL";
    }
    if (kind === "stderr") {
      result.stderr = "unexpected";
    }
    if (kind === "nonce") {
      response.nonce = "other";
    }
    if (kind === "pid") {
      response.target.pid = 43;
    }
    if (kind === "birth") {
      response.target.startTicks = "322";
    }
    if (kind === "uid") {
      response.target.uids[2] = 0;
    }
    if (kind === "gid") {
      response.target.gids[2] = 0;
    }
    if (kind === "relative") {
      response.cwd = "relative";
    }
    if (kind === "deleted") {
      response.cwd = "/safe/runtime (deleted)";
    }
    if (kind === "oversize") {
      response.cwd = "/" + "x".repeat(4096);
    }
    if (kind === "socket-drift") {
      lstat.mockImplementation(() => {
        throw new Error("gone");
      });
    }
    if (kind === "consumer-drift") {
      generation.mockReturnValue({ ...self, startTicks: "124" });
    }
    result.stdout = kind === "json" ? "{" : JSON.stringify(response);
    return result;
  });
  expect(readProviderProcessWorkingDirectory(42, target, Date.now() + 10_000)).toBeUndefined();
});
