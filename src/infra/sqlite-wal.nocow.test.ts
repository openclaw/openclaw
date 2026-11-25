import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  prepareSqliteDatabaseDirectory,
  setSqliteDirectoryNoCow,
} from "./sqlite-wal-filesystem.js";

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ warn }),
}));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it.each([
  { kind: "nested ext4 mount", type: null },
  { kind: "existing file", type: 0x9123683e },
])("does not modify $kind", ({ kind, type }) => {
  const directory = fs.realpathSync(tempDirs.make("openclaw-nocow-policy-"));
  const databasePath = path.join(directory, "openclaw.sqlite");
  const fixture = fs.statfsSync(directory);
  const statfs = vi.spyOn(fs, "statfsSync").mockImplementation(() => {
    if (type === null) {
      throw new Error("statfs unavailable");
    }
    return Object.assign(fixture, { type });
  });
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  const readFile = fs.readFileSync;
  vi.spyOn(fs, "readFileSync").mockImplementation((...args) => {
    if (args[0] === "/proc/self/mountinfo") {
      return (
        "1 0 0:1 / / rw - btrfs /dev/test rw\n" +
        (kind === "nested ext4 mount" ? `2 1 0:2 / ${directory} rw - ext4 /dev/other rw\n` : "")
      );
    }
    return readFile(...args);
  });
  if (kind === "existing file") {
    fs.writeFileSync(databasePath, "existing bytes");
  }
  const chattr = vi.spyOn(childProcess, "spawnSync").mockReturnValue({
    pid: 1,
    output: [],
    stdout: "",
    stderr: "",
    status: 0,
    signal: null,
  });
  prepareSqliteDatabaseDirectory(databasePath);
  expect(chattr).not.toHaveBeenCalled();
  if (kind === "existing file") {
    expect(fs.readFileSync(databasePath, "utf8")).toBe("existing bytes");
    expect(statfs).not.toHaveBeenCalled();
    expect(() => setSqliteDirectoryNoCow(databasePath)).toThrow("not a directory");
    expect(chattr).not.toHaveBeenCalled();
  }
});

it("keeps fresh stores usable after missing tooling, denied attributes, and timeouts; warns once", () => {
  const directory = fs.realpathSync(tempDirs.make("openclaw-nocow-failure-"));
  const fixture = fs.statfsSync(directory);
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  vi.spyOn(fs, "statfsSync").mockReturnValue(Object.assign(fixture, { type: 0x9123683e }));
  const result = { pid: 1, output: [], stdout: "", stderr: "", status: 0, signal: null };
  vi.spyOn(childProcess, "spawnSync")
    .mockReturnValueOnce({
      ...result,
      error: Object.assign(new Error("chattr missing"), { code: "ENOENT" }),
    })
    .mockReturnValueOnce({ ...result, status: 1, stderr: "Operation not permitted" })
    .mockReturnValueOnce({ ...result, status: null, signal: "SIGKILL" });
  for (const name of ["missing", "denied", "timeout"]) {
    const file = path.join(directory, `${name}.sqlite`);
    expect(() => prepareSqliteDatabaseDirectory(file)).not.toThrow();
    fs.writeFileSync(file, name);
    expect(fs.readFileSync(file, "utf8")).toBe(name);
  }
  expect(warn).toHaveBeenCalledOnce();
});
