import { afterEach, beforeEach, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  list: vi.fn(),
  info: vi.fn(),
  errno: vi.fn(),
  close: vi.fn(),
}));
vi.mock("node:module", () => ({
  createRequire: () => () => ({
    dlopen: () => ({
      symbols: {
        proc_listpids: native.list,
        proc_pidinfo: native.info,
        __error: () => 1,
      },
      close: native.close,
    }),
    read: { i32: native.errno },
  }),
}));
import { readDarwinBunProcessCensus } from "./darwin-bun-process-census.js";

let pids: number[];
beforeEach(() => {
  pids = [123, 456];
  native.close.mockReset();
  native.errno.mockReset().mockReturnValue(3);
  native.list.mockReset().mockImplementation((_type, _info, buffer: Buffer | null) => {
    if (buffer) {
      pids.forEach((pid, index) => buffer.writeInt32LE(pid, index * 4));
    }
    return pids.length * 4;
  });
  native.info.mockReset().mockImplementation((pid, flavor, _arg, buffer: Buffer) => {
    const full = flavor === 3;
    buffer.writeUInt32LE(pid, full ? 12 : 0);
    buffer.writeUInt32LE(12, full ? 16 : 4);
    buffer.writeUInt32LE(123, full ? 100 : 8);
    buffer.writeUInt32LE(pid === 123 ? 2 : 5, full ? 4 : 12);
    buffer.writeUInt32LE(501, full ? 20 : 36);
    if (full) {
      buffer.writeBigUInt64LE(123456n, 120);
    }
    return buffer.length;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

it("reads native Darwin group membership, zombie state, ancestry, and effective UID", () => {
  expect([...readDarwinBunProcessCensus(1000)]).toEqual([
    { pid: 123, ppid: 12, pgid: 123, state: "R", uid: 501 },
    { pid: 456, ppid: 12, pgid: 123, state: "Z", uid: 501 },
  ]);
  expect(native.close).toHaveBeenCalledOnce();
});

it("repeats a filled PID buffer instead of accepting a truncated census", () => {
  native.list.mockImplementationOnce(() => 4);
  native.list.mockImplementationOnce((_type, _info, buffer: Buffer) => buffer.length);
  expect([...readDarwinBunProcessCensus(1000)]).toHaveLength(2);
  expect(native.list).toHaveBeenCalledTimes(3);
});

it("ignores only processes proven to disappear during native inspection", () => {
  native.info.mockReturnValueOnce(0);
  expect([...readDarwinBunProcessCensus(1000)]).toEqual([
    { pid: 456, ppid: 12, pgid: 123, state: "Z", uid: 501 },
  ]);
});

it.each([
  ["denial", 0, 1],
  ["partial structure", 32, 0],
])("keeps %s distinct from an empty group", (_name, size, errno) => {
  native.info.mockReturnValueOnce(size);
  native.errno.mockReturnValue(errno);
  expect(() => [...readDarwinBunProcessCensus(1000)]).toThrow("Could not classify PID 123");
  expect(native.close).toHaveBeenCalledOnce();
});

it.each(["PID", "state"])("rejects malformed native %s facts", (field) => {
  const inspect = native.info.getMockImplementation()!;
  native.info.mockImplementation((...args) => {
    inspect(...args);
    args[3].writeUInt32LE(0, field === "PID" ? 0 : 12);
    return args[3].length;
  });
  expect(() => [...readDarwinBunProcessCensus(1000)]).toThrow("Could not classify PID 123");
});

it("does not publish a census after native observation consumes its deadline", () => {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  native.info.mockImplementationOnce((_pid, _flavor, _arg, buffer: Buffer) => {
    now = 1000;
    buffer.writeUInt32LE(123, 0);
    buffer.writeUInt32LE(2, 12);
    return buffer.length;
  });
  expect(() => [...readDarwinBunProcessCensus(1000)]).toThrow("exceeded its deadline");
  expect(native.close).toHaveBeenCalledOnce();
});

it("reads selected process identities without enumerating unrelated PIDs", () => {
  expect([...readDarwinBunProcessCensus(1000, [456], true)]).toEqual([
    { pid: 456, ppid: 12, pgid: 123, state: "Z", uid: 501, startedAt: "Fri Jan 2 10:17:36 1970" },
  ]);
  expect(native.list).not.toHaveBeenCalled();
  expect(native.info).toHaveBeenCalledWith(456, 3, 0, expect.any(Buffer), 136);
});
