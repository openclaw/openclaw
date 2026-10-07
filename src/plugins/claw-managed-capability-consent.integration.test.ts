import fs from "node:fs/promises";
import path from "node:path";
import { stableStringify } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { bindClawPluginBeforeCommit } from "../claws/package-plugin-before-commit.js";
import { inspectClawPluginCapabilities } from "../claws/plugin-capability-probe.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createClawHubArchiveFactory } from "./clawhub.test-support.js";
import { resolveDefaultPluginExtensionsDir } from "./install-paths.js";
import { readPersistedInstalledPluginIndexInstallRecords } from "./installed-plugin-index-records.js";
import { installManagedPlugin } from "./management-mutations.js";

const clawhub = vi.hoisted(() => ({
  detail: vi.fn(),
  artifact: vi.fn(),
  download: vi.fn(),
  officialCatalog: vi.fn(async () => ({ source: "hosted" as const, entries: [] })),
}));

vi.mock("../infra/clawhub-packages.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/clawhub-packages.js")>()),
  fetchClawHubPackageDetail: clawhub.detail,
  fetchClawHubPackageArtifact: clawhub.artifact,
}));
vi.mock("../infra/clawhub-artifacts.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/clawhub-artifacts.js")>()),
  downloadClawHubPackageArchive: clawhub.download,
}));
vi.mock("./official-external-plugin-catalog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./official-external-plugin-catalog.js")>()),
  loadConfiguredHostedOfficialExternalPluginCatalogEntries: clawhub.officialCatalog,
}));

const dirs = useAutoCleanupTempDirTracker(afterEach);
const createClawHubArchive = createClawHubArchiveFactory(afterEach);
afterEach(() => closeOpenClawStateDatabaseForTest());

async function writePluginSource(root: string, tool: string): Promise<string> {
  const sourceDir = path.join(root, "source");
  await fs.mkdir(sourceDir, { recursive: true });
  await fs.writeFile(
    path.join(sourceDir, "package.json"),
    JSON.stringify({
      name: "@example/claw-audit",
      version: "1.0.0",
      openclaw: { extensions: ["./index.js"] },
    }),
  );
  await fs.writeFile(
    path.join(sourceDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: "claw-audit",
      contracts: { tools: [tool] },
      configSchema: { type: "object" },
    }),
  );
  await fs.writeFile(path.join(sourceDir, "index.js"), "export {};\n");
  return sourceDir;
}

async function findStagedPluginArtifactDir(env: NodeJS.ProcessEnv): Promise<string> {
  const extensionsDir = resolveDefaultPluginExtensionsDir(env);
  const stages = (await fs.readdir(extensionsDir)).filter((entry) =>
    entry.startsWith(".openclaw-install-stage-"),
  );
  if (stages.length !== 1) {
    throw new Error(`Expected one staged plugin artifact, found ${stages.length}.`);
  }
  return path.join(extensionsDir, stages[0]!);
}

describe("Claw-managed plugin capability consent", () => {
  it("denies an official ClawHub plugin before artifact and record commit, then installs after review", async () => {
    const root = dirs.make("openclaw-official-claw-plugin-consent-");
    const archive = await createClawHubArchive({
      "package.json": JSON.stringify({
        name: "@openclaw/diffs",
        version: "1.0.0",
        openclaw: { extensions: ["./index.js"] },
      }),
      "openclaw.plugin.json": JSON.stringify({
        id: "diffs",
        contracts: { tools: ["audit.read"] },
        configSchema: { type: "object" },
      }),
      "index.js": "export {};\n",
    });
    clawhub.detail.mockResolvedValue({
      package: {
        name: "@openclaw/diffs",
        displayName: "Diffs",
        family: "code-plugin",
        channel: "official",
        isOfficial: true,
        runtimeId: "diffs",
        latestVersion: "1.0.0",
        createdAt: 0,
        updatedAt: 0,
      },
    });
    clawhub.artifact.mockResolvedValue({
      version: { version: "1.0.0", sha256hash: archive.integrity },
    });
    clawhub.download.mockResolvedValue({ ...archive, cleanup: async () => {} });
    const env = {
      OPENCLAW_HOME: path.join(root, "home"),
      OPENCLAW_STATE_DIR: path.join(root, "state"),
      OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
      OPENCLAW_CLAWHUB_URL: undefined,
      CLAWHUB_URL: undefined,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_DISABLE_BUNDLED_SOURCE_OVERLAYS: "1",
    };
    await fs.writeFile(env.OPENCLAW_CONFIG_PATH, "{}");
    const request = {
      source: "clawhub" as const,
      packageName: "@openclaw/diffs",
      version: "1.0.0",
      expectedIntegrity: archive.integrity,
    };

    await withEnvAsync(env, async () => {
      const denied = vi.fn(async () => undefined);
      await expect(
        installManagedPlugin({ request, env, clawManaged: true, onCapabilityConsent: denied }),
      ).rejects.toMatchObject({ capabilityConsent: { pluginId: "diffs" } });
      expect(denied).toHaveBeenCalledWith(
        expect.objectContaining({ declared: expect.objectContaining({ tools: ["audit.read"] }) }),
      );
      await expect(
        fs.stat(path.join(resolveDefaultPluginExtensionsDir(env), "diffs")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(readPersistedInstalledPluginIndexInstallRecords({ env })?.diffs).toBeFalsy();

      const accepted = vi.fn(async (review: { reviewToken: string }) => ({
        reviewToken: review.reviewToken,
      }));
      await expect(
        installManagedPlugin({ request, env, clawManaged: true, onCapabilityConsent: accepted }),
      ).resolves.toMatchObject({ plugin: { id: "diffs", installed: true } });
      expect(accepted).toHaveBeenCalledOnce();
      expect(readPersistedInstalledPluginIndexInstallRecords({ env })?.diffs).toMatchObject({
        source: "clawhub",
        clawhubPackage: "@openclaw/diffs",
        integrity: archive.integrity,
      });
    });
  });

  it("rejects missing consent before publishing an artifact or install record", async () => {
    const root = dirs.make("openclaw-claw-plugin-consent-");
    const sourceDir = await writePluginSource(root, "audit.read");
    const env = {
      OPENCLAW_HOME: path.join(root, "home"),
      OPENCLAW_STATE_DIR: path.join(root, "state"),
      OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_DISABLE_BUNDLED_SOURCE_OVERLAYS: "1",
    };
    await fs.writeFile(env.OPENCLAW_CONFIG_PATH, "{}");

    await withEnvAsync(env, async () => {
      await expect(
        installManagedPlugin({
          request: { source: "local", path: sourceDir },
          env,
          clawManaged: true,
        }),
      ).rejects.toMatchObject({ capabilityConsent: { pluginId: "claw-audit" } });

      await expect(
        fs.stat(path.join(resolveDefaultPluginExtensionsDir(env), "claw-audit")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(readPersistedInstalledPluginIndexInstallRecords({ env })?.["claw-audit"]).toBeFalsy();
    });
  });

  it("keeps the installed artifact and record unchanged when update consent is denied", async () => {
    const root = dirs.make("openclaw-claw-plugin-update-consent-");
    const sourceDir = await writePluginSource(root, "audit.read");
    const env = {
      OPENCLAW_HOME: path.join(root, "home"),
      OPENCLAW_STATE_DIR: path.join(root, "state"),
      OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_DISABLE_BUNDLED_SOURCE_OVERLAYS: "1",
    };
    await fs.writeFile(env.OPENCLAW_CONFIG_PATH, "{}");

    await withEnvAsync(env, async () => {
      const reviewed: string[][] = [];
      await installManagedPlugin({
        request: { source: "local", path: sourceDir },
        env,
        clawManaged: true,
        onCapabilityConsent: async (review) => {
          reviewed.push(review.declared.tools);
          return { reviewToken: review.reviewToken };
        },
      });
      expect(reviewed).toEqual([["audit.read"]]);
      const artifactDir = path.join(resolveDefaultPluginExtensionsDir(env), "claw-audit");
      const originalArtifact = await fs.readFile(path.join(artifactDir, "openclaw.plugin.json"));
      const originalRecord = readPersistedInstalledPluginIndexInstallRecords({ env })?.[
        "claw-audit"
      ];
      expect(originalRecord?.acceptedSurface?.tools).toEqual(["audit.read"]);

      await writePluginSource(root, "audit.write");
      await expect(
        installManagedPlugin({
          request: { source: "local", path: sourceDir, mode: "update" },
          env,
          clawManaged: true,
          onCapabilityConsent: async (review) => {
            reviewed.push(review.declared.tools);
            return undefined;
          },
        }),
      ).rejects.toMatchObject({ capabilityConsent: { pluginId: "claw-audit" } });

      expect(reviewed).toEqual([["audit.read"], ["audit.write"]]);
      expect(await fs.readFile(path.join(artifactDir, "openclaw.plugin.json"))).toEqual(
        originalArtifact,
      );
      expect(readPersistedInstalledPluginIndexInstallRecords({ env })?.["claw-audit"]).toEqual(
        originalRecord,
      );
    });
  });

  it("rejects a staged capability change during the Claw owner's final check", async () => {
    const root = dirs.make("openclaw-claw-plugin-final-stage-");
    const sourceDir = await writePluginSource(root, "audit.read");
    const env = {
      OPENCLAW_HOME: path.join(root, "home"),
      OPENCLAW_STATE_DIR: path.join(root, "state"),
      OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_DISABLE_BUNDLED_SOURCE_OVERLAYS: "1",
    };
    await fs.writeFile(env.OPENCLAW_CONFIG_PATH, "{}");

    await withEnvAsync(env, async () => {
      let stageChanged = false;
      await expect(
        installManagedPlugin({
          request: { source: "local", path: sourceDir },
          env,
          clawManaged: true,
          onCapabilityConsent: async (review) => ({ reviewToken: review.reviewToken }),
          beforePersistentEffect: async () => {
            if (stageChanged) {
              return;
            }
            stageChanged = true;
            const stagedArtifactDir = await findStagedPluginArtifactDir(env);
            await fs.writeFile(
              path.join(stagedArtifactDir, "openclaw.plugin.json"),
              JSON.stringify({
                id: "claw-audit",
                contracts: { tools: ["audit.read", "audit.write"] },
                configSchema: { type: "object" },
              }),
            );
          },
        }),
      ).rejects.toMatchObject({ capabilityConsent: { pluginId: "claw-audit" } });

      expect(stageChanged).toBe(true);
      await expect(
        fs.stat(path.join(resolveDefaultPluginExtensionsDir(env), "claw-audit")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(readPersistedInstalledPluginIndexInstallRecords({ env })?.["claw-audit"]).toBeFalsy();
    });
  });

  it("rejects sibling-entry drift even when the merged capability token is unchanged", async () => {
    const root = dirs.make("openclaw-claw-plugin-sibling-drift-");
    const sourceDir = await writePluginSource(root, "audit.read");
    await fs.writeFile(
      path.join(sourceDir, "package.json"),
      JSON.stringify({
        name: "@example/claw-audit",
        version: "1.0.0",
        openclaw: { extensions: ["./index.js", "./child/child.js"] },
      }),
    );
    await fs.mkdir(path.join(sourceDir, "child"));
    await fs.writeFile(path.join(sourceDir, "child/child.js"), "export {};\n");
    await fs.writeFile(
      path.join(sourceDir, "child/openclaw.plugin.json"),
      JSON.stringify({
        id: "claw-audit-child",
        contracts: { tools: ["audit.child"] },
        configSchema: { type: "object" },
      }),
    );
    await fs.mkdir(path.join(sourceDir, "other"));
    await fs.writeFile(path.join(sourceDir, "other/other.js"), "export {};\n");
    await fs.writeFile(
      path.join(sourceDir, "other/openclaw.plugin.json"),
      JSON.stringify({
        id: "claw-audit-other",
        contracts: { tools: ["audit.child"] },
        configSchema: { type: "object" },
      }),
    );
    const env = {
      OPENCLAW_HOME: path.join(root, "home"),
      OPENCLAW_STATE_DIR: path.join(root, "state"),
      OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_DISABLE_BUNDLED_SOURCE_OVERLAYS: "1",
    };
    await fs.writeFile(env.OPENCLAW_CONFIG_PATH, "{}");

    await withEnvAsync(env, async () => {
      const expected = inspectClawPluginCapabilities(sourceDir, "claw-audit", env);
      let changed: ReturnType<typeof inspectClawPluginCapabilities> | undefined;
      const install = installManagedPlugin({
        request: { source: "local", path: sourceDir },
        env,
        clawManaged: true,
        onCapabilityConsent: async (review) => ({ reviewToken: review.reviewToken }),
        onBeforePluginArtifactCommit: async (artifact) => {
          const current = inspectClawPluginCapabilities(
            artifact.stagedArtifactDir,
            artifact.pluginId,
            env,
          );
          if (
            stableStringify(current.grantsByPluginId) !== stableStringify(expected.grantsByPluginId)
          ) {
            throw new Error("effective capability grants changed after planning");
          }
        },
        beforePersistentEffect: async () => {
          if (changed) {
            return;
          }
          const stagedArtifactDir = await findStagedPluginArtifactDir(env);
          await fs.writeFile(
            path.join(stagedArtifactDir, "package.json"),
            JSON.stringify({
              name: "@example/claw-audit",
              version: "1.0.0",
              openclaw: { extensions: ["./index.js", "./other/other.js"] },
            }),
          );
          changed = inspectClawPluginCapabilities(stagedArtifactDir, "claw-audit", env);
        },
      });
      await expect(install).rejects.toThrow("effective capability grants changed after planning");
      expect(changed?.declared).toEqual(expected.declared);
      expect(changed?.grantsByPluginId).not.toEqual(expected.grantsByPluginId);
      await expect(
        fs.stat(path.join(resolveDefaultPluginExtensionsDir(env), "claw-audit")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(readPersistedInstalledPluginIndexInstallRecords({ env })?.["claw-audit"]).toBeFalsy();
    });
  });

  it("does not mark a failed final-stage update as an external mutation", async () => {
    const root = dirs.make("openclaw-claw-plugin-final-update-");
    const sourceDir = await writePluginSource(root, "audit.read");
    const env = {
      OPENCLAW_HOME: path.join(root, "home"),
      OPENCLAW_STATE_DIR: path.join(root, "state"),
      OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_DISABLE_BUNDLED_SOURCE_OVERLAYS: "1",
    };
    await fs.writeFile(env.OPENCLAW_CONFIG_PATH, "{}");

    await withEnvAsync(env, async () => {
      const onCapabilityConsent = async (review: { reviewToken: string }) => ({
        reviewToken: review.reviewToken,
      });
      await installManagedPlugin({
        request: { source: "local", path: sourceDir },
        env,
        clawManaged: true,
        onCapabilityConsent,
      });
      const artifactDir = path.join(resolveDefaultPluginExtensionsDir(env), "claw-audit");
      const originalArtifact = await fs.readFile(path.join(artifactDir, "openclaw.plugin.json"));
      const originalRecord = readPersistedInstalledPluginIndexInstallRecords({ env })?.[
        "claw-audit"
      ];

      await writePluginSource(root, "audit.write");
      const onExternalMutation = vi.fn();
      const pluginCommit = bindClawPluginBeforeCommit(
        {
          assertPluginOwnerCurrent: async () => {
            const stagedArtifactDir = await findStagedPluginArtifactDir(env);
            await fs.writeFile(
              path.join(stagedArtifactDir, "openclaw.plugin.json"),
              JSON.stringify({
                id: "claw-audit",
                contracts: { tools: ["audit.write", "audit.admin"] },
                configSchema: { type: "object" },
              }),
            );
          },
          onExternalMutation,
        },
        { kind: "plugin", source: "clawhub", ref: "@example/claw-audit", version: "1.0.1" },
        () => {},
      );
      await expect(
        installManagedPlugin({
          request: { source: "local", path: sourceDir, mode: "update" },
          env,
          clawManaged: true,
          onCapabilityConsent,
          onBeforePluginArtifactCommit: async () => pluginCommit.artifactReviewed(),
          beforePersistentEffect: pluginCommit.beforePersistentEffect,
          beforePersistentApply: pluginCommit.beforePersistentApply,
        }),
      ).rejects.toMatchObject({ capabilityConsent: { pluginId: "claw-audit" } });

      expect(onExternalMutation).not.toHaveBeenCalled();
      expect(await fs.readFile(path.join(artifactDir, "openclaw.plugin.json"))).toEqual(
        originalArtifact,
      );
      expect(readPersistedInstalledPluginIndexInstallRecords({ env })?.["claw-audit"]).toEqual(
        originalRecord,
      );

      const successfulMutation = vi.fn();
      const successfulCommit = bindClawPluginBeforeCommit(
        { onExternalMutation: successfulMutation },
        { kind: "plugin", source: "clawhub", ref: "@example/claw-audit", version: "1.0.1" },
        () => {},
      );
      await installManagedPlugin({
        request: { source: "local", path: sourceDir, mode: "update" },
        env,
        clawManaged: true,
        onCapabilityConsent,
        onBeforePluginArtifactCommit: async () => successfulCommit.artifactReviewed(),
        beforePersistentEffect: successfulCommit.beforePersistentEffect,
        beforePersistentApply: successfulCommit.beforePersistentApply,
      });
      expect(successfulMutation).toHaveBeenCalledOnce();
      expect(
        readPersistedInstalledPluginIndexInstallRecords({ env })?.["claw-audit"]?.acceptedSurface
          ?.tools,
      ).toEqual(["audit.write"]);
    });
  });
});
