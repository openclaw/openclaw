import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { MANIFEST_KEY } from "../compat/legacy-names.js";
import { loadWorkspaceHookEntries } from "./workspace.js";

const { warnMock } = vi.hoisted(() => ({ warnMock: vi.fn() }));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ warn: warnMock }),
}));

function writeHookPackageManifest(pkgDir: string, hooks: string[]): void {
  fs.writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify({ name: "pkg", [MANIFEST_KEY]: { hooks } }),
  );
}

function makeHooksWorkspace() {
  const root = tempDirs.make("openclaw-hooks-workspace-");
  const hooksRoot = path.join(root, "hooks");
  fs.mkdirSync(hooksRoot, { recursive: true });
  return { root, hooksRoot };
}

function hookNames(entries: ReturnType<typeof loadWorkspaceHookEntries>): string[] {
  return entries.map((entry) => entry.hook.name);
}

function loadWorkspaceEntriesFromHooksRoot(hooksRoot: string) {
  const workspaceDir = path.dirname(hooksRoot);
  return loadWorkspaceHookEntries(workspaceDir, {
    managedHooksDir: path.join(workspaceDir, "managed-none"),
    bundledHooksDir: path.join(workspaceDir, "bundled-none"),
    config: {
      plugins: { enabled: false },
      hooks: { internal: { load: { extraDirs: [] } } },
    },
  });
}

const METADATA_MAX_BYTES = 1024 * 1024;

function writePlainHook(hooksRoot: string, name: string, content?: string): string {
  const hookDir = path.join(hooksRoot, name);
  fs.mkdirSync(hookDir, { recursive: true });
  fs.writeFileSync(path.join(hookDir, "HOOK.md"), content ?? `---\nname: ${name}\n---\n`);
  fs.writeFileSync(path.join(hookDir, "handler.js"), "export default async () => {};\n");
  return hookDir;
}

function oversizedMetadataWarnings(filePath: string): string[] {
  return warnMock.mock.calls
    .map(([message]) => String(message))
    .filter((message) => message.includes(filePath) && message.includes(`${METADATA_MAX_BYTES}`));
}

function padToExactBytes(content: string, targetBytes: number): string {
  const padding = targetBytes - Buffer.byteLength(content, "utf8");
  return padding > 0 ? content + " ".repeat(padding) : content;
}

describe("hooks workspace", () => {
  beforeEach(() => warnMock.mockClear());

  it.each(["traversal", "symlink"])(
    "rejects package %s escapes without scanning unlisted children",
    (escape) => {
      const { root, hooksRoot } = makeHooksWorkspace();
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
      expect(hookNames(loadWorkspaceEntriesFromHooksRoot(hooksRoot))).toEqual([]);
    },
  );

  it("warns, skips oversized metadata, and continues discovering other hooks", () => {
    const { hooksRoot } = makeHooksWorkspace();

    const packageDir = path.join(hooksRoot, "big-package");
    fs.mkdirSync(packageDir);
    const manifestPath = path.join(packageDir, "package.json");
    fs.writeFileSync(manifestPath, "x".repeat(METADATA_MAX_BYTES + 1));

    const bigHookDir = writePlainHook(hooksRoot, "big-hook", "x".repeat(METADATA_MAX_BYTES + 1));
    writePlainHook(hooksRoot, "small-hook");

    const entries = loadWorkspaceEntriesFromHooksRoot(hooksRoot);
    expect(hookNames(entries)).toEqual(["small-hook"]);
    expect(oversizedMetadataWarnings(manifestPath)).toHaveLength(1);
    expect(oversizedMetadataWarnings(path.join(bigHookDir, "HOOK.md"))).toHaveLength(1);
  });

  it("loads hooks whose metadata sits exactly at the byte limit", () => {
    const { hooksRoot } = makeHooksWorkspace();

    const pkgDir = path.join(hooksRoot, "pkg");
    writePlainHook(
      pkgDir,
      "nested",
      padToExactBytes("---\nname: exact-limit\n---\n", METADATA_MAX_BYTES),
    );
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      padToExactBytes(
        JSON.stringify({ name: "pkg", [MANIFEST_KEY]: { hooks: ["./nested"] } }),
        METADATA_MAX_BYTES,
      ),
    );

    expect(hookNames(loadWorkspaceEntriesFromHooksRoot(hooksRoot))).toContain("exact-limit");
    expect(warnMock).not.toHaveBeenCalled();
  });

  it.each(["EIO", "EACCES"])("warns when hook metadata cannot be read (%s)", (code) => {
    const { hooksRoot } = makeHooksWorkspace();
    const hookDir = writePlainHook(hooksRoot, "unreadable-hook");
    const hookMdPath = path.join(hookDir, "HOOK.md");
    const metadataIdentity = fs.statSync(hookMdPath);
    const readSync = fs.readSync;
    const read = vi.spyOn(fs, "readSync").mockImplementation((...args) => {
      const identity = fs.fstatSync(args[0]);
      if (identity.dev === metadataIdentity.dev && identity.ino === metadataIdentity.ino) {
        throw Object.assign(new Error("private metadata contents"), { code });
      }
      return readSync(...args);
    });
    try {
      expect(loadWorkspaceEntriesFromHooksRoot(hooksRoot)).toEqual([]);
      expect(warnMock).toHaveBeenCalledExactlyOnceWith(
        `Failed to read hook metadata ${hookMdPath}; check file permissions and disk health.`,
      );
    } finally {
      read.mockRestore();
    }
    expect(hookNames(loadWorkspaceEntriesFromHooksRoot(hooksRoot))).toEqual(["unreadable-hook"]);
  });

  it.each(["HOOK.md", "handler.js"])("ignores hooks with hardlinked %s aliases", (file) => {
    if (process.platform === "win32") {
      return;
    }
    const { root, hooksRoot } = makeHooksWorkspace();
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
    expect(hookNames(loadWorkspaceEntriesFromHooksRoot(hooksRoot))).toEqual([]);
  });
});
