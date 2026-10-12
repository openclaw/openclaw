import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withEnv } from "../test-utils/env.js";
import { isPrivateDirectoryCreationRefused } from "./private-directory-creation.js";
import { resolvePrivateSqliteSnapshotStagingRoot } from "./sqlite-private-directory.js";
import * as tmpOpenClawDir from "./tmp-openclaw-dir.js";
import {
  createPrivateWindowsDirectory,
  createPrivateWindowsFile,
} from "./windows-private-directory.js";

describe("private SQLite snapshot staging root", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    {
      label: "an absolute LOCALAPPDATA root",
      xdgCacheHome: undefined,
      localAppData: path.resolve("sqlite-local-app-data"),
      expectedRoot: path.resolve("sqlite-local-app-data"),
    },
    {
      label: "LOCALAPPDATA when XDG_CACHE_HOME is relative",
      xdgCacheHome: "relative/cache",
      localAppData: path.resolve("sqlite-local-app-data"),
      expectedRoot: path.resolve("sqlite-local-app-data"),
    },
    {
      label: "HOME/AppData/Local when LOCALAPPDATA is absent",
      xdgCacheHome: undefined,
      localAppData: undefined,
      expectedRoot: path.join(path.resolve("sqlite-home"), "AppData", "Local"),
    },
    {
      label: "HOME/AppData/Local when LOCALAPPDATA is relative",
      xdgCacheHome: undefined,
      localAppData: "relative/local-app-data",
      expectedRoot: path.join(path.resolve("sqlite-home"), "AppData", "Local"),
    },
    {
      label: "absolute XDG_CACHE_HOME ahead of LOCALAPPDATA",
      xdgCacheHome: path.resolve("sqlite-xdg-cache"),
      localAppData: path.resolve("sqlite-local-app-data"),
      expectedRoot: path.resolve("sqlite-xdg-cache"),
    },
  ])(
    "selects $label for the Windows snapshot cache",
    ({ xdgCacheHome, localAppData, expectedRoot }) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      const resolveTempRoot = vi
        .spyOn(tmpOpenClawDir, "resolvePreferredOpenClawTmpDir")
        .mockImplementation((options) => options?.preferredDir ?? "");

      withEnv(
        {
          HOME: path.resolve("sqlite-home"),
          LOCALAPPDATA: localAppData,
          XDG_CACHE_HOME: xdgCacheHome,
        },
        () => {
          expect(resolvePrivateSqliteSnapshotStagingRoot()).toBe(
            path.join(expectedRoot, "openclaw"),
          );
        },
      );

      expect(resolveTempRoot.mock.calls[0]?.[0]?.tmpdir?.()).toBe(expectedRoot);
    },
  );
});

describe.skipIf(process.platform === "win32")("private creation adapter on the native host", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  afterEach(() => vi.restoreAllMocks());

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
      let failure: unknown;
      try {
        createPrivateWindowsDirectory(directory);
      } catch (error) {
        failure = error;
      }
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
    let thrown: unknown;
    try {
      createPrivateWindowsDirectory(directory);
    } catch (error) {
      thrown = error;
    }
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
