// Hook workspace tests cover workspace hook discovery and path handling.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MANIFEST_KEY } from "../compat/legacy-names.js";
import { loadWorkspaceHookEntries } from "./workspace.js";

const { warnMock } = vi.hoisted(() => ({ warnMock: vi.fn() }));

vi.mock("../logging/subsystem.js", () => {
  const makeLogger = () => ({
    subsystem: "hooks/workspace",
    isEnabled: () => true,
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnMock,
    error: vi.fn(),
    fatal: vi.fn(),
    raw: vi.fn(),
    child: () => makeLogger(),
  });
  return { createSubsystemLogger: () => makeLogger() };
});

function writeHookPackageManifest(pkgDir: string, hooks: string[]): void {
  fs.writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify(
      {
        name: "pkg",
        [MANIFEST_KEY]: {
          hooks,
        },
      },
      null,
      2,
    ),
  );
}

function setupHardlinkHookWorkspace(hookName: string): {
  hooksRoot: string;
  hookDir: string;
  outsideDir: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-hooks-workspace-hardlink-"));
  const hooksRoot = path.join(root, "hooks");
  fs.mkdirSync(hooksRoot, { recursive: true });

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

function loadWorkspaceEntriesFromHooksRoot(hooksRoot: string) {
  const workspaceDir = path.dirname(hooksRoot);
  return loadWorkspaceHookEntries(workspaceDir, {
    managedHooksDir: path.join(workspaceDir, "managed-none"),
    bundledHooksDir: path.join(workspaceDir, "bundled-none"),
  });
}

const METADATA_MAX_BYTES = 1024 * 1024;

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

  it("ignores package.json hook paths that traverse outside package directory", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-hooks-workspace-"));
    const hooksRoot = path.join(root, "hooks");
    fs.mkdirSync(hooksRoot, { recursive: true });

    const pkgDir = path.join(hooksRoot, "pkg");
    fs.mkdirSync(pkgDir, { recursive: true });

    const outsideHookDir = path.join(root, "outside");
    fs.mkdirSync(outsideHookDir, { recursive: true });
    fs.writeFileSync(path.join(outsideHookDir, "HOOK.md"), "---\nname: outside\n---\n");
    fs.writeFileSync(path.join(outsideHookDir, "handler.js"), "export default async () => {};\n");

    writeHookPackageManifest(pkgDir, ["../outside"]);

    const entries = loadWorkspaceEntriesFromHooksRoot(hooksRoot);
    expect(hookNames(entries)).not.toContain("outside");
  });

  it("accepts package.json hook paths within package directory", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-hooks-workspace-ok-"));
    const hooksRoot = path.join(root, "hooks");
    fs.mkdirSync(hooksRoot, { recursive: true });

    const pkgDir = path.join(hooksRoot, "pkg");
    const nested = path.join(pkgDir, "nested");
    fs.mkdirSync(nested, { recursive: true });

    fs.writeFileSync(path.join(nested, "HOOK.md"), "---\nname: nested\n---\n");
    fs.writeFileSync(path.join(nested, "handler.js"), "export default async () => {};\n");

    writeHookPackageManifest(pkgDir, ["./nested"]);

    const entries = loadWorkspaceEntriesFromHooksRoot(hooksRoot);
    expect(hookNames(entries)).toContain("nested");
  });

  it("warns and skips hook packages with an oversized package.json", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-hooks-oversized-manifest-"));
    const hooksRoot = path.join(root, "hooks");
    fs.mkdirSync(hooksRoot, { recursive: true });

    const pkgDir = path.join(hooksRoot, "pkg");
    fs.mkdirSync(pkgDir, { recursive: true });
    const manifestPath = path.join(pkgDir, "package.json");
    fs.writeFileSync(manifestPath, "x".repeat(METADATA_MAX_BYTES + 1), "utf8");

    const entries = loadWorkspaceEntriesFromHooksRoot(hooksRoot);
    expect(hookNames(entries)).toHaveLength(0);
    expect(oversizedMetadataWarnings(manifestPath)).toHaveLength(1);
  });

  it("warns and skips hooks with an oversized HOOK.md", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-hooks-oversized-md-"));
    const hooksRoot = path.join(root, "hooks");
    fs.mkdirSync(hooksRoot, { recursive: true });

    const hookDir = path.join(hooksRoot, "big-hook");
    fs.mkdirSync(hookDir, { recursive: true });
    const hookMdPath = path.join(hookDir, "HOOK.md");
    fs.writeFileSync(hookMdPath, "x".repeat(METADATA_MAX_BYTES + 1), "utf8");
    fs.writeFileSync(path.join(hookDir, "handler.js"), "export default async () => {};\n");

    const entries = loadWorkspaceEntriesFromHooksRoot(hooksRoot);
    expect(hookNames(entries)).toHaveLength(0);
    expect(oversizedMetadataWarnings(hookMdPath)).toHaveLength(1);
  });

  it("continues discovering other hooks after skipping oversized metadata", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-hooks-oversized-mixed-"));
    const hooksRoot = path.join(root, "hooks");
    fs.mkdirSync(hooksRoot, { recursive: true });

    const bigHookDir = path.join(hooksRoot, "big-hook");
    fs.mkdirSync(bigHookDir, { recursive: true });
    const bigHookMdPath = path.join(bigHookDir, "HOOK.md");
    fs.writeFileSync(bigHookMdPath, "x".repeat(METADATA_MAX_BYTES + 1), "utf8");
    fs.writeFileSync(path.join(bigHookDir, "handler.js"), "export default async () => {};\n");

    const smallHookDir = path.join(hooksRoot, "small-hook");
    fs.mkdirSync(smallHookDir, { recursive: true });
    fs.writeFileSync(path.join(smallHookDir, "HOOK.md"), "---\nname: small-hook\n---\n");
    fs.writeFileSync(path.join(smallHookDir, "handler.js"), "export default async () => {};\n");

    const entries = loadWorkspaceEntriesFromHooksRoot(hooksRoot);
    expect(hookNames(entries)).toEqual(["small-hook"]);
    expect(oversizedMetadataWarnings(bigHookMdPath)).toHaveLength(1);
  });

  it("loads hooks whose metadata sits exactly at the byte limit", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-hooks-exact-limit-"));
    const hooksRoot = path.join(root, "hooks");
    fs.mkdirSync(hooksRoot, { recursive: true });

    const pkgDir = path.join(hooksRoot, "pkg");
    const nested = path.join(pkgDir, "nested");
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      exactSizeHookPackageManifest(METADATA_MAX_BYTES),
    );
    fs.writeFileSync(
      path.join(nested, "HOOK.md"),
      padToExactBytes("---\nname: exact-limit\n---\n", METADATA_MAX_BYTES),
    );
    fs.writeFileSync(path.join(nested, "handler.js"), "export default async () => {};\n");

    const entries = loadWorkspaceEntriesFromHooksRoot(hooksRoot);
    expect(hookNames(entries)).toContain("exact-limit");
    expect(warnMock).not.toHaveBeenCalled();
  });

  it("still loads a plain hook when its package.json is oversized", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-hooks-oversized-compat-"));
    const hooksRoot = path.join(root, "hooks");
    fs.mkdirSync(hooksRoot, { recursive: true });

    const hookDir = path.join(hooksRoot, "compat-hook");
    fs.mkdirSync(hookDir, { recursive: true });
    const manifestPath = path.join(hookDir, "package.json");
    fs.writeFileSync(manifestPath, "x".repeat(METADATA_MAX_BYTES + 1), "utf8");
    fs.writeFileSync(path.join(hookDir, "HOOK.md"), "---\nname: compat-hook\n---\n");
    fs.writeFileSync(path.join(hookDir, "handler.js"), "export default async () => {};\n");

    const entries = loadWorkspaceEntriesFromHooksRoot(hooksRoot);
    expect(hookNames(entries)).toContain("compat-hook");
    expect(oversizedMetadataWarnings(manifestPath)).toHaveLength(1);
  });

  it("ignores package.json hook paths that escape via symlink", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-hooks-workspace-link-"));
    const hooksRoot = path.join(root, "hooks");
    fs.mkdirSync(hooksRoot, { recursive: true });

    const pkgDir = path.join(hooksRoot, "pkg");
    const outsideDir = path.join(root, "outside");
    const linkedDir = path.join(pkgDir, "linked");
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(outsideDir, "HOOK.md"), "---\nname: outside\n---\n");
    fs.writeFileSync(path.join(outsideDir, "handler.js"), "export default async () => {};\n");
    try {
      fs.symlinkSync(outsideDir, linkedDir, process.platform === "win32" ? "junction" : "dir");
    } catch {
      return;
    }

    writeHookPackageManifest(pkgDir, ["./linked"]);

    const entries = loadWorkspaceEntriesFromHooksRoot(hooksRoot);
    expect(hookNames(entries)).not.toContain("outside");
  });

  it("ignores hooks with hardlinked HOOK.md aliases", () => {
    if (process.platform === "win32") {
      return;
    }

    const { hooksRoot, hookDir, outsideDir } = setupHardlinkHookWorkspace("hardlink-hook");
    fs.writeFileSync(path.join(hookDir, "handler.js"), "export default async () => {};\n");
    const outsideHookMd = path.join(outsideDir, "HOOK.md");
    const linkedHookMd = path.join(hookDir, "HOOK.md");
    fs.writeFileSync(linkedHookMd, "---\nname: hardlink-hook\n---\n");
    fs.rmSync(linkedHookMd);
    fs.writeFileSync(outsideHookMd, "---\nname: outside\n---\n");
    if (!tryCreateHardlinkOrSkip(() => fs.linkSync(outsideHookMd, linkedHookMd))) {
      return;
    }

    const entries = loadWorkspaceEntriesFromHooksRoot(hooksRoot);
    const names = hookNames(entries);
    expect(names).not.toContain("hardlink-hook");
    expect(names).not.toContain("outside");
  });

  it("ignores hooks with hardlinked handler aliases", () => {
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

    const entries = loadWorkspaceEntriesFromHooksRoot(hooksRoot);
    expect(hookNames(entries)).not.toContain("hardlink-handler-hook");
  });

  it("does not let workspace hooks override managed hooks with the same name", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-hooks-collision-"));
    const workspaceDir = path.join(root, "workspace");
    const managedHooksDir = path.join(root, "managed-hooks");
    const workspaceHookDir = path.join(workspaceDir, "hooks", "session-memory");
    const managedHookDir = path.join(managedHooksDir, "session-memory");
    fs.mkdirSync(workspaceHookDir, { recursive: true });
    fs.mkdirSync(managedHookDir, { recursive: true });

    for (const dir of [workspaceHookDir, managedHookDir]) {
      fs.writeFileSync(
        path.join(dir, "HOOK.md"),
        [
          "---",
          "name: session-memory",
          'metadata: {"openclaw":{"events":["command:new"]}}',
          "---",
        ].join("\n"),
      );
      fs.writeFileSync(path.join(dir, "handler.js"), "export default async () => {};\n");
    }

    const entries = loadWorkspaceHookEntries(workspaceDir, {
      managedHooksDir,
      bundledHooksDir: path.join(root, "bundled-none"),
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.hook.source).toBe("openclaw-managed");
  });

  it("treats configured extraDirs as managed hook sources", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-hooks-extra-"));
    const workspaceDir = path.join(root, "workspace");
    const extraHookDir = path.join(root, "shared-hooks", "shared-hook");
    fs.mkdirSync(extraHookDir, { recursive: true });
    fs.writeFileSync(
      path.join(extraHookDir, "HOOK.md"),
      ["---", "name: shared-hook", 'metadata: {"openclaw":{"events":["command:new"]}}', "---"].join(
        "\n",
      ),
    );
    fs.writeFileSync(path.join(extraHookDir, "handler.js"), "export default async () => {};\n");

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
