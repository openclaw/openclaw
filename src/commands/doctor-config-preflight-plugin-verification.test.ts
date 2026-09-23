import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { buildUpdateRehearsalPathEnv } from "../infra/update-rehearsal-paths.js";
import { readPersistedInstalledPluginIndexInstallRecords } from "../plugins/installed-plugin-index-records.js";
import { listOfficialExternalPluginCatalogEntries } from "../plugins/official-external-plugin-catalog.js";
import { createPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { createColdPluginFixture } from "../plugins/test-helpers/cold-plugin-fixtures.js";
import { seedInstalledPluginIndex } from "../plugins/test-helpers/installed-plugin-index.js";
import { runDoctorPluginConvergence } from "./doctor-config-preflight-plugin-verification.js";
import { runPostCorePluginConvergence } from "./doctor/shared/post-core-plugin-convergence.js";

const npmInstall = vi.hoisted(() =>
  vi.fn<typeof import("../plugins/install.js").installPluginFromNpmSpec>(() => {
    throw new Error("unselected plugin reached package installation");
  }),
);
vi.mock("../plugins/install.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/install.js")>()),
  installPluginFromNpmSpec: npmInstall,
}));
vi.mock("../plugins/clawhub.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/clawhub.js")>()),
  installPluginFromClawHub: () => {
    throw new Error("unselected plugin reached ClawHub installation");
  },
}));

describe("update canary plugin verification", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it("keeps an unavailable copied plugin nonblocking without fetching a replacement", async () => {
    npmInstall.mockClear();
    const root = tempDirs.make("openclaw-canary-plugin-");
    const env = {
      ...buildUpdateRehearsalPathEnv(root),
      OPENCLAW_UPDATE_IN_PROGRESS: "0",
      OPENCLAW_SERVICE_REPAIR_POLICY: "external",
      OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR: "0",
      OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION: "0",
    };
    const cfg = { plugins: { entries: { "canary-fixture": { enabled: true } } } };
    await seedInstalledPluginIndex(
      { "canary-fixture": { source: "npm", spec: "@example/canary-fixture" } },
      { config: cfg, env },
    );
    await withPluginCache(createPluginCache(), async () => {
      const result = await runDoctorPluginConvergence({ cfg, env });
      expect(npmInstall).not.toHaveBeenCalled();
      expect(result).toEqual({
        quarantinedPlugins: [
          {
            pluginId: "canary-fixture",
            state: "configured-unavailable",
            diagnostic: {
              kind: "plugin-verification",
              reason: "missing-install-path",
              detail: "Install path is missing from the plugin install record.",
            },
          },
        ],
        migrationInspection: {
          requiredPluginIds: [],
          inspectionRequiredPluginIds: [],
          statelessPluginIds: [],
          runtimePluginAliases: [],
        },
        deferredPlugins: [
          {
            pluginId: "canary-fixture",
            reason:
              "Package convergence must wait until the updating parent releases its install records.",
            command: "openclaw update repair",
          },
        ],
      });
    });
  });
});

describe.each(["startup", "repair"] as const)("%s consent inventory", (first) => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  afterEach(() => npmInstall.mockReset());

  async function converge(
    cfg: Parameters<typeof runDoctorPluginConvergence>[0]["cfg"],
    env: NodeJS.ProcessEnv,
  ) {
    if (first === "startup") {
      expect(await runDoctorPluginConvergence({ cfg, env })).toEqual({
        quarantinedPlugins: [],
      });
    } else {
      expect((await runPostCorePluginConvergence({ cfg, env })).warnings).toEqual([]);
    }
  }

  it.each([false, true])(
    "does not install catalog-only plugins or retained bundled records (retained=%s)",
    async (retained) => {
      npmInstall.mockClear();
      const home = tempDirs.make("openclaw-consent-inventory-");
      const bundledRoot = path.join(home, "bundled");
      const pluginId = "bundled-consent-fixture";
      const packageName = "@openclaw/bundled-consent-fixture";
      const rootDir = path.join(bundledRoot, pluginId);
      fs.mkdirSync(rootDir, { recursive: true });
      const fixture = createColdPluginFixture({ rootDir, pluginId, packageName });
      const env = {
        HOME: home,
        OPENCLAW_STATE_DIR: path.join(home, "state"),
        OPENCLAW_BUNDLED_PLUGINS_DIR: bundledRoot,
        OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
        VITEST: "true",
      };
      const cfg = { plugins: { allow: ["selected-fixture"] } };
      await withPluginCache(createPluginCache(), async () => {
        await seedInstalledPluginIndex(
          retained
            ? {
                [pluginId]: {
                  source: "npm",
                  spec: packageName,
                  resolvedName: packageName,
                  installPath: path.join(home, "missing-payload"),
                },
              }
            : {},
          { config: cfg, env },
        );
      });
      expect(listOfficialExternalPluginCatalogEntries().length).toBeGreaterThan(0);
      for (let start = 0; start < 2; start += 1) {
        await withPluginCache(createPluginCache(), async () => {
          await converge(cfg, env);
          const repair = await runPostCorePluginConvergence({ cfg, env });
          expect(repair.warnings).toEqual([]);
          expect(repair.installRecords).toEqual({});
        });
        // A completed lifecycle changes the next generation, not the invoking snapshot.
        const persisted = withPluginCache(createPluginCache(), () =>
          readPersistedInstalledPluginIndexInstallRecords({ env }),
        );
        expect(persisted).toEqual({});
      }
      expect(npmInstall).not.toHaveBeenCalled();
      expect(fs.existsSync(fixture.runtimeMarker)).toBe(false);
    },
  );

  it.each([
    {
      envVar: "OPENCODE_API_KEY",
      packages: {
        opencode: "@openclaw/opencode-provider",
        "opencode-go": "@openclaw/opencode-go-provider",
      },
    },
    { envVar: "OPENROUTER_API_KEY", packages: { perplexity: "@openclaw/perplexity-plugin" } },
  ])(
    "converges verified official packages selected only by $envVar",
    async ({ envVar, packages }) => {
      const home = tempDirs.make("openclaw-consent-env-");
      const bundledRoot = path.join(home, "bundled");
      fs.mkdirSync(bundledRoot, { recursive: true });
      const env = {
        HOME: home,
        OPENCLAW_STATE_DIR: path.join(home, "state"),
        OPENCLAW_BUNDLED_PLUGINS_DIR: bundledRoot,
        OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
        VITEST: "true",
        [envVar]: "synthetic-credential",
      };
      const cfg = { plugins: { allow: ["selected-fixture"] } };
      const runtimeMarkers: string[] = [];
      npmInstall.mockClear();
      npmInstall.mockImplementation(async (params) => {
        const pluginId = params.expectedPluginId;
        const packageName = Object.entries(packages).find(([id]) => id === pluginId)?.[1];
        if (!pluginId || !packageName) {
          throw new Error(`Unexpected plugin install: ${params.spec}`);
        }
        const rootDir = path.join(home, "installed", pluginId);
        fs.mkdirSync(rootDir, { recursive: true });
        const fixture = createColdPluginFixture({
          rootDir,
          pluginId,
          packageName,
          providerId: pluginId,
          manifest: { channels: [], channelConfigs: {}, providerAuthChoices: [] },
        });
        runtimeMarkers.push(fixture.runtimeMarker);
        const npmResolution = {
          name: packageName,
          version: "1.0.0",
          resolvedSpec: `${packageName}@1.0.0`,
          integrity: "sha512-synthetic-fixture",
        };
        await params.onBeforePluginArtifactCommit?.({
          pluginId,
          stagedArtifactDir: rootDir,
          mode: "install",
          sourceRecord: {
            source: "npm",
            spec: params.spec,
            resolvedName: packageName,
            resolvedSpec: npmResolution.resolvedSpec,
          },
        });
        return {
          ok: true,
          pluginId,
          targetDir: rootDir,
          version: "1.0.0",
          extensions: ["./index.cjs"],
          npmResolution,
        };
      });
      await withPluginCache(createPluginCache(), async () => {
        await converge(cfg, env);
      });
      await withPluginCache(createPluginCache(), async () => {
        const repair = await runPostCorePluginConvergence({ cfg, env });
        expect(repair.warnings).toEqual([]);
        expect(Object.keys(repair.installRecords).toSorted()).toEqual(
          Object.keys(packages).toSorted(),
        );
        for (const [pluginId, packageName] of Object.entries(packages)) {
          expect(repair.installRecords[pluginId]).toMatchObject({
            source: "npm",
            resolvedName: packageName,
          });
          expect(repair.installRecords[pluginId]?.acceptedSurface).toBeUndefined();
        }
      });
      expect(npmInstall).toHaveBeenCalledTimes(Object.keys(packages).length);
      expect(runtimeMarkers.some((marker) => fs.existsSync(marker))).toBe(false);
    },
  );
});
