// Hook workspace tests cover workspace hook discovery and path handling.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { MANIFEST_KEY } from "../compat/legacy-names.js";
import { loadWorkspaceHookEntries } from "./workspace.js";

const { warnMock } = vi.hoisted(() => ({ warnMock: vi.fn() }));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const discoveryModes = ["collection", "extra root"] as const;

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

function setupHardlinkHookWorkspace(hookName: string): {
  hooksRoot: string;
  hookDir: string;
  outsideDir: string;
} {
  const { root, hooksRoot } = makeHooksWorkspace();

  const hookDir = path.join(hooksRoot, hookName);
  const outsideDir = path.join(root, "outside");
  fs.mkdirSync(hookDir, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });
  return { hooksRoot, hookDir, outsideDir };
}

function tryCreateHardlinkOrSkip(createLink: () => void): boolean {
  try {
    createLink();
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EXDEV") {
      return false;
    }
    throw err;
  }
}

function hookNames(entries: ReturnType<typeof loadWorkspaceHookEntries>): string[] {
  return entries.map((entry) => entry.hook.name);
}

function loadWorkspaceEntriesFromHooksRoot(hooksRoot: string, extraRoot?: string) {
  const workspaceDir = extraRoot
    ? path.join(path.dirname(hooksRoot), "empty-workspace")
    : path.dirname(hooksRoot);
  return loadWorkspaceHookEntries(workspaceDir, {
    managedHooksDir: path.join(workspaceDir, "managed-none"),
    bundledHooksDir: path.join(workspaceDir, "bundled-none"),
    config: {
      plugins: { enabled: false },
      hooks: { internal: { load: { extraDirs: extraRoot ? [extraRoot] : [] } } },
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

function exactSizeHookPackageManifest(targetBytes: number): string {
  const base = { name: "pkg", [MANIFEST_KEY]: { hooks: ["./nested"] }, pad: "" };
  const baseBytes = Buffer.byteLength(JSON.stringify(base), "utf8");
  return JSON.stringify({ ...base, pad: "x".repeat(targetBytes - baseBytes) });
}

describe("hooks workspace", () => {
  beforeEach(() => {
    warnMock.mockClear();
  });

  it.each(discoveryModes)(
    "rejects package traversal without scanning unlisted children (%s)",
    (mode) => {
      const { root, hooksRoot } = makeHooksWorkspace();

      const pkgDir = path.join(hooksRoot, "pkg");
      fs.mkdirSync(pkgDir, { recursive: true });

      writePlainHook(root, "outside");
      writePlainHook(pkgDir, "unlisted");

      writeHookPackageManifest(pkgDir, ["../../outside"]);

      const entries = loadWorkspaceEntriesFromHooksRoot(
        hooksRoot,
        mode === "extra root" ? pkgDir : undefined,
      );
      expect(hookNames(entries)).toEqual([]);
    },
  );

  it.each(discoveryModes)("does not recurse into declared packs or collections (%s)", (mode) => {
    const { hooksRoot } = makeHooksWorkspace();
    const pkgDir = path.join(hooksRoot, "pkg");
    const nestedPack = path.join(pkgDir, "nested-pack");
    writePlainHook(nestedPack, "nested-hook");
    writeHookPackageManifest(nestedPack, ["./nested-hook"]);
    writePlainHook(path.join(pkgDir, "nested-collection"), "collection-hook");
    writePlainHook(pkgDir, "unlisted");
    writeHookPackageManifest(pkgDir, ["./nested-pack", "./nested-collection"]);

    const entries = loadWorkspaceEntriesFromHooksRoot(
      hooksRoot,
      mode === "extra root" ? pkgDir : undefined,
    );
    expect(hookNames(entries)).toEqual([]);
  });

  it("warns, skips oversized metadata, and continues discovering other hooks", () => {
    const { hooksRoot } = makeHooksWorkspace();

    const packageDir = path.join(hooksRoot, "big-package");
    fs.mkdirSync(packageDir);
    const manifestPath = path.join(packageDir, "package.json");
    fs.writeFileSync(manifestPath, "x".repeat(METADATA_MAX_BYTES + 1));

    const bigHookDir = writePlainHook(hooksRoot, "big-hook", "x".repeat(METADATA_MAX_BYTES + 1));
    const bigHookMdPath = path.join(bigHookDir, "HOOK.md");
    writePlainHook(hooksRoot, "small-hook");

    const entries = loadWorkspaceEntriesFromHooksRoot(hooksRoot);
    expect(hookNames(entries)).toEqual(["small-hook"]);
    expect(oversizedMetadataWarnings(manifestPath)).toHaveLength(1);
    expect(oversizedMetadataWarnings(bigHookMdPath)).toHaveLength(1);
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
      exactSizeHookPackageManifest(METADATA_MAX_BYTES),
    );

    const entries = loadWorkspaceEntriesFromHooksRoot(hooksRoot);
    expect(hookNames(entries)).toContain("exact-limit");
    expect(warnMock).not.toHaveBeenCalled();
  });

  it.each(discoveryModes)(
    "still loads a plain hook when its package.json is oversized (%s)",
    (mode) => {
      const { hooksRoot } = makeHooksWorkspace();

      const hookDir = writePlainHook(hooksRoot, "compat-hook");
      const manifestPath = path.join(hookDir, "package.json");
      fs.writeFileSync(manifestPath, "x".repeat(METADATA_MAX_BYTES + 1), "utf8");

      const entries = loadWorkspaceEntriesFromHooksRoot(
        hooksRoot,
        mode === "extra root" ? hookDir : undefined,
      );
      expect(hookNames(entries)).toContain("compat-hook");
      expect(oversizedMetadataWarnings(manifestPath)).toHaveLength(1);
    },
  );

  it.each(discoveryModes)(
    "rejects package symlink escapes without scanning unlisted children (%s)",
    (mode) => {
      const { root, hooksRoot } = makeHooksWorkspace();

      const pkgDir = path.join(hooksRoot, "pkg");
      const outsideDir = writePlainHook(root, "outside");
      const linkedDir = path.join(pkgDir, "linked");
      fs.mkdirSync(pkgDir, { recursive: true });
      fs.symlinkSync(outsideDir, linkedDir, process.platform === "win32" ? "junction" : "dir");

      writePlainHook(pkgDir, "unlisted");
      writeHookPackageManifest(pkgDir, ["./linked"]);

      const entries = loadWorkspaceEntriesFromHooksRoot(
        hooksRoot,
        mode === "extra root" ? pkgDir : undefined,
      );
      expect(hookNames(entries)).toEqual([]);
    },
  );

  it.each(discoveryModes)("ignores hooks with hardlinked HOOK.md aliases (%s)", (mode) => {
    if (process.platform === "win32") {
      return;
    }

    const { hooksRoot, hookDir, outsideDir } = setupHardlinkHookWorkspace("hardlink-hook");
    fs.writeFileSync(path.join(hookDir, "handler.js"), "export default async () => {};\n");
    const outsideHookMd = path.join(outsideDir, "HOOK.md");
    const linkedHookMd = path.join(hookDir, "HOOK.md");
    fs.writeFileSync(outsideHookMd, "---\nname: outside\n---\n");
    if (!tryCreateHardlinkOrSkip(() => fs.linkSync(outsideHookMd, linkedHookMd))) {
      return;
    }

    writePlainHook(hookDir, "unlisted");
    const entries = loadWorkspaceEntriesFromHooksRoot(
      hooksRoot,
      mode === "extra root" ? hookDir : undefined,
    );
    expect(hookNames(entries)).toEqual([]);
  });

  it.each(discoveryModes)("ignores hooks with hardlinked handler aliases (%s)", (mode) => {
    if (process.platform === "win32") {
      return;
    }

    const { hooksRoot, hookDir, outsideDir } = setupHardlinkHookWorkspace("hardlink-handler-hook");
    fs.writeFileSync(path.join(hookDir, "HOOK.md"), "---\nname: hardlink-handler-hook\n---\n");
    const outsideHandler = path.join(outsideDir, "handler.js");
    const linkedHandler = path.join(hookDir, "handler.js");
    fs.writeFileSync(outsideHandler, "export default async () => {};\n");
    if (!tryCreateHardlinkOrSkip(() => fs.linkSync(outsideHandler, linkedHandler))) {
      return;
    }

    writePlainHook(hookDir, "unlisted");
    const entries = loadWorkspaceEntriesFromHooksRoot(
      hooksRoot,
      mode === "extra root" ? hookDir : undefined,
    );
    expect(hookNames(entries)).toEqual([]);
  });

  it("treats configured extraDirs as managed hook sources", () => {
    const root = tempDirs.make("openclaw-hooks-extra-");
    const workspaceDir = path.join(root, "workspace");
    writePlainHook(path.join(root, "shared-hooks"), "shared-hook");

    const entries = loadWorkspaceHookEntries(workspaceDir, {
      bundledHooksDir: path.join(root, "bundled-none"),
      config: {
        hooks: {
          internal: {
            enabled: true,
            load: {
              extraDirs: [path.join(root, "shared-hooks")],
            },
          },
        },
      },
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]?.hook.name).toBe("shared-hook");
    expect(entries[0]?.hook.source).toBe("openclaw-managed");
  });
});
