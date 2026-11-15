import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { preparePrivateStoreFileSync } from "./private-store-file.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

describe.runIf(process.platform === "linux")("private store creation under setgid", () => {
  it("creates a private store on the first attempt without changing the containing root", () => {
    const root = tempDirs.make("private-store-setgid-");
    fs.chmodSync(root, 0o2700);
    const pathname = path.join(root, "control", "services.sqlite");

    expect(preparePrivateStoreFileSync(pathname, false)).toBe(true);
    expect(fs.statSync(root).mode & 0o7777).toBe(0o2700);
    expect(fs.statSync(path.dirname(pathname)).mode & 0o7777).toBe(0o700);
    expect(fs.statSync(pathname).mode & 0o7777).toBe(0o600);
    fs.writeFileSync(pathname, "retained data");
    expect(preparePrivateStoreFileSync(pathname, true)).toBe(false);
    expect(fs.readFileSync(pathname, "utf8")).toBe("retained data");
  });

  it.each([0o2770, 0o3700])("does not admit a newly created directory with mode %s", (mode) => {
    const root = tempDirs.make("private-store-refusal-");
    const directory = path.join(root, "control");
    const mkdir = fs.mkdirSync;
    vi.spyOn(fs, "mkdirSync").mockImplementation((target, options) => {
      const result = mkdir(target, options);
      if (String(target) === directory) {
        fs.chmodSync(directory, mode);
      }
      return result;
    });

    expect(() =>
      preparePrivateStoreFileSync(path.join(directory, "services.sqlite"), false),
    ).toThrow(
      expect.objectContaining({
        code: "helper-failed",
        message: "created directory admission failed",
      }),
    );
    expect(fs.statSync(directory).mode & 0o7777).toBe(mode);
    expect(fs.readdirSync(directory)).toEqual([]);
  });

  it("preserves the creation refusal when private-mode normalization fails", () => {
    const root = tempDirs.make("private-store-chmod-refusal-");
    fs.chmodSync(root, 0o2700);
    const directory = path.join(root, "control");
    vi.spyOn(fs, "fchmodSync").mockImplementation(() => {
      throw Object.assign(new Error("read-only fixture"), { code: "EROFS" });
    });

    expect(() =>
      preparePrivateStoreFileSync(path.join(directory, "services.sqlite"), false),
    ).toThrow(
      expect.objectContaining({
        code: "helper-failed",
        message: "created directory admission failed",
      }),
    );
    expect(fs.statSync(directory).mode & 0o7777).toBe(0o2700);
    expect(fs.readdirSync(directory)).toEqual([]);
  });
});
