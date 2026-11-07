import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const nativePlatform = process.platform;
const nativeRead = fs.readFileSync.bind(fs);
const warning = vi.fn<typeof process.emitWarning>();
const procfs = 0x9fa0n;
const drvfs = 0x01021997n;
const mount = "71 24 0:42 / /state rw - 9p drvfs rw,aname=drvfs;path=C:\\state";
const observedFs: {
  statfsSync(file: fs.PathLike, options: { bigint: true }): fs.BigIntStatsFs;
  readFileSync(file: fs.PathOrFileDescriptor, encoding: "utf8"): string;
} = fs;
let allowDrvfsRenameRecovery: typeof import("./fs-safe-drvfs.js").allowDrvfsRenameRecovery;

beforeEach(async () => {
  vi.resetModules();
  ({ allowDrvfsRenameRecovery } = await import("./fs-safe-drvfs.js"));
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  warning.mockClear();
  vi.spyOn(process, "emitWarning").mockImplementation(warning);
});
afterEach(() => vi.restoreAllMocks());

function observeMount(directory: string) {
  const observation = {
    procType: procfs,
    targetType: drvfs,
    fdinfo: "pos:\t0\nflags:\t0300000\nmnt_id:\t71\n",
    mountinfo: mount,
  };
  const expected = fs.statSync(directory);
  const descriptors = new Set<number>();
  function descriptorType(file: fs.PathLike): bigint {
    const fd = Number(String(file).replace("/proc/self/fd/", ""));
    const actual = fs.fstatSync(fd);
    descriptors.add(fd);
    return actual.dev === expected.dev && actual.ino === expected.ino ? observation.targetType : 0n;
  }
  vi.spyOn(observedFs, "statfsSync").mockImplementation((file) => ({
    type: String(file) === "/proc/self/fd" ? observation.procType : descriptorType(file),
    bsize: 4096n,
    frsize: 4096n,
    blocks: 1n,
    bfree: 1n,
    bavail: 1n,
    files: 1n,
    ffree: 1n,
  }));
  vi.spyOn(observedFs, "readFileSync").mockImplementation((file, encoding) => {
    if (String(file) === "/proc/self/mountinfo") {
      return observation.mountinfo;
    }
    const match = /^\/proc\/self\/fdinfo\/(\d+)$/.exec(String(file));
    if (match) {
      fs.fstatSync(Number(match[1]));
      return observation.fdinfo;
    }
    return nativeRead(file, encoding);
  });
  return { observation, descriptors };
}

describe("verified DrvFS rename recovery policy", () => {
  it.each([
    ["DrvFS options", {}, true],
    [
      "bare DrvFS aname",
      { mountinfo: mount.replace("aname=drvfs;path=C:\\state", "aname=drvfs") },
      true,
    ],
    ["non-procfs descriptor directory", { procType: 0n }, false],
    ["other target filesystem", { targetType: 0xef53n }, false],
    ["plain 9p", { mountinfo: mount.replace("aname=drvfs;path=C:\\state", "aname=share") }, false],
    [
      "DrvFS prefix lookalike",
      { mountinfo: mount.replace("aname=drvfs;", "aname=drvfs-other;") },
      false,
    ],
    [
      "other filesystem with DrvFS option",
      { mountinfo: mount.replace(" - 9p ", " - ext4 ") },
      false,
    ],
    ["different mount ID", { fdinfo: "mnt_id:\t72\n" }, false],
    ["missing mount ID", { fdinfo: "pos:\t0\n" }, false],
    ["ambiguous descriptor mount", { fdinfo: "mnt_id: 71\nmnt_id: 72\n" }, false],
    ["duplicate mount entry", { mountinfo: `${mount}\n${mount}` }, false],
    ["malformed mount entry", { mountinfo: "71 - 9p drvfs rw,aname=drvfs" }, false],
  ] as const)("admits only the fs-safe signature: %s", (_name, change, allowed) => {
    const directory = tempDirs.make("openclaw-drvfs-", process.cwd());
    const { observation, descriptors } = observeMount(directory);
    Object.assign(observation, change);
    expect(allowDrvfsRenameRecovery(directory)).toBe(allowed);
    for (const fd of descriptors) {
      expect(() => fs.fstatSync(fd)).toThrow(expect.objectContaining({ code: "EBADF" }));
    }
  });

  it("rechecks changed mount observations and emits one path-free operator warning", () => {
    const directory = tempDirs.make("openclaw-drvfs-", process.cwd());
    const { observation } = observeMount(directory);
    expect(allowDrvfsRenameRecovery(directory)).toBe(true);
    observation.mountinfo = mount.replace("aname=drvfs;path=C:\\state", "aname=share");
    expect(allowDrvfsRenameRecovery(directory)).toBe(false);
    observation.mountinfo = mount;
    expect(allowDrvfsRenameRecovery(directory)).toBe(true);
    expect(warning).toHaveBeenCalledOnce();
    const [message, options] = warning.mock.calls[0]!;
    expect(message).toMatch(/DrvFS.*inode-reuse risk/);
    expect(message).toMatch(/Docker volume.*WSL ext4/);
    expect(message).not.toContain(directory);
    expect(options).toEqual({ code: "DRVFS_RENAME_RECOVERY" });
  });

  it.each(["darwin", "win32"] as const)("does no filesystem work on %s", (platform) => {
    const io = [vi.spyOn(fs, "statfsSync"), vi.spyOn(fs, "openSync"), vi.spyOn(fs, "readFileSync")];
    vi.spyOn(process, "platform", "get").mockReturnValue(platform);
    expect(allowDrvfsRenameRecovery("/state")).toBe(false);
    for (const operation of io) {
      expect(operation).not.toHaveBeenCalled();
    }
    expect(warning).not.toHaveBeenCalled();
  });

  it("uses the nearest existing parent for a not-yet-created state directory", () => {
    const directory = tempDirs.make("openclaw-drvfs-", process.cwd());
    observeMount(directory);
    expect(allowDrvfsRenameRecovery(path.join(directory, "missing", "state"))).toBe(true);
  });

  it.skipIf(nativePlatform === "win32")("preserves literal symlink/.. traversal", () => {
    const directory = tempDirs.make("openclaw-drvfs-", process.cwd());
    const physical = path.join(directory, "physical");
    fs.mkdirSync(path.join(physical, "child"), { recursive: true });
    fs.symlinkSync(path.join(physical, "child"), path.join(directory, "link"), "dir");
    observeMount(physical);
    expect(allowDrvfsRenameRecovery(`${directory}/link/../missing/state`)).toBe(true);
  });
});
