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
  clearRetainedManagedNpmInstallMarker as clearMarker,
  cleanupRetainedManagedNpmInstallGenerations as cleanupGenerations,
  hasRetainedManagedNpmInstallMarker as hasMarker,
  markRetainedManagedNpmInstall as markRetention,
  resolveRetainedManagedNpmInstallMarkerPath as markerPathFor,
} from "./managed-npm-retention.js";

const retentionTempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());
const makeNpmDir = () => path.join(retentionTempDirs.make("openclaw-retention-"), "npm");

function makePackage(projectRoot = makeNpmDir(), name = "retained-plugin") {
  const packageDir = path.join(projectRoot, "node_modules", name);
  fs.mkdirSync(packageDir, { recursive: true });
  return packageDir;
}

const mark = (packageDir: string, reason = "test-retired-generation", pluginId = "codex") =>
  markRetention({ packageDir, pluginId, reason });
const generation = (npmDir: string, generationKey: string, packageName = "@openclaw/codex") =>
  resolvePluginNpmGenerationProjectDir({ npmDir, packageName, generationKey });

it.each(["stat", "mkdir"] as const)(
  "fences marker writes after %s revokes authority",
  async (preparation) => {
    const packageDir = makePackage();
    const markerPath = markerPathFor(packageDir);
    const markerDir = path.dirname(markerPath);
    const previous = '{"reason":"existing-retention"}\n';
    if (preparation === "mkdir") {
      fs.mkdirSync(markerDir);
      fs.writeFileSync(markerPath, previous);
    }
    let current = true;
    const failure = new Error("update authority revoked");
    const mkdir = fs.promises.mkdir.bind(fs.promises);
    vi.spyOn(fs.promises, "mkdir").mockImplementation(async (target, options) => {
      const result = await mkdir(target, options);
      if (preparation === "mkdir") {
        current = false;
      }
      return result;
    });
    const operation = markRetention({
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
  },
);

it.each(["before", "after"])("preserves one-shot refusals %s removal", async (phase) => {
  const packageDir = makePackage();
  await mark(packageDir, "retained-package", "retained-plugin");
  const markerPath = markerPathFor(packageDir);
  const before = fs.readFileSync(markerPath, "utf8");
  const failure = Object.assign(
    new Error("update authority revoked"),
    phase === "before" ? { code: "ENOENT" } : {},
  );
  let revoked = phase === "before";
  const rm = fs.promises.rm.bind(fs.promises);
  if (phase === "after") {
    vi.spyOn(fs.promises, "rm").mockImplementation(async (target, options) => {
      await rm(target, options);
      revoked = true;
    });
  }
  await expect(
    clearMarker(packageDir, () => {
      if (revoked) {
        revoked = false;
        throw failure;
      }
    }),
  ).rejects.toBe(failure);
  if (phase === "before") {
    expect(fs.readFileSync(markerPath, "utf8")).toBe(before);
    await expect(clearMarker(packageDir)).resolves.toBe(true);
  }
  expect(fs.existsSync(markerPath)).toBe(false);
  if (phase === "after") {
    expect(fs.existsSync(path.dirname(markerPath))).toBe(true);
  }
  expect(fs.existsSync(packageDir)).toBe(true);
});

it.each(["ordinary", "generation", "legacy"] as const)(
  "cleans retired %s installs but preserves active installs",
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
    await mark(oldPackageDir);

    const refused = new Error("cleanup lease was replaced");
    const onError = vi.fn();
    const options = {
      npmDir,
      ...(activePackageDir ? { activeInstallPaths: [activePackageDir], onError } : {}),
    };
    await expect(
      cleanupGenerations({
        ...options,
        assertCurrent: async () => {
          await Promise.resolve();
          throw refused;
        },
      }),
    ).resolves.toBe(0);
    if (activePackageDir) {
      expect(onError).toHaveBeenCalledWith(refused, oldProjectRoot);
    }
    expect(fs.existsSync(oldPackageDir)).toBe(true);
    expect(hasMarker(oldPackageDir)).toBe(true);
    await expect(cleanupGenerations(options)).resolves.toBe(1);
    if (activePackageDir) {
      expect(fs.existsSync(oldProjectRoot)).toBe(false);
      expect(fs.existsSync(activeProjectRoot)).toBe(true);
    } else {
      expect(fs.existsSync(oldPackageDir)).toBe(false);
      expect(hasMarker(oldPackageDir)).toBe(false);
    }
  },
);

it.each(["noncanonical", "symlink"])("rejects cleanup through %s project roots", async (layout) => {
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

  await expect(cleanupGenerations({ npmDir })).resolves.toBe(0);
  expect(fs.readFileSync(siblingFile, "utf8")).toBe("preserve me");
});

it.each(["project", "legacy"] as const)("preserves %s keep-files installs", async (layout) => {
  const npmDir = makeNpmDir();
  const projectRoot =
    layout === "legacy" ? npmDir : generation(npmDir, "kept-plugin-v1", "@openclaw/kept-plugin");
  const packageDir = makePackage(projectRoot, "@openclaw/kept-plugin");
  await mark(packageDir, RETAINED_MANAGED_NPM_KEEP_FILES_REASON, "kept-plugin");

  await expect(cleanupGenerations({ npmDir })).resolves.toBe(0);
  expect(fs.existsSync(packageDir)).toBe(true);
  expect(hasMarker(packageDir)).toBe(true);
});
