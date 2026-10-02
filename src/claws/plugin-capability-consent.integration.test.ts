import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createClawHubArchiveFactory } from "../plugins/clawhub.test-support.js";
import { resolveDefaultPluginExtensionsDir } from "../plugins/install-paths.js";
import { readPersistedInstalledPluginIndexInstallRecords } from "../plugins/installed-plugin-index-records.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { withEnvAsync } from "../test-utils/env.js";
import { applyClawAddPlan } from "./add.js";
import { buildGatewayClawAddPlan } from "./gateway-add-plan.js";
import { digestClawPackageRef } from "./package-update-provenance.js";
import { applyClawPackageUpdate } from "./package-update.js";
import { readClawPackageRefs } from "./provenance.js";
import { readClawManifestFile } from "./reader.js";
import { createClawUpdatePlanFixture } from "./resource-update.test-helpers.js";
import type { ClawAddPlan } from "./types.js";

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
vi.mock("../plugins/official-external-plugin-catalog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/official-external-plugin-catalog.js")>()),
  loadConfiguredHostedOfficialExternalPluginCatalogEntries: clawhub.officialCatalog,
}));

afterEach(closeStateDatabaseForTest);
const dirs = useAutoCleanupTempDirTracker(afterEach);
const createClawHubArchive = createClawHubArchiveFactory(afterEach);

async function revokeConversationAccess(configPath: string) {
  const current = JSON.parse(await fs.readFile(configPath, "utf8")) as {
    plugins: { entries: { diffs: { hooks: { allowConversationAccess: boolean } } } };
  };
  current.plugins.entries.diffs.hooks.allowConversationAccess = false;
  await fs.writeFile(configPath, JSON.stringify(current));
}

async function createOfficialPluginClawFixture(root: string) {
  const configPath = path.join(root, "openclaw.json");
  const env = {
    OPENCLAW_HOME: path.join(root, "home"),
    OPENCLAW_STATE_DIR: path.join(root, "state"),
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_CLAWHUB_URL: undefined,
    CLAWHUB_URL: undefined,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    OPENCLAW_DISABLE_BUNDLED_SOURCE_OVERLAYS: "1",
  };
  const config = {
    agents: { entries: {} },
    plugins: { entries: { diffs: { hooks: { allowConversationAccess: true } } } },
  };
  await fs.writeFile(configPath, JSON.stringify(config));
  const clawDir = path.join(root, "claw");
  await fs.mkdir(clawDir);
  const manifestPath = path.join(clawDir, "claw.json");
  await fs.writeFile(
    manifestPath,
    JSON.stringify({
      schemaVersion: 1,
      agent: { id: "audit-claw", name: "Audit Claw" },
      workspace: { bootstrapFiles: {}, files: [] },
      packages: [{ kind: "plugin", source: "clawhub", ref: "@openclaw/diffs", version: "1.0.0" }],
      mcpServers: {},
      cronJobs: [],
    }),
  );

  const archives = new Map<string, Awaited<ReturnType<typeof createClawHubArchive>>>();
  let latestVersion = "1.0.0";
  const addVersion = async (version: string) => {
    const archive = await createClawHubArchive({
      "package.json": JSON.stringify({
        name: "@openclaw/diffs",
        version,
        openclaw: { extensions: ["./index.js"] },
      }),
      "openclaw.plugin.json": JSON.stringify({
        id: "diffs",
        contracts: { tools: ["audit.read"] },
        configSchema: { type: "object" },
      }),
      "index.js": `export const version = ${JSON.stringify(version)};\n`,
    });
    archives.set(version, archive);
    latestVersion = version;
    return archive;
  };
  await addVersion("1.0.0");
  let nextDownloadHook: (() => Promise<void>) | undefined;
  const getArchive = (version: string) => {
    const archive = archives.get(version);
    if (!archive) {
      throw new Error(`Unexpected ClawHub plugin version ${version}`);
    }
    return archive;
  };

  clawhub.detail.mockImplementation(async () => ({
    package: {
      name: "@openclaw/diffs",
      displayName: "Diffs",
      family: "code-plugin",
      channel: "official",
      isOfficial: true,
      runtimeId: "diffs",
      latestVersion,
      createdAt: 0,
      updatedAt: 0,
    },
  }));
  clawhub.artifact.mockImplementation(async ({ version }: { version: string }) => ({
    version: { version, sha256hash: getArchive(version).integrity },
  }));
  clawhub.download.mockImplementation(async ({ version }: { version?: string }) => {
    const hook = nextDownloadHook;
    nextDownloadHook = undefined;
    await hook?.();
    return { ...getArchive(version ?? "1.0.0"), cleanup: async () => {} };
  });
  return {
    config,
    configPath,
    env,
    manifestPath,
    addVersion,
    onNextDownload: (hook: () => Promise<void>) => {
      nextDownloadHook = hook;
    },
  };
}

describe("Claw plugin capability consent through the managed installer", () => {
  it("rejects revoked grants before an official plugin artifact or install record is committed", async () => {
    const fixture = await createOfficialPluginClawFixture(
      dirs.make("openclaw-claw-plugin-final-consent-"),
    );
    const { config, configPath, env, manifestPath } = fixture;

    await withEnvAsync(env, async () => {
      const source = await readClawManifestFile(manifestPath);
      expect(source.ok).toBe(true);
      if (!source.ok) {
        return;
      }
      const plan = await buildGatewayClawAddPlan(source, { config, sourceMcpServers: {} });
      expect(plan.blockers).toEqual([]);
      expect(
        plan.actions.find((action) => action.id === "plugin:@openclaw/diffs")?.details,
      ).toMatchObject({
        capabilityGrants: { hooks: { allowConversationAccess: { effective: true } } },
      });

      let revoked = false;
      fixture.onNextDownload(async () => {
        revoked = true;
        await revokeConversationAccess(configPath);
      });
      const result = await applyClawAddPlan(plan, {
        env,
        config,
        consentPlanIntegrity: plan.planIntegrity,
        pluginConsent: {
          onCapabilityConsent: async (review) => ({ reviewToken: review.reviewToken }),
        },
      });

      expect(revoked).toBe(true);
      expect(result).toMatchObject({
        status: "partial",
        error: { message: expect.stringContaining("effective capability grants changed") },
      });
      await expect(
        fs.stat(path.join(resolveDefaultPluginExtensionsDir(env), "diffs")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(readPersistedInstalledPluginIndexInstallRecords({ env })?.diffs).toBeFalsy();
    });
  });

  it("preserves a prior accepted official plugin and its Claw reference when update consent is denied", async () => {
    const fixture = await createOfficialPluginClawFixture(
      dirs.make("openclaw-claw-plugin-update-consent-"),
    );
    const { config, configPath, env, manifestPath } = fixture;

    await withEnvAsync(env, async () => {
      const source = await readClawManifestFile(manifestPath);
      expect(source.ok).toBe(true);
      if (!source.ok) {
        return;
      }
      const plan = await buildGatewayClawAddPlan(source, { config, sourceMcpServers: {} });
      expect(plan.blockers).toEqual([]);
      const accepted = vi.fn(async (review: { reviewToken: string }) => ({
        reviewToken: review.reviewToken,
      }));
      const added = await applyClawAddPlan(plan, {
        env,
        config,
        consentPlanIntegrity: plan.planIntegrity,
        pluginConsent: {
          onCapabilityConsent: accepted,
        },
      });
      expect(added.status).toBe("complete");
      expect(accepted).toHaveBeenCalledOnce();

      const beforeRefs = readClawPackageRefs({ env, agentId: "audit-claw" });
      const previous = beforeRefs.find((ref) => ref.ref === "@openclaw/diffs");
      expect(previous).toMatchObject({ version: "1.0.0", status: "complete" });
      if (!previous) {
        return;
      }
      const artifactDir = path.join(resolveDefaultPluginExtensionsDir(env), "diffs");
      const beforeArtifact = await fs.readFile(path.join(artifactDir, "index.js"));
      const beforeRecord = readPersistedInstalledPluginIndexInstallRecords({ env })?.diffs;
      expect(beforeRecord).toMatchObject({
        source: "clawhub",
        clawhubPackage: "@openclaw/diffs",
      });

      const v2 = await fixture.addVersion("1.1.0");
      const packageAction = plan.actions.find((action) => action.id === "plugin:@openclaw/diffs");
      expect(packageAction).toBeDefined();
      if (!packageAction) {
        return;
      }
      const targetAddPlan: ClawAddPlan = {
        ...plan,
        actions: [
          {
            ...packageAction,
            target: "clawhub:@openclaw/diffs@1.1.0",
            details: {
              ...packageAction.details,
              version: "1.1.0",
              integrity: v2.integrity,
              ownerAction: "install",
            },
          },
        ],
      };
      const updatePlan = {
        ...createClawUpdatePlanFixture([
          {
            kind: "package",
            id: "plugin:@openclaw/diffs",
            action: "change" as const,
            target: "clawhub:@openclaw/diffs@1.1.0",
            blocked: false,
            reason: "new version",
            currentDigest: digestClawPackageRef(previous),
          },
        ]),
        agentId: "audit-claw",
      };
      let revoked = false;
      fixture.onNextDownload(async () => {
        revoked = true;
        await revokeConversationAccess(configPath);
      });

      await expect(
        applyClawPackageUpdate(updatePlan, targetAddPlan, {
          env,
          config,
          pluginConsent: {
            onCapabilityConsent: async (review) => ({ reviewToken: review.reviewToken }),
          },
        }),
      ).rejects.toMatchObject({
        partial: false,
        message: expect.stringContaining("effective capability grants changed"),
      });
      expect(revoked).toBe(true);
      expect(await fs.readFile(path.join(artifactDir, "index.js"))).toEqual(beforeArtifact);
      expect(readPersistedInstalledPluginIndexInstallRecords({ env })?.diffs).toEqual(beforeRecord);
      expect(readClawPackageRefs({ env, agentId: "audit-claw" })).toEqual(beforeRefs);
    });
  });
});
