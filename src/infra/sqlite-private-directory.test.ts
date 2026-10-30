import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { isPrivateDirectoryCreationRefused } from "./private-directory-creation.js";
import { resolvePrivateSqliteSnapshotStagingRoot } from "./sqlite-private-directory.js";
import * as tmpOpenClawDir from "./tmp-openclaw-dir.js";
import {
  createPrivateWindowsDirectory,
  createPrivateWindowsFile,
} from "./windows-private-directory.js";

afterEach(() => vi.restoreAllMocks());
function captureFailure(create: () => unknown): unknown {
  try {
    return create();
  } catch (error) {
    return error;
  }
}

it.each([
  [undefined, "sqlite-local-app-data", "sqlite-local-app-data"],
  ["relative/cache", "sqlite-local-app-data", "sqlite-local-app-data"],
  [undefined, undefined, "sqlite-home/AppData/Local"],
  [undefined, "relative/local-app-data", "sqlite-home/AppData/Local"],
  ["sqlite-xdg-cache", "sqlite-local-app-data", "sqlite-xdg-cache"],
] as const)(
  "selects the Windows cache for XDG=%s and LOCALAPPDATA=%s",
  (xdgCacheHome, localAppData, expectedRoot) => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const resolveTempRoot = vi
      .spyOn(tmpOpenClawDir, "resolvePreferredOpenClawTmpDir")
      .mockImplementation((options) => options?.preferredDir ?? "");

    const resolveRoot = (root: string | undefined) =>
      root?.startsWith("sqlite-") ? path.resolve(root) : root;
    expect(
      resolvePrivateSqliteSnapshotStagingRoot({
        HOME: path.resolve("sqlite-home"),
        LOCALAPPDATA: resolveRoot(localAppData),
        XDG_CACHE_HOME: resolveRoot(xdgCacheHome),
      }),
    ).toBe(path.join(path.resolve(expectedRoot), "openclaw"));
    expect(resolveTempRoot.mock.calls[0]?.[0]?.tmpdir?.()).toBe(path.resolve(expectedRoot));
  },
);

describe.skipIf(process.platform === "win32")("private creation adapter on the native host", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it.each(["parent-file", "existing-directory"] as const)(
    "preserves the semantic %s error and records a confirmed refusal",
    (kind) => {
      const root = tempDirs.make("openclaw-private-preflight-");
      const parent = path.join(root, "parent");
      const directory = kind === "parent-file" ? path.join(parent, "child") : parent;
      if (kind === "parent-file") {
        fs.writeFileSync(parent, "preserved");
      } else {
        fs.mkdirSync(parent);
      }
      const failure = captureFailure(() => createPrivateWindowsDirectory(directory));
      expect(failure).toMatchObject({
        code: kind === "parent-file" ? "not-file" : "already-exists",
      });
      expect(isPrivateDirectoryCreationRefused(failure)).toBe(true);
      if (kind === "parent-file") {
        expect(fs.readFileSync(parent, "utf8")).toBe("preserved");
      } else {
        expect(fs.statSync(parent).isDirectory()).toBe(true);
      }
    },
  );

  it("does not call a failed dispatched creation a confirmed refusal", () => {
    const root = tempDirs.make("openclaw-private-dispatched-");
    const directory = path.join(root, "created");
    const failure = new Error("creation lost its completion receipt");
    const mkdir = fs.mkdirSync;
    vi.spyOn(fs, "mkdirSync").mockImplementation((target, options) => {
      const result = mkdir(target, options);
      if (String(target) === directory) {
        throw failure;
      }
      return result;
    });
    const thrown = captureFailure(() => createPrivateWindowsDirectory(directory));
    expect(thrown).toBe(failure);
    expect(isPrivateDirectoryCreationRefused(thrown)).toBe(false);
    expect(fs.statSync(directory).isDirectory()).toBe(true);
  });

  it("returns an owned private descriptor and preserves an existing file", () => {
    const root = tempDirs.make("openclaw-private-owner-");
    const file = path.join(root, "private");
    const owner = createPrivateWindowsFile(file);
    try {
      expect(fs.fstatSync(owner.fd).mode & 0o777).toBe(0o600);
      fs.writeSync(owner.fd, "winner");
    } finally {
      owner.close();
      owner.close();
    }
    expect(() => createPrivateWindowsFile(file)).toThrow(
      expect.objectContaining({ code: "already-exists" }),
    );
    expect(fs.readFileSync(file, "utf8")).toBe("winner");
    expect(fs.statSync(file).nlink).toBe(1);
  });
});
