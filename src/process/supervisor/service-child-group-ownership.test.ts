import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
const { census, definitelyDead, directory, readStat, darwinCommand, nativeDarwinCensus } =
  vi.hoisted(() => ({
    census: vi.fn(),
    nativeDarwinCensus: vi.fn(),
    definitelyDead: vi.fn(),
    directory: vi.fn(),
    readStat: vi.fn(),
    darwinCommand: vi.fn(),
  }));
vi.mock("../darwin-process-inspection.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../darwin-process-inspection.js")>()),
  readDarwinProcessCensus: nativeDarwinCensus,
}));
vi.mock("node:child_process", () => ({ spawnSync: census, execFile: vi.fn() }));
vi.mock("node:fs", () => ({ readdirSync: directory, readFileSync: readStat }));
vi.mock("../../shared/pid-alive.js", () => ({ isPidDefinitelyDead: definitelyDead }));
import {
  hasLiveOwnedProcessGroupMembers,
  readProcessGroupMembers,
} from "./service-child-group-ownership.js";

const owner = process.pid;
const bunDescriptor = Object.getOwnPropertyDescriptor(process.versions, "bun");
const getuidDescriptor = Object.getOwnPropertyDescriptor(process, "getuid");
let rows: Map<number, string | Error>;
let commands: Map<number, string | Error>;
let identities: Map<number, string | Error>;
function stat(pid: number, group: number, state = "S", name = "worker", ppid = 1) {
  return `${pid} (${name}) ${state} ${ppid} ${group} 0 0`;
}
const inspect = () => [...readProcessGroupMembers(1_000, { readDarwinCommand: darwinCommand })];
function darwinCensus(
  members: Array<{
    pid: number;
    pgid: number;
    ppid?: number;
    state: string;
    owner?: "same" | "different" | "unknown";
  }>,
) {
  mockProcessPlatform("darwin");
  nativeDarwinCensus.mockReturnValue(members);
}

beforeEach(() => {
  Object.defineProperty(process.versions, "bun", { configurable: true, value: undefined });
  Object.defineProperty(process, "getuid", { configurable: true, value: () => 1000 });
  census.mockReset().mockReturnValue({ error: new Error("ps is unavailable") });
  definitelyDead.mockReset().mockReturnValue(false);
  darwinCommand.mockReset();
  nativeDarwinCensus.mockReset().mockReturnValue([]);
  rows = new Map([[owner, stat(owner, owner)]]);
  commands = new Map([[owner, "openclaw-doctor\0"]]);
  identities = new Map();
  directory.mockReset().mockImplementation(() => ["self", ...Array.from(rows.keys(), String)]);
  readStat.mockReset().mockImplementation((file: string) => {
    const match = /^\/proc\/(\d+)\/(stat|cmdline|status)$/.exec(file);
    const source =
      match?.[2] === "cmdline" ? commands : match?.[2] === "status" ? identities : rows;
    const value = match ? source.get(Number(match[1])) : undefined;
    if (value === undefined || value instanceof Error) {
      throw value ?? new Error(`Unexpected fixture read: ${file}`);
    }
    return value;
  });
  mockProcessPlatform("linux");
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const [target, key, descriptor] of [
    [process.versions, "bun", bunDescriptor],
    [process, "getuid", getuidDescriptor],
  ] as const) {
    if (descriptor) {
      Object.defineProperty(target, key, descriptor);
    } else {
      Reflect.deleteProperty(target, key);
    }
  }
});

const foreignPid = owner + 1;
const unusualName = "worker ) (with\nname";
const gone = Object.assign(new Error("gone"), { code: "ENOENT" });
const denied = Object.assign(new Error("denied"), { code: "EACCES" });
it.each([
  ["uninterruptible member", foreignPid, stat(foreignPid, owner, "D", unusualName), true, false],
  ["live zombie threads", foreignPid, stat(foreignPid, owner, "Z"), true, false],
  ["dead zombie", foreignPid, stat(foreignPid, owner, "Z"), false, true],
  ["foreign group", foreignPid, stat(foreignPid, foreignPid), false, false],
  ["disappearing PID", foreignPid, gone, false, false],
  ["missing owner", owner, undefined, undefined, false],
  ["wrong group", owner, stat(owner, foreignPid), undefined, false],
  ["malformed stat", foreignPid, "invalid stat", undefined, false],
  ["inaccessible row", foreignPid, denied, undefined, false],
  ["inaccessible directory", owner, null, undefined, false],
] as const)("observes Linux ownership without ps: %s", (name, pid, row, expected, dead) => {
  if (row === undefined) {
    rows.delete(pid);
  } else if (row === null) {
    directory.mockImplementation(() => {
      throw denied;
    });
  } else {
    rows.set(pid, row);
  }
  definitelyDead.mockReturnValue(dead);
  expect(hasLiveOwnedProcessGroupMembers()).toBe(expected);
  expect(census).not.toHaveBeenCalled();
  if (name.includes("zombie")) {
    expect(definitelyDead).toHaveBeenCalledExactlyOnceWith(foreignPid);
  }
});

it("does not report an empty Linux group after its existing census budget expires", () => {
  let now = 0;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  readStat.mockImplementation(() => {
    now = 51;
    return stat(owner, owner);
  });
  expect(hasLiveOwnedProcessGroupMembers(50)).toBeUndefined();
  expect(census).not.toHaveBeenCalled();
});

const ownerRow = { pid: owner, pgid: owner, state: "S" };
it.each([
  ["live", [ownerRow, { pid: owner + 2, pgid: owner, state: "D" }], true],
  ["zombie with flags", [ownerRow, { pid: owner + 2, pgid: owner, state: "Z+" }], false],
  ["enumeration failure", new Error("enumeration failed"), undefined],
  ["invalid native layout", new Error("layout mismatch"), undefined],
  ["missing owner", [], undefined],
  ["wrong group", [{ ...ownerRow, pgid: owner + 1 }], undefined],
  [
    "observer only and foreign group",
    [ownerRow, { pid: owner + 2, pgid: owner + 2, state: "S" }],
    false,
  ],
  ["observer and member", [ownerRow, { pid: owner + 2, pgid: owner, state: "S" }], true],
] as const)(
  "observes Darwin ownership excluding the current observer: %s",
  (_name, members, expected) => {
    mockProcessPlatform("darwin");
    if (members instanceof Error) {
      nativeDarwinCensus.mockImplementation(() => {
        throw members;
      });
    } else {
      nativeDarwinCensus.mockReturnValue(members);
    }
    expect(hasLiveOwnedProcessGroupMembers()).toBe(expected);
    expect(directory).not.toHaveBeenCalled();
    expect(readStat).not.toHaveBeenCalled();
    expect(census).not.toHaveBeenCalled();
  },
);

it("preserves Linux command argument boundaries and process ancestry in command mode", () => {
  const argv = ["node", "/app with spaces/openclaw.mjs", "doctor", "--profile", "two words"];
  rows.set(owner, stat(owner, owner + 1, "S", unusualName, owner + 2));
  commands.set(owner, `${argv.join("\0")}\0`);
  expect(inspect()).toEqual([
    { pid: owner, pgid: owner + 1, state: "S", command: { ppid: owner + 2, argv } },
  ]);
});

it("joins Darwin ancestry and relative ownership to exact native command facts", () => {
  const argv = ["node", "/app with spaces/openclaw.mjs", "doctor"];
  const foreign = { argvUnavailable: true, executable: "/sbin/launchd", owner: "different" };
  darwinCensus([
    { pid: owner, pgid: owner, state: "S", ppid: 1, owner: "same" },
    { pid: 1, pgid: 1, state: "S", ppid: 0, owner: "different" },
    { pid: 2, pgid: 2, state: "S", ppid: 0, owner: "different" },
    { pid: owner + 1, pgid: owner, state: "S", ppid: 1, owner: "unknown" },
    { pid: owner + 3, pgid: owner, state: "R", ppid: owner, owner: "same" },
  ]);
  darwinCommand.mockImplementation((pid: number, relativeOwner: string) =>
    pid === owner
      ? { argv }
      : pid === 1
        ? foreign
        : pid === 2
          ? { argvUnavailable: true, owner: relativeOwner }
          : undefined,
  );
  expect(inspect()).toEqual([
    { pid: owner, pgid: owner, state: "S", command: { ppid: 1, argv, owner: "same" } },
    { pid: 1, pgid: 1, state: "S", command: { ppid: 0, ...foreign } },
    {
      pid: 2,
      pgid: 2,
      state: "S",
      command: { ppid: 0, owner: "different", argvUnavailable: true },
    },
  ]);
  expect(census).not.toHaveBeenCalled();
});

it.each([
  { status: "Uid:\t1000\t0\t0\t0\n", uid: 1000 },
  { status: "Uid:\t1000\t1000\t1000\t1000\nUid:\t2000\t2000\t2000\t2000\n", uid: undefined },
  { status: "Uid:\t1000\t1000\t1000\n", uid: undefined },
  { status: "Uid:\t4294967296\t0\t0\t0\n", uid: undefined },
  { status: "Name:\tworker\n", uid: undefined },
])("retains only valid Linux ownership UID evidence ($uid)", ({ status, uid }) => {
  identities.set(owner, status);
  const [observation] = readProcessGroupMembers(1_000, { readDarwinCommand: darwinCommand });
  expect(observation?.command?.uid).toBe(uid);
  expect(observation?.command).toMatchObject({ argv: ["openclaw-doctor"] });
});

it.each([1000, 2000, undefined])(
  "keeps denied Linux arguments uncertain unless the credential UIDs are foreign (%s)",
  (uid) => {
    if (uid !== undefined) {
      identities.set(owner, `Uid:\t${uid}\t${uid}\t${uid}\t${uid}\n`);
    }
    commands.set(owner, Object.assign(new Error("denied"), { code: "EACCES" }));
    if (uid === 2000) {
      expect(inspect()).toMatchObject([{ command: { ppid: 1, argvUnavailable: true, uid } }]);
    } else {
      expect(inspect).toThrow(`Could not classify PID ${owner}`);
    }
  },
);

it("does not turn native Darwin inspection failures into an empty census", () => {
  darwinCensus([{ pid: owner, pgid: owner, state: "S", ppid: 1, owner: "same" }]);
  darwinCommand.mockImplementation(() => {
    throw new Error("native process inspection unavailable");
  });
  expect(inspect).toThrow("native process inspection unavailable");
});

it("uses the native census in Darwin Bun when sandboxed ps cannot execute", () => {
  mockProcessPlatform("darwin");
  Object.defineProperty(process.versions, "bun", { configurable: true, value: "1.4.3" });
  nativeDarwinCensus.mockReturnValue([
    { pid: owner, ppid: 1, pgid: owner, state: "R", owner: "same" },
    { pid: owner + 1, ppid: owner, pgid: owner, state: "Z", owner: "same" },
  ]);
  expect(hasLiveOwnedProcessGroupMembers()).toBe(false);
  darwinCommand.mockReturnValue({ argv: ["openclaw", "doctor"] });
  expect(inspect()).toEqual([
    {
      pid: owner,
      pgid: owner,
      state: "R",
      command: { ppid: 1, argv: ["openclaw", "doctor"], owner: "same" },
    },
    {
      pid: owner + 1,
      pgid: owner,
      state: "Z",
      command: { ppid: owner, argv: [], owner: "same" },
    },
  ]);
  expect(census).not.toHaveBeenCalled();
  expect(darwinCommand).toHaveBeenCalledExactlyOnceWith(owner, "same");
});

it("does not request Node Darwin arguments for kernel tasks or zombie states with flags", () => {
  darwinCensus([
    { pid: 0, pgid: 0, state: "R", ppid: 0, owner: "different" },
    { pid: owner, pgid: owner, state: "Z+", ppid: 1, owner: "same" },
  ]);
  expect(inspect()).toEqual([
    { pid: 0, pgid: 0, state: "R", command: { ppid: 0, argv: [], owner: "different" } },
    { pid: owner, pgid: owner, state: "Z+", command: { ppid: 1, argv: [], owner: "same" } },
  ]);
  expect(darwinCommand).not.toHaveBeenCalled();
});
