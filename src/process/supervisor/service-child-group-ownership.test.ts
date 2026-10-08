import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
const {
  census,
  definitelyDead,
  directory,
  readStat,
  darwinCommand,
  openProc,
  readProc,
  closeProc,
} = vi.hoisted(() => ({
  census: vi.fn(),
  definitelyDead: vi.fn(),
  directory: vi.fn(),
  readStat: vi.fn(),
  darwinCommand: vi.fn(),
  openProc: vi.fn(),
  readProc: vi.fn(),
  closeProc: vi.fn(),
}));
vi.mock("node:child_process", () => ({ spawnSync: census }));
vi.mock("node:fs", async (importOriginal) => {
  const { constants } = await importOriginal<typeof import("node:fs")>();
  return {
    constants,
    readdirSync: directory,
    readFileSync: readStat,
    openSync: openProc,
    readSync: readProc,
    closeSync: closeProc,
  };
});
vi.mock("../../shared/pid-alive.js", () => ({ isPidDefinitelyDead: definitelyDead }));
import {
  hasLiveOwnedProcessGroupMembers,
  linuxProcessGenerationMatches,
  readLinuxProcessCommandMetadata,
  readLinuxProcessGeneration,
  readProcessGroupMembers,
} from "./service-child-group-ownership.js";

const owner = process.pid;
const getuidDescriptor = Object.getOwnPropertyDescriptor(process, "getuid");
let rows: Map<number, string | Error>;
let commands: Map<number, string | Error>;
let identities: Map<number, string | Error>;
let environments: Map<number, string | Error>;
function stat(pid: number, group: number, state = "S", name = "worker", ppid = 1) {
  return `${pid} (${name}) ${state} ${ppid} ${group} 0 0`;
}

beforeEach(() => {
  Object.defineProperty(process, "getuid", { configurable: true, value: () => 1000 });
  census.mockReset().mockReturnValue({ error: new Error("ps is unavailable") });
  definitelyDead.mockReset().mockReturnValue(false);
  darwinCommand.mockReset();
  const opened = new Map<number, { bytes: Buffer; offset: number }>();
  let nextFd = 20;
  openProc.mockReset().mockImplementation((file: string) => {
    const fd = nextFd++;
    opened.set(fd, { bytes: Buffer.from(readStat(file)), offset: 0 });
    return fd;
  });
  readProc
    .mockReset()
    .mockImplementation((fd: number, buffer: Buffer, offset: number, length: number) => {
      const file = opened.get(fd)!;
      const count = file.bytes.copy(buffer, offset, file.offset, file.offset + length);
      file.offset += count;
      return count;
    });
  closeProc.mockReset().mockImplementation((fd: number) => opened.delete(fd));
  rows = new Map([[owner, stat(owner, owner)]]);
  commands = new Map([[owner, "openclaw-doctor\0"]]);
  identities = new Map();
  environments = new Map();
  directory.mockReset().mockImplementation(() => ["self", ...Array.from(rows.keys(), String)]);
  readStat.mockReset().mockImplementation((file: string) => {
    const match = /^\/proc\/(\d+)\/(stat|cmdline|status|environ)$/.exec(file);
    const source =
      match?.[2] === "cmdline"
        ? commands
        : match?.[2] === "status"
          ? identities
          : match?.[2] === "environ"
            ? environments
            : rows;
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

function generationStat(pid: number, startTicks = "42", ppid = 1, state = "S") {
  const fields = [state, String(ppid), String(owner), ...Array<string>(16).fill("0"), startTicks];
  return `${pid} (worker ) (with\nname) ${fields.join(" ")}\n`;
}

const generationStatus = "Uid:\t1000\t1000\t1000\t1000\nGid:\t1000\t1000\t102\t1000\n";

it("pairs bounded native command metadata without requiring nonruntime environment access", () => {
  rows.set(owner, generationStat(owner));
  identities.set(owner, generationStatus);
  const generation = readLinuxProcessGeneration(owner)!;
  expect(readLinuxProcessCommandMetadata(owner, generation, false, Date.now() + 1000)).toEqual({
    argv: ["openclaw-doctor"],
    uid: 1000,
    generation,
  });
  expect(openProc.mock.calls.some(([file]) => String(file).endsWith("/environ"))).toBe(false);
  expect(closeProc).toHaveBeenCalledTimes(openProc.mock.calls.length);
});

it.each(["marker", "duplicate", "oversize", "birth-drift", "expired"])(
  "bounds and pairs runtime command metadata with %s evidence",
  (kind) => {
    rows.set(owner, generationStat(owner));
    identities.set(owner, generationStatus);
    environments.set(owner, "OPENCLAW_SERVICE_MARKER=openclaw\0");
    const generation = readLinuxProcessGeneration(owner)!;
    if (kind === "duplicate") {
      environments.set(owner, "OPENCLAW_SERVICE_MARKER=openclaw\0OPENCLAW_SERVICE_MARKER=other\0");
    } else if (kind === "oversize") {
      commands.set(owner, "x".repeat(16_385));
    } else if (kind === "birth-drift") {
      const read = readStat.getMockImplementation()!;
      readStat.mockImplementation((file: string) => {
        const value = read(file);
        if (file.endsWith("/cmdline")) {
          rows.set(owner, generationStat(owner, "43"));
        }
        return value;
      });
    }
    const metadata = readLinuxProcessCommandMetadata(
      owner,
      generation,
      true,
      Date.now() + (kind === "expired" ? -1 : 1000),
    );
    if (kind === "marker") {
      expect(metadata).toEqual({
        argv: ["openclaw-doctor"],
        uid: 1000,
        generation,
        serviceMarker: "openclaw",
      });
    } else {
      expect(metadata).toBeUndefined();
    }
    expect(closeProc).toHaveBeenCalledTimes(openProc.mock.calls.length);
  },
);

it("binds command arguments to observed Linux birth and all credential fields on request", () => {
  rows.set(owner, generationStat(owner));
  identities.set(owner, generationStatus);
  const [entry] = readProcessGroupMembers(1_000, {
    readDarwinCommand: darwinCommand,
    includeLinuxGeneration: true,
  });
  expect(entry?.command).toEqual({
    ppid: 1,
    argv: ["openclaw-doctor"],
    uid: 1000,
    generation: {
      startTicks: "42",
      ppid: 1,
      uids: [1000, 1000, 1000, 1000],
      gids: [1000, 1000, 102, 1000],
    },
  });
  expect(openProc).toHaveBeenCalledTimes(4);
  expect(closeProc).toHaveBeenCalledTimes(4);
});

it.each([0, -1, 1.5, 0x8000_0000, Number.NaN])(
  "rejects invalid generation PID %s before proc access",
  (pid) => {
    expect(readLinuxProcessGeneration(pid)).toBeUndefined();
    expect(openProc).not.toHaveBeenCalled();
  },
);

it.each([
  ["oversized stat", "x".repeat(16_385), generationStatus],
  ["oversized status", generationStat(owner), "x".repeat(16_385)],
  ["wrong pid", generationStat(owner + 1), generationStatus],
  ["invalid start", generationStat(owner, "1.5"), generationStatus],
  ["overflow start", generationStat(owner, "18446744073709551616"), generationStatus],
  ["missing gids", generationStat(owner), "Uid:\t1000\t1000\t1000\t1000\n"],
  ["duplicate uids", generationStat(owner), `${generationStatus}Uid:\t1000\t1000\t1000\t1000\n`],
  ["overflow uid", generationStat(owner), generationStatus.replace("1000", "4294967296")],
] as const)(
  "leaves %s generation unavailable and closes opened files",
  (_label, statText, status) => {
    rows.set(owner, statText);
    identities.set(owner, status);
    expect(readLinuxProcessGeneration(owner)).toBeUndefined();
    expect(closeProc).toHaveBeenCalledTimes(openProc.mock.calls.length);
  },
);

it.each(["birth", "parent", "uid", "gid", "gone"] as const)(
  "does not attach a generation after %s drift",
  (kind) => {
    rows.set(owner, generationStat(owner));
    identities.set(owner, generationStatus);
    const read = readStat.getMockImplementation()!;
    let commandRead = false;
    readStat.mockImplementation((file: string) => {
      if (file.endsWith("/cmdline")) {
        commandRead = true;
      } else if (commandRead) {
        if (kind === "gone") {
          throw gone;
        }
        if (file.endsWith("/stat")) {
          return generationStat(owner, kind === "birth" ? "43" : "42", kind === "parent" ? 2 : 1);
        }
        if (file.endsWith("/status")) {
          return generationStatus.replace(
            kind === "uid" ? "Uid:\t1000" : "Gid:\t1000",
            kind === "uid" ? "Uid:\t2000" : kind === "gid" ? "Gid:\t2000" : "Gid:\t1000",
          );
        }
      }
      return read(file);
    });
    expect(() => [
      ...readProcessGroupMembers(1_000, {
        readDarwinCommand: darwinCommand,
        includeLinuxGeneration: true,
      }),
    ]).toThrow("process generation changed during command inspection");
  },
);

it.each(["same-parent PID reuse", "separately selected UID drift"])(
  "refuses %s before publishing command evidence",
  (kind) => {
    rows.set(owner, generationStat(owner));
    identities.set(owner, generationStatus);
    const read = readStat.getMockImplementation()!;
    let statReads = 0;
    let statusReads = 0;
    readStat.mockImplementation((file: string) => {
      if (file.endsWith("/stat") && ++statReads === 1 && kind === "same-parent PID reuse") {
        return generationStat(owner, "41");
      }
      if (
        file.endsWith("/status") &&
        ++statusReads === 2 &&
        kind === "separately selected UID drift"
      ) {
        return generationStatus.replaceAll("1000", "2000");
      }
      return read(file);
    });
    expect(() => [
      ...readProcessGroupMembers(1_000, {
        readDarwinCommand: darwinCommand,
        includeLinuxGeneration: true,
      }),
    ]).toThrow("process generation changed during command inspection");
  },
);

it("does not confuse ordinary process-state changes with generation drift", () => {
  rows.set(owner, generationStat(owner));
  identities.set(owner, generationStatus);
  const before = readLinuxProcessGeneration(owner);
  rows.set(owner, generationStat(owner, "42", 1, "R"));
  expect(linuxProcessGenerationMatches(before, readLinuxProcessGeneration(owner))).toBe(true);
  expect(linuxProcessGenerationMatches(before, undefined)).toBe(false);
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
