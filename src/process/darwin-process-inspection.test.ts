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
const mapped = {
  pid: 123,
  ppid: 1,
  pgid: 123,
  state: "S",
  owner: "same",
  startedAt: "Fri Jan 2 10:17:36 1970",
};
beforeEach(() => {
  native.census.mockReset().mockReturnValue([row]);
  native.command.mockReset();
  native.identity.mockReset().mockReturnValue(row.identity);
});
afterEach(() => vi.restoreAllMocks());

it("preserves persisted UTC lstart identities and selected PID queries", async () => {
  expect(await readDarwinProcessSnapshot(performance.now() + 1000, [123])).toEqual([mapped]);
  expect(native.census).toHaveBeenCalledExactlyOnceWith({
    timeoutMs: expect.any(Number),
    pids: [123],
  });
});

it("omits incomplete topology only after proving that the PID disappeared", async () => {
  native.census.mockReturnValue([{ pid: 123, owner: "unknown" }]);
  native.identity.mockReturnValue(null);
  expect(await readDarwinProcessSnapshot(performance.now() + 1000)).toEqual([]);
  expect(native.identity).toHaveBeenCalledExactlyOnceWith(123);
  native.identity.mockImplementation(() => {
    throw new ProcSafeError("access-denied", "denied");
  });
  await expect(readDarwinProcessSnapshot(performance.now() + 1000)).rejects.toMatchObject({
    reason: "permission",
  });
});

it.each([
  ["running", "R"],
  ["sleeping", "S"],
  ["stopped", "T"],
  ["zombie", "Z"],
  ["idle", "I"],
  ["unknown", "?"],
] as const)("maps native %s state for existing process consumers", (state, expected) => {
  native.census.mockReturnValue([{ ...row, state, owner: "different", identity: undefined }]);
  expect([...readDarwinProcessCensus(1000)]).toEqual([
    { pid: 123, ppid: 1, pgid: 123, state: expected, owner: "different" },
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
  ["helper-unavailable", "unavailable", "EIO"],
] as const)("preserves %s failure semantics", async (code, reason, mappedCode) => {
  native.census.mockImplementation(() => {
    throw new ProcSafeError(code, "unavailable");
  });
  await expect(readDarwinProcessSnapshot(performance.now() + 1000)).rejects.toMatchObject({
    reason,
    code: mappedCode,
  });
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
  await expect(readDarwinProcessSnapshot(performance.now() + 1000, [123])).rejects.toMatchObject({
    reason: "permission",
  });
  native.census.mockReturnValue([]);
  expect(await readDarwinProcessSnapshot(performance.now() + 1000, [123])).toEqual([]);
  expect(await readDarwinProcessSnapshot(performance.now() + 1000, [])).toEqual([]);
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
  expect(await readDarwinProcessTree(performance.now() + 1000, [123])).toEqual([
    { ...mapped, pid: process.pid },
    mapped,
    { ...mapped, pid: 456, ppid: 123 },
  ]);
  native.census.mockReturnValue([observer, row, { ...child, identity: undefined }]);
  await expect(readDarwinProcessTree(performance.now() + 1000, [123])).rejects.toMatchObject({
    reason: "permission",
  });
});

it("reads arguments without requesting environment and keeps errors distinct from absence", async () => {
  native.command.mockReturnValue({ argv: ["/opt/codex", "app-server"] });
  expect(await readDarwinProcessCommandLine(123, performance.now() + 1000)).toBe(
    "/opt/codex app-server",
  );
  expect(native.command).toHaveBeenCalledExactlyOnceWith(123);
  native.command.mockReturnValue(null);
  expect(await readDarwinProcessCommandLine(123, performance.now() + 1000)).toBe("");
  native.command.mockImplementation(() => {
    throw new ProcSafeError("access-denied", "denied");
  });
  await expect(readDarwinProcessCommandLine(123, performance.now() + 1000)).rejects.toMatchObject({
    reason: "permission",
  });
});
