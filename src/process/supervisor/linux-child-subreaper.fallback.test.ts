import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import { acquireLinuxChildSubreaper } from "./linux-child-subreaper.js";

const SELF = process.pid;

const fs = vi.hoisted(() => ({
  readdir: vi.fn<(path: string) => string[]>(),
  readFile: vi.fn<(path: string) => string>(),
}));

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  readdirSync: (path: string) => fs.readdir(path),
  readFileSync: (path: string) => fs.readFile(path),
}));

const native = vi.hoisted(() => {
  const world = { zombies: new Set<number>(), reaped: new Set<number>() };
  return {
    world,
    becomeChildSubreaper: vi.fn(),
    isChildSubreaper: vi.fn(() => true),
    inspectChildWaitState: vi.fn((pid?: number) => {
      const retained = [...world.zombies].filter((candidate) => !world.reaped.has(candidate));
      if (pid === undefined) {
        return retained.length > 0 ? { kind: "exited" } : { kind: "none" };
      }
      return retained.includes(pid) ? { kind: "exited" } : { kind: "none" };
    }),
    reapChild: vi.fn((pid: number) => {
      world.reaped.add(pid);
      return true;
    }),
  };
});
vi.mock("@openclaw/proc-safe/reaper", () => ({
  becomeChildSubreaper: native.becomeChildSubreaper,
  isChildSubreaper: native.isChildSubreaper,
  inspectChildWaitState: native.inspectChildWaitState,
  reapChild: native.reapChild,
}));

const execArgv = process.execArgv;
beforeEach(() => {
  vi.clearAllMocks();
  native.world.zombies.clear();
  native.world.reaped.clear();
  mockProcessPlatform("linux");
  process.execArgv = [];
  vi.stubEnv("NODE_OPTIONS", "");
  vi.stubEnv("BUN_BE_BUN", undefined);
  vi.stubGlobal("__openclawStandaloneRootUrl", undefined);
});
afterEach(() => {
  process.execArgv = execArgv;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function enoent(): never {
  throw Object.assign(new Error("no such file or directory"), { code: "ENOENT" });
}

/**
 * A /proc without CONFIG_PROC_CHILDREN: thread directories exist, per-thread
 * children files never do, and stat lines remain the only parent map. The
 * returned rows model processes that appear after admission.
 */
function installProcWithoutChildrenFiles(): Map<number, string> {
  const rows = new Map<number, string>();
  fs.readdir.mockImplementation((path) =>
    path === "/proc/self/task" ? ["1"] : ["1", "self", "cpuinfo", SELF, ...rows.keys()].map(String),
  );
  fs.readFile.mockImplementation((path) => {
    if (path === "/proc/self/task/1/children") {
      enoent();
    }
    if (path === `/proc/${SELF}/stat`) {
      return `${SELF} (anchor) S 999 999 999 0 -1 0 0 0 0 0`;
    }
    if (path === "/proc/1/stat") {
      return "1 (systemd) S 0 1 1 0 -1 0 0 0 0 0";
    }
    const row = /^\/proc\/(\d+)\/stat$/u.exec(path);
    const stat = row === null ? undefined : rows.get(Number(row[1]));
    if (stat === undefined) {
      enoent();
    }
    return stat;
  });
  return rows;
}

it("drains adopted zombies when per-thread children files are unavailable", () => {
  const rows = installProcWithoutChildrenFiles();
  const owner = acquireLinuxChildSubreaper();
  rows.set(1234, `1234 (esbuild --servi) Z ${SELF} 1234 1234 0 -1 0 0 0 0 0`);
  native.world.zombies.add(1234);
  expect(owner.drain()).toBe(true);
  expect(native.reapChild).toHaveBeenCalledWith(1234);
});

it("enumerates by parent id from stat lines whose comm contains spaces and parentheses", () => {
  const rows = installProcWithoutChildrenFiles();
  const owner = acquireLinuxChildSubreaper();
  rows.set(2222, `2222 (helper ) two (3) S ${SELF} 2222 2222 0 -1 0 0 0 0 0`);
  rows.set(3333, `3333 (plain) S 1 3333 3333 0 -1 0 0 0 0 0`);
  rows.set(4444, `4444 (x)name)) Z ${SELF} 4444 4444 0 -1 0 0 0 0 0`);
  native.world.zombies.add(2222);
  native.world.zombies.add(4444);
  expect(owner.children()).toEqual([2222, 4444]);
});

it("keeps per-thread children files as the enumeration source when available", () => {
  fs.readdir.mockImplementation((path) => (path === "/proc/self/task" ? ["1"] : []));
  fs.readFile.mockImplementationOnce(() => "").mockImplementation(() => "777");
  const owner = acquireLinuxChildSubreaper();
  native.world.zombies.add(777);
  expect(owner.drain()).toBe(true);
  expect(native.reapChild).toHaveBeenCalledWith(777);
  expect(fs.readFile.mock.calls.filter(([path]) => path.endsWith("/stat"))).toEqual([]);
});

it("refuses admission when a stat enumeration finds pre-existing children", () => {
  const rows = installProcWithoutChildrenFiles();
  rows.set(555, `555 (preexisting) S ${SELF} 555 555 0 -1 0 0 0 0 0`);
  expect(() => acquireLinuxChildSubreaper()).toThrow(/dedicated owner without existing children/u);
});

it("fails loudly when neither enumeration method observes any process stat", () => {
  fs.readdir.mockImplementation((path) => (path === "/proc/self/task" ? ["1"] : ["cpuinfo"]));
  fs.readFile.mockImplementation(() => enoent());
  expect(() => acquireLinuxChildSubreaper()).toThrow(/could not enumerate its children/u);
});

it("tolerates an ESRCH stat read for a retiring foreign process before an adopted child", () => {
  const rows = installProcWithoutChildrenFiles();
  const retiring = 9999;
  fs.readdir.mockImplementation((path) =>
    path === "/proc/self/task"
      ? ["1"]
      : ["1", "self", "cpuinfo", String(retiring), SELF, ...rows.keys()].map(String),
  );
  const census = fs.readFile.getMockImplementation()!;
  fs.readFile.mockImplementation((path) => {
    if (path === `/proc/${retiring}/stat`) {
      // The kernel opened the stat file, but the task was gone by the read.
      throw Object.assign(new Error("no such process"), { code: "ESRCH" });
    }
    return census(path);
  });
  const owner = acquireLinuxChildSubreaper();
  rows.set(1234, `1234 (esbuild --servi) Z ${SELF} 1234 1234 0 -1 0 0 0 0 0`);
  native.world.zombies.add(1234);
  expect(owner.drain()).toBe(true);
  expect(native.reapChild).toHaveBeenCalledWith(1234);
});

it("still fails when the owner's own stat read reports ESRCH", () => {
  fs.readdir.mockImplementation((path) =>
    path === "/proc/self/task" ? ["1"] : ["1", "cpuinfo", SELF].map(String),
  );
  fs.readFile.mockImplementation((path) => {
    if (path === "/proc/self/task/1/children") {
      enoent();
    }
    if (path === `/proc/${SELF}/stat`) {
      throw Object.assign(new Error("no such process"), { code: "ESRCH" });
    }
    if (path === "/proc/1/stat") {
      return "1 (systemd) S 0 1 1 0 -1 0 0 0 0 0";
    }
    return enoent();
  });
  expect(() => acquireLinuxChildSubreaper()).toThrow("no such process");
});
