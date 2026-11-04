import { afterEach, beforeEach, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  input: new Map<string, string | undefined>(),
  handles: new Map<number, { bytes: Buffer; offset: number }>(),
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    openSync: (path: string, flags: number) => {
      if (!path.startsWith("/proc/") && path !== "/etc/machine-id") {
        return actual.openSync(path, flags);
      }
      const content = native.input.get(path);
      if (content === undefined) {
        throw new Error("fixture OS file missing");
      }
      const fd = 900_000 + native.handles.size;
      native.handles.set(fd, { bytes: Buffer.from(content), offset: 0 });
      return fd;
    },
    readSync: (fd: number, buffer: Buffer, offset: number, length: number, position: null) => {
      const handle = native.handles.get(fd);
      if (!handle) {
        return actual.readSync(fd, buffer, offset, length, position);
      }
      const count = handle.bytes.copy(buffer, offset, handle.offset, handle.offset + length);
      handle.offset += count;
      return count;
    },
    closeSync: (fd: number) => {
      if (!native.handles.delete(fd)) {
        actual.closeSync(fd);
      }
    },
    readlinkSync: (path: string) =>
      path === "/proc/self/ns/pid" ? native.input.get("namespace")! : actual.readlinkSync(path),
  };
});
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: (command: string, args: string[]) => {
    const output = native.input.get(command === "/usr/sbin/ioreg" ? "hardware" : args.at(-1)!);
    return output === undefined
      ? { status: 1, stdout: "", error: new Error("fixture OS command unavailable") }
      : { status: 0, stdout: output };
  },
}));

const bootId = "aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff";
const hostId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const machineId = "abcdef0123456789abcdef0123456789";
const hostFile = "/etc/machine-id";
const bootFile = "/proc/sys/kernel/random/boot_id";

function provenance(name: string) {
  vi.stubGlobal(
    "process",
    new Proxy(process, {
      get: (target, key) => (key === "platform" ? name : Reflect.get(target, key)),
    }),
  );
  return import("../../scripts/crabbox-staging-provenance.mts");
}

beforeEach(() => {
  vi.resetModules();
  native.handles.clear();
  native.input = new Map([
    [hostFile, machineId + "\n"],
    [bootFile, bootId + "\n"],
    ["/proc/stat", "cpu 1 2 3 4\nbtime 1700000000\nprocesses 123\n"],
    ["namespace", "pid:[4026531836]"],
    ["hardware", `"IOPlatformUUID" = "${hostId.toUpperCase()}"`],
    ["kern.bootsessionuuid", bootId.toUpperCase() + "\n"],
    ["kern.boottime", "{ sec = 1700000000, usec = 123456 } Tue Nov 14 22:13:20 2023"],
  ]);
});
afterEach(() => {
  expect(native.handles.size).toBe(0);
  vi.unstubAllGlobals();
});

it.each([
  ["darwin", hostId, "", "bbdb3ca24d48a8202da9e1a2adacd7a86fd060819f45fa8511093995738483eb"],
  [
    "linux",
    machineId,
    "pid:[4026531836]",
    "74017c22ccf4955a2014f6dbbad1d16092cbbc83f0111748a25653c7a0d50568",
  ],
])("caches immutable %s provenance with its legacy digest", async (os, host, namespace, digest) => {
  const { currentProcessProvenance, processDomain } = await provenance(os);
  const observed = currentProcessProvenance()!;
  const expected = { platform: os, hostId: host, bootId, pidNamespace: namespace };
  expect(observed).toEqual(expected);
  expect(processDomain()).toBe(digest);
  expect(Reflect.set(observed, "hostId", "foreign-host")).toBe(false);
  native.input.clear();
  expect(currentProcessProvenance()).toEqual(expected);
});

it.each([
  ["darwin", "hardware", "no platform identity"],
  ["darwin", "hardware", '"IOPlatformUUID" = "not-a-uuid"'],
  ["darwin", "hardware", '"IOPlatformUUID" = "00000000-0000-0000-0000-000000000000"'],
  ["darwin", "kern.bootsessionuuid", "not-a-boot-id"],
  ["darwin", "kern.bootsessionuuid", undefined],
  ["linux", hostFile, undefined],
  ["linux", hostFile, "0".repeat(32)],
  ["linux", hostFile, machineId + " ".repeat(200)],
  ["linux", bootFile, "not-a-boot-id"],
  ["linux", "namespace", "pid:[unknown]"],
  ["win32", "unsupported", undefined],
] as const)("fails closed for %s %s provenance (%s)", async (os, key, value) => {
  native.input.set(key, value);
  const { currentProcessProvenance, processDomain } = await provenance(os);
  expect(currentProcessProvenance()).toBeUndefined();
  expect(processDomain()).toBeUndefined();
});

it.each([
  ["darwin", undefined, 1700000000123456000n],
  ["linux", undefined, 1700000000000000000n],
  ["darwin", "{ sec = 1700000000, usec = 1000000 }", undefined],
  ["darwin", "{ sec = -1, usec = 0 }", undefined],
  ["darwin", "unexpected output", undefined],
  ["linux", "cpu 1 2 3 4\n", undefined],
  ["linux", "btime -1\n", undefined],
  ["linux", "btime 1700000000\n" + " ".repeat(1024 * 1024), undefined],
] as const)("parses %s boot time (%s)", async (os, output, time) => {
  if (output !== undefined) {
    native.input.set(os === "darwin" ? "kern.boottime" : "/proc/stat", output);
  }
  const { currentBootTimeNs } = await provenance(os);
  expect(currentBootTimeNs()).toBe(time);
});
