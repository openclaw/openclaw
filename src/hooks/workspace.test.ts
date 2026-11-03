import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { MANIFEST_KEY } from "../compat/legacy-names.js";
import { writeHookFixture } from "./hook-fixture.test-support.js";
import { loadWorkspaceHookEntries } from "./workspace.js";

const { warnMock } = vi.hoisted(() => ({ warnMock: vi.fn() }));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ warn: warnMock }),
}));

const METADATA_MAX_BYTES = 1024 * 1024;

function writeHookPackageManifest(pkgDir: string, hooks: string[], size = 0): void {
  fs.writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify({ name: "pkg", [MANIFEST_KEY]: { hooks } }).padEnd(size),
  );
}

function writePlainHook(hooksRoot: string, name: string, content?: string): string {
  const hookDir = path.join(hooksRoot, name);
  writeHookFixture(hookDir, content ?? `---\nname: ${name}\n---\n`, undefined, "handler.js");
  return hookDir;
}

describe("hooks workspace", () => {
  let root: string;
  let hooksRoot: string;
  beforeEach(() => {
    warnMock.mockClear();
    root = tempDirs.make("openclaw-hooks-workspace-");
    hooksRoot = path.join(root, process.platform === "win32" ? "hooks" : " hooks ");
  });
  afterEach(() => vi.restoreAllMocks());

  function loadNames(extraDirs = [hooksRoot]) {
    return loadWorkspaceHookEntries(root, {
      managedHooksDir: path.join(root, "managed-none"),
      bundledHooksDir: path.join(root, "bundled-none"),
      config: { plugins: { enabled: false }, hooks: { internal: { load: { extraDirs } } } },
    }).map((entry) => entry.hook.name);
  }

  it.each(["traversal", "symlink"])(
    "rejects package %s escapes without scanning unlisted children",
    (escape) => {
      const pkgDir = path.join(hooksRoot, "pkg");
      const outsideDir = writePlainHook(root, "outside");
      writePlainHook(pkgDir, "unlisted");
      if (escape === "symlink") {
        fs.symlinkSync(
          outsideDir,
          path.join(pkgDir, "linked"),
          process.platform === "win32" ? "junction" : "dir",
        );
      }
      writeHookPackageManifest(pkgDir, [escape === "symlink" ? "./linked" : "../../outside"]);
      expect(loadNames()).toEqual([]);
    },
  );

  it("accepts metadata at the size limit, warns above it, and continues discovery", () => {
    const packageDir = path.join(hooksRoot, "big-package");
    fs.mkdirSync(packageDir, { recursive: true });
    const manifestPath = path.join(packageDir, "package.json");
    fs.writeFileSync(manifestPath, "x".repeat(METADATA_MAX_BYTES + 1));

    const bigHookDir = writePlainHook(hooksRoot, "big-hook", "x".repeat(METADATA_MAX_BYTES + 1));
    const pkgDir = path.join(hooksRoot, "pkg");
    writePlainHook(pkgDir, "nested", "---\nname: exact-limit\n---\n".padEnd(METADATA_MAX_BYTES));
    writeHookPackageManifest(pkgDir, ["./nested"], METADATA_MAX_BYTES);

    expect(loadNames()).toEqual(["exact-limit"]);
    expect(warnMock).toHaveBeenCalledWith(expect.stringContaining(manifestPath));
    expect(warnMock).toHaveBeenCalledWith(
      expect.stringContaining(path.join(bigHookDir, "HOOK.md")),
    );
    expect(warnMock).toHaveBeenCalledTimes(2);
  });

  it("warns without exposing contents when hook metadata cannot be read", () => {
    const hookDir = writePlainHook(hooksRoot, "unreadable-hook");
    const hookMdPath = path.join(hookDir, "HOOK.md");
    const metadataIdentity = fs.statSync(hookMdPath);
    const readSync = fs.readSync;
    const read = vi.spyOn(fs, "readSync").mockImplementation((...args) => {
      const identity = fs.fstatSync(args[0]);
      if (identity.dev === metadataIdentity.dev && identity.ino === metadataIdentity.ino) {
        throw new Error("private metadata contents");
      }
      return readSync(...args);
    });
    expect(loadNames()).toEqual([]);
    expect(warnMock).toHaveBeenCalledWith(expect.stringContaining(hookMdPath));
    expect(warnMock.mock.calls.flat().join(" ")).not.toContain("private metadata contents");
    read.mockRestore();
    expect(loadNames()).toEqual(["unreadable-hook"]);
  });

  it.each(["HOOK.md", "handler.js"])("ignores hooks with hardlinked %s aliases", (file) => {
    if (process.platform === "win32") {
      return;
    }
    const hookDir = writePlainHook(hooksRoot, "hardlink-hook");
    const outsideDir = writePlainHook(root, "outside");
    const linkedFile = path.join(hookDir, file);
    fs.unlinkSync(linkedFile);
    try {
      fs.linkSync(path.join(outsideDir, file), linkedFile);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EXDEV") {
        return;
      }
      throw err;
    }
    writePlainHook(hookDir, "unlisted");
    expect(loadNames()).toEqual([]);
  });
});
