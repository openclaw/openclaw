import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { PLUGIN_CAPABILITY_CONSENT_REQUIRED } from "../../packages/gateway-protocol/src/capability-consent-error-details.js";
import { resolvePluginArtifactDeclaredSurface } from "./capability-artifact.js";
import { computeDeclaredSurfaceHash } from "./capability-summary.js";
import type { PluginInstallArtifactConsentHandler } from "./install-types.js";
import { writeArtifacts } from "./public-surface.test-support.js";
import { makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";
import { singleInstallConfig } from "./update-authority.test-support.js";
import { syncPluginsForUpdateChannel } from "./update-channel.js";

const installers = vi.hoisted(() => ({ npm: vi.fn(), clawhub: vi.fn() }));
vi.mock("./install.js", () => ({ installPluginFromNpmSpec: installers.npm }));
vi.mock("./clawhub.js", () => ({
  installPluginFromClawHub: installers.clawhub,
  CLAWHUB_INSTALL_ERROR_CODE: { PACKAGE_NOT_FOUND: "package_not_found" },
}));
vi.mock("./bundled-sources.js", () => ({ resolveBundledPluginSources: () => new Map() }));

const tempDirs: string[] = [];
afterEach(() => {
  vi.resetAllMocks();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it.each([
  { source: "npm", review: "absent" },
  { source: "npm", review: "accept" },
  { source: "npm", review: "stale" },
  { source: "npm", review: "replaced" },
  { source: "npm", review: "throw" },
  { source: "clawhub", review: "absent" },
  { source: "clawhub", review: "accept" },
  { source: "fallback", review: "absent" },
  { source: "fallback", review: "accept" },
] as const)(
  "$source with $review consent protects payload and acceptance",
  async ({ source, review }) => {
    const root = makeTrackedTempDir("openclaw-channel-consent", tempDirs);
    const pluginId = "channel-consent-fixture";
    const packageName = `@openclaw/${pluginId}`;
    const installedDir = path.join(root, "extensions", pluginId);
    const stagedDir = path.join(root, "stage");
    function writeArtifact(dir: string, version: string, providers: string[]) {
      writeArtifacts(dir, {
        "package.json": { name: packageName, version, openclaw: { extensions: ["./index.js"] } },
        "index.js": `export default () => ${JSON.stringify(version)};`,
        "openclaw.plugin.json": {
          id: pluginId,
          providers,
          kind: "context-engine",
          contextEngineIds: [`engine-${version}`],
          configSchema: { type: "object" },
        },
      });
    }
    writeArtifact(installedDir, "1.0.0", ["existing-provider"]);
    writeArtifact(stagedDir, "2.0.0", ["existing-provider", "new-provider"]);
    const env = {
      ...process.env,
      OPENCLAW_STATE_DIR: path.join(root, "state"),
      HOME: root,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_DISABLE_BUNDLED_SOURCE_OVERLAYS: "1",
    };
    const previousSurface = resolvePluginArtifactDeclaredSurface(installedDir, env);
    const config = singleInstallConfig(
      pluginId,
      {
        source: "path",
        sourcePath: installedDir,
        installPath: installedDir,
        version: "1.0.0",
        integrity: "sha512-previous",
        acceptedSurface: previousSurface,
        acceptedSurfaceHash: computeDeclaredSurfaceHash(previousSurface),
        acceptedSurfaceIntegrity: "sha512-previous",
        acceptedSurfaceAt: "2026-01-01T00:00:00.000Z",
      },
      { entries: { [pluginId]: { enabled: true } }, load: { paths: [installedDir] } },
    );
    const originalConfig = structuredClone(config);
    const oldBytes = fs.readFileSync(path.join(installedDir, "index.js"), "utf8");
    const install = async (options: {
      onBeforePluginArtifactCommit?: PluginInstallArtifactConsentHandler;
    }) => {
      await options.onBeforePluginArtifactCommit?.({
        pluginId,
        stagedArtifactDir: stagedDir,
        currentArtifactDir: installedDir,
        mode: "update",
      });
      fs.cpSync(stagedDir, installedDir, { recursive: true });
      return {
        ok: true as const,
        pluginId,
        targetDir: installedDir,
        version: "2.0.0",
        npmResolution: {
          name: packageName,
          version: "2.0.0",
          resolvedSpec: `${packageName}@2.0.0`,
          integrity: "sha512-next",
        },
        clawhub: {
          source: "clawhub" as const,
          clawhubUrl: "https://clawhub.ai",
          clawhubPackage: pluginId,
          clawhubFamily: "code-plugin" as const,
          integrity: "sha256-next",
        },
      };
    };
    installers.npm.mockImplementation(install);
    installers.clawhub.mockImplementation(install);
    if (source === "fallback") {
      installers.npm.mockResolvedValueOnce({
        ok: false,
        code: "npm_package_not_found",
        error: "not found",
      });
    }
    const callbackError = new Error("operator review failed");
    const onCapabilityConsent = vi.fn(async (details: { reviewToken: string }) => {
      if (review === "throw") {
        throw callbackError;
      }
      if (review === "replaced") {
        writeArtifact(stagedDir, "2.0.0", [
          "existing-provider",
          "new-provider",
          "unreviewed-provider",
        ]);
      }
      return { reviewToken: review === "stale" ? "stale-token" : details.reviewToken };
    });
    const operation = syncPluginsForUpdateChannel({
      config,
      env,
      channel: "stable",
      externalizedBundledPluginBridges: [
        {
          bundledPluginId: pluginId,
          npmSpec: source === "clawhub" ? undefined : packageName,
          clawhubSpec: `clawhub:${pluginId}`,
        },
      ],
      onCapabilityConsent: review === "absent" ? undefined : onCapabilityConsent,
    });
    if (review === "throw") {
      await expect(operation).rejects.toBe(callbackError);
    } else {
      const result = await operation;
      expect(result.changed).toBe(review === "accept");
      if (review === "accept") {
        const declared = resolvePluginArtifactDeclaredSurface(installedDir, env);
        expect(declared.providers).toEqual(["existing-provider", "new-provider"]);
        expect(result.config.plugins?.installs?.[pluginId]).toMatchObject({
          version: "2.0.0",
          contextEngineIdsByPlugin: { [pluginId]: ["engine-2.0.0"] },
          acceptedSurface: declared,
          acceptedSurfaceHash: computeDeclaredSurfaceHash(declared),
          acceptedSurfaceIntegrity: source === "npm" ? "sha512-next" : "sha256-next",
        });
        expect(result.summary.errors).toEqual([]);
      } else {
        expect(result.config).toEqual(originalConfig);
        expect(result.summary.errors).toEqual([
          expect.objectContaining({ pluginId, code: PLUGIN_CAPABILITY_CONSENT_REQUIRED }),
        ]);
        const message = result.summary.errors[0]?.message;
        expect(message).not.toContain("payload is missing");
        expect(message).toContain("did not install the replacement plugin payload");
        expect(message).toContain("openclaw update repair");
        if (source !== "npm") {
          expect(message).toContain(`(ClawHub clawhub:${pluginId}).`);
        }
      }
    }
    expect(config).toEqual(originalConfig);
    if (review !== "accept") {
      expect(fs.readFileSync(path.join(installedDir, "index.js"), "utf8")).toBe(oldBytes);
    }
    if (review !== "absent") {
      expect(onCapabilityConsent).toHaveBeenCalledOnce();
    }
    if (source === "clawhub") {
      expect(installers.npm).not.toHaveBeenCalled();
    }
  },
);
