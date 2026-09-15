// Covers plugin install path validation and normalization.
import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { createManagedPluginArtifactConsentHandler } from "./capability-consent.js";
import { buildPluginCapabilitySummary, computeDeclaredSurfaceHash } from "./capability-summary.js";
import { installPluginFromPath, PLUGIN_INSTALL_ERROR_CODE } from "./install.js";
import { packToArchive } from "./test-helpers/archive-fixtures.js";
import { createSyncSuiteTempRootTracker } from "./test-helpers/fs-fixtures.js";
import { createBundleInstallFixtureFactory } from "./test-helpers/install-fixtures.js";

const suiteTempRootTracker = createSyncSuiteTempRootTracker("openclaw-plugin-install-path");
const setupBundleInstallFixture = createBundleInstallFixtureFactory(
  suiteTempRootTracker.makeTempDir,
);

function setupNativePluginInstallFixture(
  params: { packageName?: string; pluginId?: string; marker?: string } = {},
) {
  const caseDir = suiteTempRootTracker.makeTempDir();
  const stateDir = path.join(caseDir, "state");
  const pluginDir = path.join(caseDir, "plugin-src");
  const packageName = params.packageName ?? "symlink-plugin";
  const pluginId = params.pluginId ?? "symlink-plugin";
  fs.mkdirSync(path.join(pluginDir, "dist"), { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, "package.json"),
    JSON.stringify({
      name: packageName,
      version: "1.0.0",
      openclaw: { extensions: ["./dist/index.js"] },
    }),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: pluginId,
      configSchema: { type: "object", properties: {} },
    }),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(pluginDir, "dist", "index.js"),
    `export const marker = ${JSON.stringify(params.marker ?? "initial")};\n`,
    "utf-8",
  );
  return { caseDir, pluginDir, extensionsDir: path.join(stateDir, "extensions") };
}

afterAll(() => {
  suiteTempRootTracker.cleanup();
});

describe("installPluginFromPath", () => {
  it.each([
    { accepted: true, expectedInstalled: true },
    { accepted: false, expectedInstalled: false },
  ])(
    "commits an official Claw-managed artifact only after owner review (accepted=$accepted)",
    async ({ accepted, expectedInstalled }) => {
      const { pluginDir, extensionsDir } = setupNativePluginInstallFixture({
        packageName: "@openclaw/diffs",
        pluginId: "diffs",
      });
      const archivePath = await packToArchive({
        pkgDir: pluginDir,
        outDir: suiteTempRootTracker.makeTempDir(),
        outName: "official-diffs.tgz",
      });
      const consent = createManagedPluginArtifactConsentHandler({
        config: { plugins: { entries: { diffs: { enabled: true } } } },
        source: "npm",
        requireCapabilityConsent: true,
        onCapabilityConsent: async (review) =>
          accepted ? { reviewToken: review.reviewToken } : undefined,
      });
      const sourceRecord: PluginInstallRecord = {
        source: "npm",
        spec: "@openclaw/diffs@1.0.0",
        resolvedName: "@openclaw/diffs",
        resolvedSpec: "@openclaw/diffs@1.0.0",
      };

      const result = await installPluginFromPath({
        path: archivePath,
        extensionsDir,
        onBeforePluginArtifactCommit: async (artifact) =>
          consent.onBeforePluginArtifactCommit({ ...artifact, sourceRecord }),
      }).catch((error: unknown) => error);

      expect(fs.existsSync(path.join(extensionsDir, "diffs"))).toBe(expectedInstalled);
      if (accepted) {
        expect(result).toMatchObject({ ok: true, pluginId: "diffs" });
      } else {
        expect(result).toMatchObject({ capabilityConsent: { pluginId: "diffs" } });
      }
    },
  );

  it("preserves an installed artifact when Claw review revokes prior acceptance", async () => {
    const initial = setupNativePluginInstallFixture({
      packageName: "@openclaw/diffs",
      pluginId: "diffs",
      marker: "accepted",
    });
    const initialArchive = await packToArchive({
      pkgDir: initial.pluginDir,
      outDir: suiteTempRootTracker.makeTempDir(),
      outName: "accepted-diffs.tgz",
    });
    const installed = await installPluginFromPath({
      path: initialArchive,
      extensionsDir: initial.extensionsDir,
    });
    expect(installed.ok).toBe(true);
    if (!installed.ok) {
      return;
    }
    const declared = buildPluginCapabilitySummary({
      manifest: { id: "diffs" },
      origin: "global",
    }).declared;
    const priorRecord: PluginInstallRecord = {
      source: "npm",
      installPath: installed.targetDir,
      integrity: "sha512-prior",
      acceptedSurface: declared,
      acceptedSurfaceHash: computeDeclaredSurfaceHash(declared),
      acceptedSurfaceIntegrity: "sha512-prior",
    };
    const replacement = setupNativePluginInstallFixture({
      packageName: "@openclaw/diffs",
      pluginId: "diffs",
      marker: "replacement",
    });
    const replacementArchive = await packToArchive({
      pkgDir: replacement.pluginDir,
      outDir: suiteTempRootTracker.makeTempDir(),
      outName: "replacement-diffs.tgz",
    });
    const consent = createManagedPluginArtifactConsentHandler({
      config: { plugins: { entries: { diffs: { enabled: true } } } },
      source: "npm",
      previousRecords: { diffs: priorRecord },
      requireCapabilityConsent: true,
      onCapabilityConsent: async () => undefined,
    });

    const result = await installPluginFromPath({
      path: replacementArchive,
      extensionsDir: initial.extensionsDir,
      mode: "update",
      onBeforePluginArtifactCommit: consent.onBeforePluginArtifactCommit,
    }).catch((error: unknown) => error);

    expect(result).toMatchObject({ capabilityConsent: { pluginId: "diffs" } });
    expect(fs.readFileSync(path.join(installed.targetDir, "dist", "index.js"), "utf-8")).toContain(
      '"accepted"',
    );
    expect(priorRecord).not.toHaveProperty("updatedAt");
  });

  it.each(["native plugin", "bundle"] as const)(
    "does not publish an archived %s after authority closes during artifact review",
    async (kind) => {
      const { pluginDir, extensionsDir } =
        kind === "native plugin"
          ? setupNativePluginInstallFixture()
          : setupBundleInstallFixture({ bundleFormat: "claude", name: "Guarded Bundle" });
      const pluginId = kind === "native plugin" ? "symlink-plugin" : "guarded-bundle";
      const archivePath = await packToArchive({
        pkgDir: pluginDir,
        outDir: suiteTempRootTracker.makeTempDir(),
        outName: "guarded-plugin.tgz",
      });
      let authorityActive = true;
      const result = await installPluginFromPath({
        path: archivePath,
        extensionsDir,
        onBeforePluginArtifactCommit: async () => {
          authorityActive = false;
        },
        beforePersistentApply: () => {
          if (!authorityActive) {
            throw new Error("plugin installation authority closed");
          }
        },
      });

      expect(authorityActive).toBe(false);
      expect(result).toMatchObject({
        ok: false,
        error: expect.stringContaining("plugin installation authority closed"),
      });
      expect(fs.existsSync(path.join(extensionsDir, pluginId))).toBe(false);
    },
  );

  it("rejects managed plain file plugin installs through path install", async () => {
    const baseDir = suiteTempRootTracker.makeTempDir();
    const extensionsDir = path.join(baseDir, "extensions");
    fs.mkdirSync(extensionsDir, { recursive: true });

    const sourcePath = path.join(baseDir, "payload.js");
    fs.writeFileSync(sourcePath, "console.log('SAFE');\n", "utf-8");

    const result = await installPluginFromPath({
      path: sourcePath,
      extensionsDir,
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.code).toBe(PLUGIN_INSTALL_ERROR_CODE.UNSUPPORTED_PLAIN_FILE_PLUGIN);
    expect(result.error).toBe(
      "Plain file plugin installs are not supported. Install a plugin directory or archive that contains openclaw.plugin.json, or list standalone plugin files in plugins.load.paths.",
    );
  });

  it.runIf(process.platform !== "win32")(
    "installs local plugin directories when the managed extensions root is a symlink",
    async () => {
      const { caseDir, pluginDir, extensionsDir } = setupNativePluginInstallFixture();
      const realExtensionsDir = path.join(caseDir, "data", "extensions");
      fs.mkdirSync(realExtensionsDir, { recursive: true });
      fs.mkdirSync(path.dirname(extensionsDir), { recursive: true });
      fs.symlinkSync(realExtensionsDir, extensionsDir, "dir");

      const result = await installPluginFromPath({
        path: pluginDir,
        extensionsDir,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.targetDir).toBe(path.join(extensionsDir, "symlink-plugin"));
      expect(fs.existsSync(path.join(realExtensionsDir, "symlink-plugin", "package.json"))).toBe(
        true,
      );
    },
  );

  it.each([
    {
      format: "agent" as const,
      name: "Portable Sample",
      pluginId: "portable-sample",
      archiveName: "agent-bundle.tgz",
      manifestPath: "plugin.json",
    },
    {
      format: "claude" as const,
      name: "Claude Sample",
      pluginId: "claude-sample",
      archiveName: "claude-bundle.tgz",
      manifestPath: path.join(".claude-plugin", "plugin.json"),
    },
  ])(
    "installs $format bundles from an archive path",
    async ({ format, name, pluginId, archiveName, manifestPath }) => {
      const { pluginDir, extensionsDir } = setupBundleInstallFixture({
        bundleFormat: format,
        name,
      });
      const archivePath = path.join(suiteTempRootTracker.makeTempDir(), archiveName);

      await packToArchive({
        pkgDir: pluginDir,
        outDir: path.dirname(archivePath),
        outName: path.basename(archivePath),
      });

      const result = await installPluginFromPath({
        path: archivePath,
        extensionsDir,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.pluginId).toBe(pluginId);
      expect(fs.existsSync(path.join(result.targetDir, manifestPath))).toBe(true);
    },
  );
});
