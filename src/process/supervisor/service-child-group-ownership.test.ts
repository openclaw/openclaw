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
let rows: Map<number, string | Error>;
let commands: Map<number, string | Error>;
function stat(pid: number, group: number, state = "S", name = "worker", ppid = 1) {
  return `${pid} (${name}) ${state} ${ppid} ${group} 0 0`;
}

beforeEach(() => {
  census.mockReset().mockReturnValue({ error: new Error("ps is unavailable") });
  definitelyDead.mockReset().mockReturnValue(false);
  darwinCommand.mockReset();
  rows = new Map([[owner, stat(owner, owner)]]);
  commands = new Map([[owner, "openclaw-doctor\0"]]);
  directory.mockReset().mockImplementation(() => ["self", ...Array.from(rows.keys(), String)]);
  readStat.mockReset().mockImplementation((file: string) => {
    const match = /^\/proc\/(\d+)\/(stat|cmdline)$/.exec(file);
    const source = match?.[2] === "cmdline" ? commands : rows;
    const value = match ? source.get(Number(match[1])) : undefined;
    if (value === undefined || value instanceof Error) {
      throw value ?? new Error(`Unexpected fixture read: ${file}`);
    }
    return value;
  });
  mockProcessPlatform("linux");
});
afterEach(() => vi.restoreAllMocks());

it("observes an uninterruptible Linux group member without ps", () => {
  rows.set(owner + 1, stat(owner + 1, owner, "D", "worker ) (with\nname"));
  expect(hasLiveOwnedProcessGroupMembers()).toBe(true);
  expect(census).not.toHaveBeenCalled();
});

it.each([false, true])("uses the shared Linux zombie/thread decision (dead=%s)", (dead) => {
  rows.set(owner + 1, stat(owner + 1, owner, "Z"));
  definitelyDead.mockReturnValue(dead);
  expect(hasLiveOwnedProcessGroupMembers()).toBe(!dead);
  expect(definitelyDead).toHaveBeenCalledExactlyOnceWith(owner + 1);
});

it("allows an observed Linux owner to retire without requiring a ps executable", () => {
  rows.set(owner + 1, stat(owner + 1, owner + 1));
  expect(hasLiveOwnedProcessGroupMembers()).toBe(false);
  expect(census).not.toHaveBeenCalled();
});

it.each(["ENOENT", "ESRCH"])(
  "tolerates a foreign PID disappearing during the census (%s)",
  (code) => {
    rows.set(owner + 1, Object.assign(new Error("gone"), { code }));
    expect(hasLiveOwnedProcessGroupMembers()).toBe(false);
  },
);

it.each([
  "missing owner",
  "wrong group",
  "malformed stat",
  "inaccessible row",
  "inaccessible directory",
])("keeps the Linux census uncertain with %s", (failure) => {
  if (failure === "missing owner") {
    rows.clear();
  }
  if (failure === "wrong group") {
    rows.set(owner, stat(owner, owner + 1));
  }
  if (failure === "malformed stat") {
    rows.set(owner + 1, "invalid stat");
  }
  if (failure === "inaccessible row") {
    rows.set(owner + 1, Object.assign(new Error("denied"), { code: "EACCES" }));
  }
  if (failure === "inaccessible directory") {
    directory.mockImplementation(() => {
      throw new Error("denied");
    });
  }
  expect(hasLiveOwnedProcessGroupMembers()).toBeUndefined();
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
  { state: "D", expected: true },
  { state: "Z+", expected: false },
])("preserves Darwin ps state $state as live=$expected", ({ state, expected }) => {
  mockProcessPlatform("darwin");
  census.mockReturnValue({
    status: 0,
    stdout: `${owner} ${owner} S\n${owner + 1} ${owner} ${state}\n`,
  });
  expect(hasLiveOwnedProcessGroupMembers()).toBe(expected);
  expect(directory).not.toHaveBeenCalled();
  expect(readStat).not.toHaveBeenCalled();
});

it.each([
  { failure: "ps failure", result: { status: 1, stdout: "" } },
  { failure: "malformed census", result: { status: 0, stdout: "malformed census" } },
  { failure: "missing owner", result: { status: 0, stdout: "" } },
  { failure: "wrong process group", result: { status: 0, stdout: `${owner} ${owner + 1} S\n` } },
])("keeps failed Darwin ownership uncertain ($failure)", ({ result }) => {
  mockProcessPlatform("darwin");
  census.mockReturnValue(result);
  expect(hasLiveOwnedProcessGroupMembers()).toBeUndefined();
});

it.each([false, true])("excludes only Darwin's exact inspector PID (other member=%s)", (other) => {
  mockProcessPlatform("darwin");
  census.mockReturnValue({
    pid: owner + 1,
    status: 0,
    stdout: `${owner} ${owner} S\n${owner + 1} ${owner} R\n${owner + 2} ${other ? owner : owner + 2} S\n`,
  });
  expect(hasLiveOwnedProcessGroupMembers()).toBe(other);
});

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
    stdout: `${owner} ${owner} S 1 501\n1 1 S 0 0\n${owner + 1} ${owner} S 1 501\n${owner + 3} ${owner} R ${owner} 501\n`,
  });
  darwinCommand.mockImplementation((pid: number) =>
    pid === owner ? { argv } : pid === 1 ? foreign : undefined,
  );
  expect([...readProcessGroupMembers(1_000, { readDarwinCommand: darwinCommand })]).toEqual([
    { pid: owner, pgid: owner, state: "S", command: { ppid: 1, argv } },
    { pid: 1, pgid: 1, state: "S", command: { ppid: 0, ...foreign } },
  ]);
});

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

it("preserves Darwin's nobody ownership when ps renders the unsigned UID as -2", () => {
  mockProcessPlatform("darwin");
  census.mockReturnValue({ status: 0, stdout: `${owner} ${owner} S 1 -2\n` });
  darwinCommand.mockImplementation((_pid: number, uid: number) => ({
    argvUnavailable: true,
    executable: "/usr/libexec/native-service",
    uid,
  }));
  expect([...readProcessGroupMembers(1_000, { readDarwinCommand: darwinCommand })]).toMatchObject([
    { command: { ppid: 1, uid: 4_294_967_294, argvUnavailable: true } },
  ]);
});
