import { ProcSafeError } from "@openclaw/proc-safe/errors";
import type { ProcessSnapshot } from "@openclaw/proc-safe/inspect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ census: vi.fn(), command: vi.fn(), identity: vi.fn() }));
vi.mock("@openclaw/proc-safe/identity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openclaw/proc-safe/identity")>()),
  readProcessIdentity: native.identity,
}));
vi.mock("@openclaw/proc-safe/inspect", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openclaw/proc-safe/inspect")>()),
  listProcesses: native.census,
  readProcessCommand: native.command,
}));
import {
  readDarwinProcessCensus,
  readDarwinProcessSnapshot,
  readDarwinProcessTree,
  readDarwinProcessCommandLine,
} from "./darwin-process-inspection.js";

const row: ProcessSnapshot = {
  pid: 123,
  parentPid: 1,
  processGroupId: 123,
  state: "sleeping",
  owner: "same",
  identity: {
    pid: 123,
    parentPid: 1,
    startTimeMicros: 123456_999999,
    startTimeResolutionMicros: 1,
    exited: false,
  },
};
const snapshot = (pids?: readonly number[]) =>
  readDarwinProcessSnapshot(performance.now() + 1000, pids);
const tree = (roots: readonly number[]) => readDarwinProcessTree(performance.now() + 1000, roots);
const commandLine = () => readDarwinProcessCommandLine(123, performance.now() + 1000);
function fail(mock: typeof native.census, code: ConstructorParameters<typeof ProcSafeError>[0]) {
  mock.mockImplementation(() => {
    throw new ProcSafeError(code, "unavailable");
  });
}
beforeEach(() => {
  native.census.mockReset().mockReturnValue([row]);
  native.command.mockReset();
  native.identity.mockReset().mockReturnValue(row.identity);
});
afterEach(() => vi.restoreAllMocks());

it("omits incomplete topology only after proving that the PID disappeared", async () => {
  native.census.mockReturnValue([{ pid: 123, owner: "unknown" }]);
  native.identity.mockReturnValue(null);
  expect(await snapshot()).toEqual([]);
  fail(native.identity, "access-denied");
  await expect(snapshot()).rejects.toMatchObject({ reason: "permission" });
});

it("maps census topology without requiring a birth identity", () => {
  native.census.mockReturnValue([
    { ...row, state: "zombie", owner: "different", identity: undefined },
  ]);
  expect([...readDarwinProcessCensus(1000)]).toEqual([
    { pid: 123, ppid: 1, pgid: 123, state: "Z", owner: "different" },
  ]);
});

it.each(["parentPid", "processGroupId", "state"])("rejects unavailable %s topology", (field) => {
  native.census.mockReturnValue([{ ...row, [field]: undefined }]);
  expect(() => [...readDarwinProcessCensus(1000)]).toThrow(
    expect.objectContaining({ reason: "unavailable" }),
  );
});

it.each([
  ["timeout", "deadline", "ETIMEDOUT"],
  ["access-denied", "permission", "EPERM"],
  ["incomplete", "unavailable", "EIO"],
] as const)("preserves %s failure semantics", async (code, reason, mappedCode) => {
  fail(native.census, code);
  await expect(snapshot()).rejects.toMatchObject({ reason, code: mappedCode });
});

it("rejects observations completed after the caller's deadline", async () => {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  native.census.mockImplementation(() => {
    now = 1000;
    return [row];
  });
  await expect(readDarwinProcessSnapshot(1000)).rejects.toMatchObject({
    reason: "deadline",
    code: "ETIMEDOUT",
  });
});

it("does not confuse unreadable relevant identity with a vanished process", async () => {
  native.census.mockReturnValue([{ ...row, identity: undefined }]);
  await expect(snapshot([123])).rejects.toMatchObject({ reason: "permission" });
  native.census.mockReturnValue([]);
  expect(await snapshot([123])).toEqual([]);
  expect(await snapshot([])).toEqual([]);
});

it("requires identities only for the requested lineage and observer", async () => {
  const child = { ...row, pid: 456, parentPid: 123 };
  const observer = { ...row, pid: process.pid };
  native.census.mockReturnValue([
    observer,
    row,
    child,
    { ...row, pid: 789, owner: "different", identity: undefined },
  ]);
  expect((await tree([123])).map(({ pid }) => pid)).toEqual([process.pid, 123, 456]);
  native.census.mockReturnValue([observer, row, { ...child, identity: undefined }]);
  await expect(tree([123])).rejects.toMatchObject({ reason: "permission" });
});

it("reads arguments without requesting environment and keeps errors distinct from absence", async () => {
  native.command.mockReturnValue({ argv: ["/opt/codex", "app-server"] });
  expect(await commandLine()).toBe("/opt/codex app-server");
  expect(native.command).toHaveBeenCalledExactlyOnceWith(123);
  native.command.mockReturnValue(null);
  expect(await commandLine()).toBe("");
  fail(native.command, "access-denied");
  await expect(commandLine()).rejects.toMatchObject({ reason: "permission" });
});

const execEio = new ProcSafeError(
  "operation-failed",
  "operation-failed: Input/output error (os error 5)",
);
const argv = { argv: ["/opt/codex", "app-server"] };
function failCommandOnce(error = execEio) {
  return native.command.mockImplementationOnce(() => {
    throw error;
  });
}

it("waits out a native argv EIO for the observed startup child", async () => {
  const [child] = await snapshot([row.pid]);
  failCommandOnce().mockReturnValue(argv);
  await expect(readDarwinProcessCommandLine(child!, performance.now() + 1000)).resolves.toBe(
    "/opt/codex app-server",
  );

  native.census.mockClear();
  native.command.mockClear();
  expect(await readDarwinProcessCommandLine(child!, performance.now() + 1000)).toBe(
    "/opt/codex app-server",
  );
  expect(native.census).not.toHaveBeenCalled();
  expect(native.command).toHaveBeenCalledExactlyOnceWith(row.pid);

  failCommandOnce();
  await expect(commandLine()).rejects.toMatchObject({ cause: execEio });
});

it("refuses a child replaced in the same second during the successful retry", async () => {
  const [child] = await snapshot([row.pid]);
  failCommandOnce().mockReturnValue(argv);
  native.census.mockReturnValueOnce([row]).mockReturnValue([
    {
      ...row,
      identity: { ...row.identity!, startTimeMicros: row.identity!.startTimeMicros - 1 },
    },
  ]);
  await expect(
    readDarwinProcessCommandLine(child!, performance.now() + 1000),
  ).rejects.toMatchObject({
    reason: "unavailable",
  });
});

it.each([
  { name: "gone", rows: [] },
  { name: "different parent", rows: [{ ...row, parentPid: row.parentPid! + 1 }] },
  { name: "different group", rows: [{ ...row, processGroupId: row.processGroupId! + 1 }] },
  { name: "zombie", rows: [{ ...row, state: "zombie" }] },
])("refuses the $name child before retrying its command", async ({ rows }) => {
  const [child] = await snapshot([row.pid]);
  failCommandOnce().mockReturnValue(argv);
  native.census.mockReturnValue(rows);
  await expect(
    readDarwinProcessCommandLine(child!, performance.now() + 1000),
  ).rejects.toMatchObject({
    reason: "unavailable",
  });
  expect(native.command).toHaveBeenCalledOnce();
});

it("stops persistent startup EIO at the original deadline", async () => {
  const [child] = await snapshot([row.pid]);
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  native.command.mockImplementation(() => {
    now += 6;
    throw execEio;
  });
  await expect(readDarwinProcessCommandLine(child!, 10)).rejects.toMatchObject({
    reason: "deadline",
  });
});

it.each([
  new ProcSafeError("access-denied", "access-denied: permission denied"),
  new ProcSafeError("operation-failed", "operation-failed: Invalid argument (os error 22)"),
])("keeps other native command failures terminal at startup: %s", async (error) => {
  const [child] = await snapshot([row.pid]);
  failCommandOnce(error).mockReturnValue(argv);
  await expect(
    readDarwinProcessCommandLine(child!, performance.now() + 1000),
  ).rejects.toMatchObject({ cause: error });
});
