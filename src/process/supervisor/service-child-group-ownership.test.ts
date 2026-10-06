import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
const { census, definitelyDead, directory, readStat, darwinCommand } = vi.hoisted(() => ({
  census: vi.fn(),
  definitelyDead: vi.fn(),
  directory: vi.fn(),
  readStat: vi.fn(),
  darwinCommand: vi.fn(),
}));
vi.mock("node:child_process", () => ({ spawnSync: census }));
vi.mock("node:fs", () => ({ readdirSync: directory, readFileSync: readStat }));
vi.mock("../../shared/pid-alive.js", () => ({ isPidDefinitelyDead: definitelyDead }));
import {
  hasLiveOwnedProcessGroupMembers,
  readProcessGroupMembers,
} from "./service-child-group-ownership.js";

const owner = process.pid;
const getuidDescriptor = Object.getOwnPropertyDescriptor(process, "getuid");
let rows: Map<number, string | Error>;
let commands: Map<number, string | Error>;
let identities: Map<number, string | Error>;
function stat(pid: number, group: number, state = "S", name = "worker", ppid = 1) {
  return `${pid} (${name}) ${state} ${ppid} ${group} 0 0`;
}

beforeEach(() => {
  Object.defineProperty(process, "getuid", { configurable: true, value: () => 1000 });
  census.mockReset().mockReturnValue({ error: new Error("ps is unavailable") });
  definitelyDead.mockReset().mockReturnValue(false);
  darwinCommand.mockReset();
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
  if (getuidDescriptor) {
    Object.defineProperty(process, "getuid", getuidDescriptor);
  } else {
    Reflect.deleteProperty(process, "getuid");
  }
});

const foreignPid = owner + 1;
const gone = Object.assign(new Error("gone"), { code: "ENOENT" });
const denied = Object.assign(new Error("denied"), { code: "EACCES" });
it.each([
  [
    "uninterruptible member",
    foreignPid,
    stat(foreignPid, owner, "D", "worker ) (with\nname"),
    true,
    false,
  ],
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

it.each([
  ["live", { status: 0, stdout: `${owner} ${owner} S\n${owner + 2} ${owner} D\n` }, true],
  ["zombie", { status: 0, stdout: `${owner} ${owner} S\n${owner + 2} ${owner} Z+\n` }, false],
  ["ps failure", { status: 1, stdout: "" }, undefined],
  ["malformed census", { status: 0, stdout: "malformed census" }, undefined],
  ["missing owner", { status: 0, stdout: "" }, undefined],
  ["wrong group", { status: 0, stdout: `${owner} ${owner + 1} S\n` }, undefined],
  [
    "inspector only",
    {
      status: 0,
      stdout: `${owner} ${owner} S\n${owner + 1} ${owner} R\n${owner + 2} ${owner + 2} S\n`,
    },
    false,
  ],
  [
    "inspector and member",
    {
      status: 0,
      stdout: `${owner} ${owner} S\n${owner + 1} ${owner} R\n${owner + 2} ${owner} S\n`,
    },
    true,
  ],
] as const)(
  "observes Darwin ownership excluding only the inspector: %s",
  (_name, result, expected) => {
    mockProcessPlatform("darwin");
    census.mockReturnValue({ pid: owner + 1, ...result });
    expect(hasLiveOwnedProcessGroupMembers()).toBe(expected);
    expect(directory).not.toHaveBeenCalled();
    expect(readStat).not.toHaveBeenCalled();
  },
);

it("preserves Linux command argument boundaries and process ancestry in command mode", () => {
  const argv = ["node", "/app with spaces/openclaw.mjs", "doctor", "--profile", "two words"];
  rows.set(owner, stat(owner, owner + 1, "S", "worker ) (with\nname", owner + 2));
  commands.set(owner, `${argv.join("\0")}\0`);
  expect([...readProcessGroupMembers(1_000, { readDarwinCommand: darwinCommand })]).toEqual([
    { pid: owner, pgid: owner + 1, state: "S", command: { ppid: owner + 2, argv } },
  ]);
});

it("joins Darwin numeric ancestry to exact native command facts", () => {
  mockProcessPlatform("darwin");
  const argv = ["node", "/app with spaces/openclaw.mjs", "doctor"];
  const foreign = { argvUnavailable: true, executable: "/sbin/launchd", uid: 0 };
  census.mockReturnValue({
    pid: owner + 3,
    status: 0,
    stdout: `${owner} ${owner} S 1 501\n1 1 S 0 0\n2 2 S 0 -2\n${owner + 1} ${owner} S 1 501\n${owner + 3} ${owner} R ${owner} 501\n`,
  });
  darwinCommand.mockImplementation((pid: number, uid: number) =>
    pid === owner
      ? { argv }
      : pid === 1
        ? foreign
        : pid === 2
          ? { argvUnavailable: true, uid }
          : undefined,
  );
  expect([...readProcessGroupMembers(1_000, { readDarwinCommand: darwinCommand })]).toEqual([
    { pid: owner, pgid: owner, state: "S", command: { ppid: 1, argv, uid: 501 } },
    { pid: 1, pgid: 1, state: "S", command: { ppid: 0, ...foreign } },
    {
      pid: 2,
      pgid: 2,
      state: "S",
      command: { ppid: 0, uid: 4_294_967_294, argvUnavailable: true },
    },
  ]);
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
    const inspect = () => [...readProcessGroupMembers(1_000, { readDarwinCommand: darwinCommand })];
    if (uid === 2000) {
      expect(inspect()).toMatchObject([{ command: { ppid: 1, argvUnavailable: true, uid } }]);
    } else {
      expect(inspect).toThrow(`Could not classify PID ${owner}`);
    }
  },
);

it("does not turn native Darwin inspection failures into an empty census", () => {
  mockProcessPlatform("darwin");
  census.mockReturnValue({ status: 0, stdout: `${owner} ${owner} S 1 501\n` });
  darwinCommand.mockImplementation(() => {
    throw new Error("native process inspection unavailable");
  });
  expect(() => [...readProcessGroupMembers(1_000, { readDarwinCommand: darwinCommand })]).toThrow(
    "native process inspection unavailable",
  );
});
