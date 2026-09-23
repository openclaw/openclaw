import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { sameFsObject, tryResolvePathCaseInsensitive } from "./path-case.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.restoreAllMocks();
});

type FsObjectIdentity = Parameters<typeof sameFsObject>[0];

function identity(dev: number, ino: number): FsObjectIdentity {
  return { dev, ino };
}

describe("sameFsObject", () => {
  it("treats zero identity fields as exact values rather than wildcards", () => {
    expect(sameFsObject(identity(0, 11), identity(8, 11))).toBe(false);
    expect(sameFsObject(identity(7, 0), identity(7, 12))).toBe(false);
  });
});

describe("tryResolvePathCaseInsensitive", () => {
  it("does not attempt temporary writes when read-only observation is requested", () => {
    const root = tempDirs.make("openclaw-path-case-");
    const openSpy = vi.spyOn(fs, "openSync");
    const writeSpy = vi.spyOn(fs, "writeFileSync");

    expect(
      tryResolvePathCaseInsensitive(path.join(root, "missing"), { allowTemporaryProbe: false }),
    ).toBeUndefined();

    const writableFlags =
      fs.constants.O_WRONLY |
      fs.constants.O_RDWR |
      fs.constants.O_CREAT |
      fs.constants.O_TRUNC |
      fs.constants.O_APPEND;
    expect(
      openSpy.mock.calls.filter(([, flags]) =>
        typeof flags === "string" ? /[wa+]/u.test(flags) : (flags & writableFlags) !== 0,
      ),
    ).toHaveLength(0);
    expect(writeSpy).not.toHaveBeenCalled();
    expect(fs.readdirSync(root)).toEqual([]);
  });
});
