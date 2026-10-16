import { execFile, ChildProcess } from "node:child_process";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ census: vi.fn(), command: vi.fn() }));
vi.mock("./supervisor/darwin-bun-process-census.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./supervisor/darwin-bun-process-census.js")>()),
  readDarwinBunProcessCensus: native.census,
}));
vi.mock("@openclaw/proc-safe/inspect", () => ({ readProcessCommand: native.command }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile: vi.fn(),
  spawnSync: vi.fn(),
}));
import {
  readDarwinProcessSnapshot,
  readDarwinProcessTree,
  readDarwinProcessCommandLine,
} from "./darwin-process-inspection.js";

const bunDescriptor = Object.getOwnPropertyDescriptor(process.versions, "bun");
const row = { pid: 123, ppid: 1, pgid: 123, state: "S", uid: 501, startedAt: "123456:789" };
beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(process.versions, "bun", { configurable: true, value: "1.4.3" });
  native.census.mockReturnValue([row]);
});
afterEach(() => {
  if (bunDescriptor) {
    Object.defineProperty(process.versions, "bun", bunDescriptor);
  } else {
    Reflect.deleteProperty(process.versions, "bun");
  }
});

it("uses native identity and arguments without spawning ps under Bun", async () => {
  native.command.mockReturnValue({ argv: ["/opt/codex", "app-server"] });
  expect(await readDarwinProcessSnapshot(performance.now() + 1000, [123])).toEqual([row]);
  expect(native.census).toHaveBeenCalledWith(expect.any(Number), [123], true);
  expect(await readDarwinProcessCommandLine(123, performance.now() + 1000)).toBe(
    "/opt/codex app-server",
  );
  expect(native.command).toHaveBeenCalledExactlyOnceWith(123);
  expect(execFile).not.toHaveBeenCalled();
});

it.each(["census", "command"] as const)(
  "keeps a native %s denial distinct from absence",
  async (kind) => {
    native[kind].mockImplementation(() => {
      throw Object.assign(new Error("denied"), { code: "EPERM" });
    });
    await expect(
      kind === "census"
        ? readDarwinProcessSnapshot(performance.now() + 1000)
        : readDarwinProcessCommandLine(123, performance.now() + 1000),
    ).rejects.toMatchObject({ reason: "permission" });
    expect(execFile).not.toHaveBeenCalled();
  },
);

it("uses the bounded ps snapshot on Node without loading Bun FFI", async () => {
  Object.defineProperty(process.versions, "bun", { configurable: true, value: undefined });
  vi.mocked(execFile).mockImplementation((_file, _args, _options, callback) => {
    queueMicrotask(() =>
      callback?.(
        null,
        `123 1 123 S 501 Sat Aug 29 10:00:00 2026\n${process.pid} 1 ${process.pid} S 501 Sat Aug 29 10:00:00 2026\n`,
        "",
      ),
    );
    return new ChildProcess();
  });
  expect(await readDarwinProcessSnapshot(performance.now() + 1000, [123])).toEqual([
    { ...row, startedAt: "Sat Aug 29 10:00:00 2026" },
  ]);
  expect(native.census).not.toHaveBeenCalled();
});

it("reads start identities only for the requested tree, keeping unrelated users in the topology census", async () => {
  const child = { ...row, pid: 456, ppid: 123 };
  const foreign = { ...row, pid: 789, ppid: 1, uid: 0 };
  native.census.mockImplementation((_timeout, pids, includeStart) => {
    if (!includeStart) {
      return [row, child, foreign];
    }
    expect(pids).not.toContain(foreign.pid);
    return [{ ...row, pid: process.pid }, row, child];
  });
  expect(await readDarwinProcessTree(performance.now() + 1000, [123])).toEqual([
    { ...row, pid: process.pid },
    row,
    child,
  ]);
});

it("omits a vanished selected Node PID only when its observer is readable", async () => {
  Object.defineProperty(process.versions, "bun", { configurable: true, value: undefined });
  vi.mocked(execFile).mockImplementation((_file, _args, _options, callback) => {
    queueMicrotask(() =>
      callback?.(null, `${process.pid} 1 ${process.pid} S 501 Sat Aug 29 10:00:00 2026\n`, ""),
    );
    return new ChildProcess();
  });
  expect(await readDarwinProcessSnapshot(performance.now() + 1000, [123])).toEqual([]);
});
