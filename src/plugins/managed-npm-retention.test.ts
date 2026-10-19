import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  resolvePluginNpmGenerationProjectDir,
  resolvePluginNpmProjectDir,
} from "./install-paths.js";
import { RETAINED_MANAGED_NPM_KEEP_FILES_REASON } from "./managed-npm-retention-contract.js";
import {
  clearRetainedManagedNpmInstallMarker,
  cleanupRetainedManagedNpmInstallGenerations,
  hasRetainedManagedNpmInstallMarker,
  markRetainedManagedNpmInstall,
  resolveRetainedManagedNpmInstallMarkerPath,
} from "./managed-npm-retention.js";

const retentionTempDirs = useAutoCleanupTempDirTracker(afterEach);
const makeNpmDir = () => path.join(retentionTempDirs.make("openclaw-retention-"), "npm");

function makePackage(projectRoot = makeNpmDir(), name = "retained-plugin") {
  const packageDir = path.join(projectRoot, "node_modules", name);
  fs.mkdirSync(packageDir, { recursive: true });
  return packageDir;
}

const mark = (packageDir: string, reason = "test-retired-generation", pluginId = "codex") =>
  markRetainedManagedNpmInstall({ packageDir, pluginId, reason });
const generation = (npmDir: string, generationKey: string, packageName = "@openclaw/codex") =>
  resolvePluginNpmGenerationProjectDir({ npmDir, packageName, generationKey });

it.each(["stat", "mkdir"] as const)(
  "fences marker creation after authority is revoked during %s",
  async (preparation) => {
    const packageDir = makePackage();
    const markerPath = resolveRetainedManagedNpmInstallMarkerPath(packageDir);
    const markerDir = path.dirname(markerPath);
    const previous = '{"reason":"existing-retention"}\n';
    if (preparation === "mkdir") {
      fs.mkdirSync(markerDir);
      fs.writeFileSync(markerPath, previous);
    }
    let current = true;
    const failure = new Error("update authority revoked");
    const mkdir = fs.promises.mkdir.bind(fs.promises);
    const mkdirSpy = vi.spyOn(fs.promises, "mkdir").mockImplementation(async (target, options) => {
      const result = await mkdir(target, options);
      if (preparation === "mkdir") {
        current = false;
      }
      return result;
    });
    try {
      const operation = markRetainedManagedNpmInstall({
        packageDir,
        pluginId: "retained-plugin",
        reason: "replaced-by-update",
        assertCurrent: () => {
          if (!current) {
            throw failure;
          }
        },
      });
      if (preparation === "stat") {
        current = false;
      }
      await expect(operation).rejects.toBe(failure);
      expect(fs.existsSync(packageDir)).toBe(true);
      if (preparation === "mkdir") {
        expect(fs.readFileSync(markerPath, "utf8")).toBe(previous);
      } else {
        expect(fs.existsSync(markerDir)).toBe(false);
      }
    } finally {
      mkdirSpy.mockRestore();
    }
  },
);

it.each(["before", "after"])("preserves a one-shot refusal %s marker removal", async (phase) => {
  const packageDir = makePackage();
  await mark(packageDir, "retained-package", "retained-plugin");
  const markerPath = resolveRetainedManagedNpmInstallMarkerPath(packageDir);
  const before = fs.readFileSync(markerPath, "utf8");
  const failure = Object.assign(
    new Error("update authority revoked"),
    phase === "before" ? { code: "ENOENT" } : {},
  );
  let revoked = phase === "before";
  const rm = fs.promises.rm.bind(fs.promises);
  const rmSpy =
    phase === "after"
      ? vi.spyOn(fs.promises, "rm").mockImplementation(async (target, options) => {
          await rm(target, options);
          revoked = true;
        })
      : undefined;
  try {
    await expect(
      clearRetainedManagedNpmInstallMarker(packageDir, () => {
        if (revoked) {
          revoked = false;
          throw failure;
        }
      }),
    ).rejects.toBe(failure);
    if (phase === "before") {
      expect(fs.readFileSync(markerPath, "utf8")).toBe(before);
      await expect(clearRetainedManagedNpmInstallMarker(packageDir)).resolves.toBe(true);
    }
    expect(fs.existsSync(markerPath)).toBe(false);
    if (phase === "after") {
      expect(fs.existsSync(path.dirname(markerPath))).toBe(true);
    }
    expect(fs.existsSync(packageDir)).toBe(true);
  } finally {
    rmSpy?.mockRestore();
  }
});

it.each(["ordinary", "generation", "legacy"] as const)(
  "cleans a retired %s project while preserving the active install root",
  async (layout) => {
    const npmDir = makeNpmDir();
    const packageName = "@openclaw/codex";
    const oldProjectRoot =
      layout === "legacy"
        ? npmDir
        : layout === "ordinary"
          ? resolvePluginNpmProjectDir({ npmDir, packageName })
          : generation(npmDir, "codex-v1");
    const activeProjectRoot = generation(npmDir, "codex-v2");
    const oldPackageDir = makePackage(oldProjectRoot, packageName);
    const activePackageDir =
      layout === "legacy" ? undefined : makePackage(activeProjectRoot, packageName);
    await mark(
      oldPackageDir,
      layout === "legacy" ? "test-legacy-generation" : "test-retired-generation",
    );

    const refused = new Error("cleanup lease was replaced");
    const onError = vi.fn();
    const options = {
      npmDir,
      ...(activePackageDir ? { activeInstallPaths: [activePackageDir], onError } : {}),
    };
    await expect(
      cleanupRetainedManagedNpmInstallGenerations({
        ...options,
        assertCurrent: async () => {
          await Promise.resolve();
          throw refused;
        },
      }),
    ).resolves.toBe(0);
    expect(fs.existsSync(oldProjectRoot)).toBe(true);
    if (activePackageDir) {
      expect(onError).toHaveBeenCalledWith(refused, oldProjectRoot);
    }
    expect(fs.existsSync(oldPackageDir)).toBe(true);
    expect(hasRetainedManagedNpmInstallMarker(oldPackageDir)).toBe(true);
    await expect(cleanupRetainedManagedNpmInstallGenerations(options)).resolves.toBe(1);
    expect(fs.existsSync(oldPackageDir)).toBe(false);
    expect(hasRetainedManagedNpmInstallMarker(oldPackageDir)).toBe(false);
    if (activePackageDir) {
      expect(fs.existsSync(oldProjectRoot)).toBe(false);
      expect(fs.existsSync(activeProjectRoot)).toBe(true);
      expect(hasRetainedManagedNpmInstallMarker(activePackageDir)).toBe(false);
    }
  },
);

it.each(["noncanonical", "symlink"])(
  "preserves retained packages under a %s projects root",
  async (layout) => {
    const npmDir = makeNpmDir();
    fs.mkdirSync(npmDir, { recursive: true });
    if (layout === "symlink") {
      const outside = retentionTempDirs.make("openclaw-retention-outside-");
      fs.symlinkSync(outside, path.join(npmDir, "projects"), "dir");
    }
    const projectRoot =
      layout === "noncanonical"
        ? path.join(npmDir, "projects", "noncanonical-sibling")
        : resolvePluginNpmProjectDir({ npmDir, packageName: "@openclaw/codex" });
    const packageDir = makePackage(projectRoot, "@openclaw/codex");
    const siblingFile = path.join(projectRoot, "must-remain.txt");
    fs.writeFileSync(siblingFile, "preserve me", "utf8");
    await mark(packageDir);

    await expect(cleanupRetainedManagedNpmInstallGenerations({ npmDir })).resolves.toBe(0);
    expect(fs.readFileSync(siblingFile, "utf8")).toBe("preserve me");
  },
);

it.each(["project", "legacy"] as const)(
  "preserves %s packages retained by an explicit keep-files uninstall",
  async (layout) => {
    const npmDir = makeNpmDir();
    const projectRoot =
      layout === "legacy" ? npmDir : generation(npmDir, "kept-plugin-v1", "@openclaw/kept-plugin");
    const packageDir = makePackage(projectRoot, "@openclaw/kept-plugin");
    await mark(packageDir, RETAINED_MANAGED_NPM_KEEP_FILES_REASON, "kept-plugin");

    await expect(cleanupRetainedManagedNpmInstallGenerations({ npmDir })).resolves.toBe(0);
    expect(fs.existsSync(packageDir)).toBe(true);
    expect(hasRetainedManagedNpmInstallMarker(packageDir)).toBe(true);
  },
);
