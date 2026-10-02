import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createClawHubArchiveFactory } from "../plugins/clawhub.test-support.js";
import { resolveDefaultPluginExtensionsDir } from "../plugins/install-paths.js";
import { readPersistedInstalledPluginIndexInstallRecords } from "../plugins/installed-plugin-index-records.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { withEnvAsync } from "../test-utils/env.js";
import { applyClawAddPlan } from "./add.js";
import { buildGatewayClawAddPlan, projectGatewayClawAddPlan } from "./gateway-add-plan.js";
import { bindClawPluginInstallConsent } from "./gateway-plugin-consent.js";
import { digestClawPackageRef } from "./package-update-provenance.js";
import { applyClawPackageUpdate } from "./package-update.js";
import { projectClawPluginCapabilityReviews } from "./plugin-capability-review.js";
import { readClawPackageRefs, type PersistedClawPackageRef } from "./provenance.js";
import { readClawManifestFile } from "./reader.js";
import { createClawUpdatePlanFixture } from "./resource-update.test-helpers.js";
import type { ClawAddPlan } from "./types.js";

const clawhub = vi.hoisted(() => ({
  detail: vi.fn(),
  artifact: vi.fn(),
  download: vi.fn(),
  security: vi.fn(),
  officialCatalog: vi.fn(async () => ({ source: "hosted" as const, entries: [] })),
}));

vi.mock("../infra/clawhub-packages.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/clawhub-packages.js")>()),
  fetchClawHubPackageDetail: clawhub.detail,
  fetchClawHubPackageArtifact: clawhub.artifact,
  fetchClawHubPackageSecurity: clawhub.security,
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

async function revokeConversationAccess(configPath: string, pluginId: string) {
  const current = JSON.parse(await fs.readFile(configPath, "utf8")) as {
    plugins: { entries: Record<string, { hooks: { allowConversationAccess: boolean } }> };
  };
  current.plugins.entries[pluginId]!.hooks.allowConversationAccess = false;
  await fs.writeFile(configPath, JSON.stringify(current));
}

async function createPluginClawFixture(
  root: string,
  channel: "official" | "community" = "official",
  withChild = false,
) {
  const packageName = channel === "official" ? "@openclaw/diffs" : "@audit/diffs";
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
  const config: OpenClawConfig = {
    agents: { entries: {} },
    plugins: {
      entries: withChild
        ? {
            "diffs/index": { hooks: { allowConversationAccess: false } },
            "diffs/child": { hooks: { allowConversationAccess: true } },
          }
        : { diffs: { hooks: { allowConversationAccess: true } } },
    },
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
      packages: [{ kind: "plugin", source: "clawhub", ref: packageName, version: "1.0.0" }],
      mcpServers: {},
      cronJobs: [],
    }),
  );

  const archives = new Map<string, Awaited<ReturnType<typeof createClawHubArchive>>>();
  let latestVersion = "1.0.0";
  const addVersion = async (version: string) => {
    const archive = await createClawHubArchive({
      "package.json": JSON.stringify({
        name: packageName,
        version,
        openclaw: {
          extensions: withChild ? ["./index.js", "./plugins/child/child.js"] : ["./index.js"],
        },
      }),
      "openclaw.plugin.json": JSON.stringify({
        id: "diffs",
        contracts: { tools: ["audit.read"] },
        configSchema: { type: "object" },
      }),
      "index.js": `export const version = ${JSON.stringify(version)};\n`,
      ...(withChild
        ? {
            "plugins/child/openclaw.plugin.json": JSON.stringify({
              id: "diffs-child",
              hooks: ["before_agent_reply"],
              configSchema: { type: "object" },
            }),
            "plugins/child/child.js": `export const version = ${JSON.stringify(version)};\n`,
          }
        : {}),
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
      name: packageName,
      displayName: "Diffs",
      family: "code-plugin",
      channel,
      isOfficial: channel === "official",
      runtimeId: "diffs",
      latestVersion,
      createdAt: 0,
      updatedAt: 0,
    },
  }));
  clawhub.artifact.mockImplementation(async ({ version }: { version: string }) => ({
    version: { version, sha256hash: getArchive(version).integrity },
  }));
  let scanStatus: "clean" | "suspicious" = "clean";
  clawhub.security.mockImplementation(
    async ({ name, version }: { name: string; version: string }) => ({
      package: { name, displayName: "Diffs", family: "code-plugin" },
      release: { version },
      overview: "Plugin security review",
      securityAuditUrl: `https://clawhub.ai/plugins/${name}/security-audit?version=${version}`,
      trust: {
        scanStatus,
        moderationState: "approved",
        blockedFromDownload: false,
        reasons: scanStatus === "suspicious" ? ["payload_strings"] : [],
        pending: false,
        stale: false,
      },
    }),
  );
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
    packageName,
    addVersion,
    setScanStatus: (status: "clean" | "suspicious") => {
      scanStatus = status;
    },
    onNextDownload: (hook: () => Promise<void>) => {
      nextDownloadHook = hook;
    },
  };
}

function consentForPluginPlan(plan: ClawAddPlan) {
  const reviews = projectClawPluginCapabilityReviews(plan);
  const review = reviews[0];
  if (reviews.length !== 1 || !review) {
    throw new Error("Expected one plugin review.");
  }
  const consent = bindClawPluginInstallConsent(
    reviews,
    [
      {
        actionId: review.actionId,
        pluginId: review.pluginId,
        reviewToken: review.reviewToken,
        capabilityGrants: review.capabilityGrants,
        capabilityGrantsByPluginId: review.capabilityGrantsByPluginId,
        ...(review.riskWarning ? { acknowledgeRiskWarning: true as const } : {}),
      },
    ],
    () => {},
  );
  if (!consent) {
    throw new Error("Expected plugin installer consent.");
  }
  return consent;
}

function createPluginVersionUpdate(params: {
  plan: ClawAddPlan;
  packageName: string;
  version: string;
  integrity: string;
  previous: PersistedClawPackageRef;
}) {
  const packageAction = params.plan.actions.find(
    (action) => action.id === `plugin:${params.packageName}`,
  );
  if (!packageAction) {
    throw new Error("Expected plugin package action.");
  }
  const target = `clawhub:${params.packageName}@${params.version}`;
  const targetAddPlan: ClawAddPlan = {
    ...params.plan,
    actions: [
      {
        ...packageAction,
        target,
        details: {
          ...packageAction.details,
          version: params.version,
          integrity: params.integrity,
          ownerAction: "install",
        },
      },
    ],
  };
  const updatePlan = {
    ...createClawUpdatePlanFixture([
      {
        kind: "package",
        id: packageAction.id,
        action: "change" as const,
        target,
        blocked: false,
        reason: "new version",
        currentDigest: digestClawPackageRef(params.previous),
      },
    ]),
    agentId: params.plan.agent.finalId,
  };
  return { targetAddPlan, updatePlan };
}

describe("Claw plugin capability consent through the managed installer", () => {
  it("reviews and binds a child extension's conversation grant on Add", async () => {
    const fixture = await createPluginClawFixture(
      dirs.make("openclaw-claw-plugin-child-grant-add-"),
      "official",
      true,
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
        plan.actions.find((action) => action.id === `plugin:${fixture.packageName}`)?.details,
      ).toMatchObject({
        capabilityGrantsByPluginId: {
          "diffs/index": { hooks: { allowConversationAccess: { effective: false } } },
          "diffs/child": { hooks: { allowConversationAccess: { effective: true } } },
        },
      });
      const review = projectClawPluginCapabilityReviews(plan)[0];
      expect(review?.pluginId).toBe("diffs");
      expect(Object.keys(review?.capabilityGrantsByPluginId ?? {}).toSorted()).toEqual([
        "diffs/child",
        "diffs/index",
      ]);
      expect(review?.capabilityGrantsByPluginId).toMatchObject({
        "diffs/index": { hooks: { allowConversationAccess: { effective: false } } },
        "diffs/child": { hooks: { allowConversationAccess: { effective: true } } },
      });

      const result = await applyClawAddPlan(plan, {
        env,
        config,
        consentPlanIntegrity: plan.planIntegrity,
        pluginConsent: consentForPluginPlan(plan),
      });
      expect(result.status).toBe("complete");
      const installedConfig = JSON.parse(await fs.readFile(configPath, "utf8")) as OpenClawConfig;
      expect(installedConfig.plugins?.entries?.["diffs/child"]?.enabled).toBe(true);
    });
  });

  it("blocks Add when an exact installed plugin is disabled by the host", async () => {
    const fixture = await createPluginClawFixture(dirs.make("openclaw-claw-disabled-plugin-"));
    const { config, configPath, env, manifestPath } = fixture;

    await withEnvAsync(env, async () => {
      const source = await readClawManifestFile(manifestPath);
      expect(source.ok).toBe(true);
      if (!source.ok) {
        return;
      }
      const firstPlan = await buildGatewayClawAddPlan(source, { config, sourceMcpServers: {} });
      const added = await applyClawAddPlan(firstPlan, {
        env,
        config,
        consentPlanIntegrity: firstPlan.planIntegrity,
        pluginConsent: consentForPluginPlan(firstPlan),
      });
      expect(added.status).toBe("complete");

      const installedConfig = JSON.parse(await fs.readFile(configPath, "utf8")) as OpenClawConfig;
      const disabledConfig: OpenClawConfig = {
        ...installedConfig,
        plugins: {
          ...installedConfig.plugins,
          entries: {
            ...installedConfig.plugins?.entries,
            diffs: { ...installedConfig.plugins?.entries?.diffs, enabled: false },
          },
        },
      };
      await fs.writeFile(configPath, JSON.stringify(disabledConfig));

      const plan = await buildGatewayClawAddPlan(source, {
        config: disabledConfig,
        agentId: "disabled-reuse-claw",
        sourceMcpServers: {},
      });
      const projected = projectGatewayClawAddPlan(
        plan,
        source.source.packageRoot,
        {
          riskAcknowledgementRequired: false,
          trustRecord: {
            clawhubTrustDisposition: "clean",
            clawhubTrustCheckedAt: "2026-09-30T00:00:00.000Z",
          },
        },
        disabledConfig,
      );

      expect(projected.blockers).toContainEqual(
        expect.objectContaining({
          code: "plugin_disabled",
          message: expect.stringContaining("Enable it in Plugins"),
        }),
      );
      expect(
        projected.actions.find((action) => action.id === `plugin:${fixture.packageName}`),
      ).toMatchObject({ blocked: true });
    });
  });

  it("rejects a newly review-required community plugin before an Add install commits", async () => {
    const fixture = await createPluginClawFixture(
      dirs.make("openclaw-claw-plugin-trust-add-"),
      "community",
    );
    const { config, env, manifestPath } = fixture;

    await withEnvAsync(env, async () => {
      const source = await readClawManifestFile(manifestPath);
      expect(source.ok).toBe(true);
      if (!source.ok) {
        return;
      }
      const plan = await buildGatewayClawAddPlan(source, { config, sourceMcpServers: {} });
      expect(plan.blockers).toEqual([]);
      expect(projectClawPluginCapabilityReviews(plan)[0]?.riskWarning).toBeUndefined();
      const pluginConsent = consentForPluginPlan(plan);
      let trustChanged = false;
      fixture.onNextDownload(async () => {
        trustChanged = true;
        fixture.setScanStatus("suspicious");
      });

      const result = await applyClawAddPlan(plan, {
        env,
        config,
        consentPlanIntegrity: plan.planIntegrity,
        pluginConsent,
      });

      expect(trustChanged).toBe(true);
      expect(result).toMatchObject({
        status: "partial",
        error: { message: expect.stringContaining("trust state changed") },
      });
      await expect(
        fs.stat(path.join(resolveDefaultPluginExtensionsDir(env), "diffs")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(readPersistedInstalledPluginIndexInstallRecords({ env })?.diffs).toBeFalsy();
    });
  });

  it("rejects a newly review-required community plugin before an Update install commits", async () => {
    const fixture = await createPluginClawFixture(
      dirs.make("openclaw-claw-plugin-trust-update-"),
      "community",
    );
    const { config, env, manifestPath, packageName } = fixture;

    await withEnvAsync(env, async () => {
      const source = await readClawManifestFile(manifestPath);
      expect(source.ok).toBe(true);
      if (!source.ok) {
        return;
      }
      const plan = await buildGatewayClawAddPlan(source, { config, sourceMcpServers: {} });
      expect(plan.blockers).toEqual([]);
      const added = await applyClawAddPlan(plan, {
        env,
        config,
        consentPlanIntegrity: plan.planIntegrity,
        pluginConsent: consentForPluginPlan(plan),
      });
      expect(added.status).toBe("complete");

      const beforeRefs = readClawPackageRefs({ env, agentId: "audit-claw" });
      const previous = beforeRefs.find((ref) => ref.ref === packageName);
      expect(previous).toMatchObject({ version: "1.0.0", status: "complete" });
      if (!previous) {
        return;
      }
      const artifactDir = path.join(resolveDefaultPluginExtensionsDir(env), "diffs");
      const beforeArtifact = await fs.readFile(path.join(artifactDir, "index.js"));
      const beforeRecord = readPersistedInstalledPluginIndexInstallRecords({ env })?.diffs;
      expect(beforeRecord).toMatchObject({ source: "clawhub", clawhubPackage: packageName });

      const v2 = await fixture.addVersion("1.1.0");
      const { targetAddPlan, updatePlan } = createPluginVersionUpdate({
        plan,
        packageName,
        version: "1.1.0",
        integrity: v2.integrity,
        previous,
      });
      expect(projectClawPluginCapabilityReviews(targetAddPlan)[0]?.riskWarning).toBeUndefined();
      const pluginConsent = consentForPluginPlan(targetAddPlan);
      let trustChanged = false;
      fixture.onNextDownload(async () => {
        trustChanged = true;
        fixture.setScanStatus("suspicious");
      });

      await expect(
        applyClawPackageUpdate(updatePlan, targetAddPlan, { env, config, pluginConsent }),
      ).rejects.toMatchObject({
        partial: false,
        message: expect.stringContaining("trust state changed"),
      });
      expect(trustChanged).toBe(true);
      expect(await fs.readFile(path.join(artifactDir, "index.js"))).toEqual(beforeArtifact);
      expect(readPersistedInstalledPluginIndexInstallRecords({ env })?.diffs).toEqual(beforeRecord);
      expect(readClawPackageRefs({ env, agentId: "audit-claw" })).toEqual(beforeRefs);
    });
  });

  it("accepts an unchanged review-required warning for a community plugin Add", async () => {
    const fixture = await createPluginClawFixture(
      dirs.make("openclaw-claw-plugin-trust-accepted-"),
      "community",
    );
    const { config, env, manifestPath, packageName } = fixture;
    fixture.setScanStatus("suspicious");

    await withEnvAsync(env, async () => {
      const source = await readClawManifestFile(manifestPath);
      expect(source.ok).toBe(true);
      if (!source.ok) {
        return;
      }
      const plan = await buildGatewayClawAddPlan(source, { config, sourceMcpServers: {} });
      expect(plan.blockers).toEqual([]);
      expect(projectClawPluginCapabilityReviews(plan)[0]?.riskWarning).toContain("Outcome: Review");

      const result = await applyClawAddPlan(plan, {
        env,
        config,
        consentPlanIntegrity: plan.planIntegrity,
        pluginConsent: consentForPluginPlan(plan),
      });

      expect(result.status).toBe("complete");
      expect(
        await fs.readFile(
          path.join(resolveDefaultPluginExtensionsDir(env), "diffs", "index.js"),
          "utf8",
        ),
      ).toContain("1.0.0");
      expect(readPersistedInstalledPluginIndexInstallRecords({ env })?.diffs).toMatchObject({
        clawhubPackage: packageName,
        clawhubTrustDisposition: "review-required",
      });
    });
  });

  it("rejects revoked grants before an official plugin artifact or install record is committed", async () => {
    const fixture = await createPluginClawFixture(
      dirs.make("openclaw-claw-plugin-final-consent-"),
      "official",
      true,
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
        capabilityGrantsByPluginId: {
          "diffs/child": { hooks: { allowConversationAccess: { effective: true } } },
        },
      });

      let revoked = false;
      fixture.onNextDownload(async () => {
        revoked = true;
        await revokeConversationAccess(configPath, "diffs/child");
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
    const fixture = await createPluginClawFixture(
      dirs.make("openclaw-claw-plugin-update-consent-"),
      "official",
      true,
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
      const { targetAddPlan, updatePlan } = createPluginVersionUpdate({
        plan,
        packageName: fixture.packageName,
        version: "1.1.0",
        integrity: v2.integrity,
        previous,
      });
      let revoked = false;
      fixture.onNextDownload(async () => {
        revoked = true;
        await revokeConversationAccess(configPath, "diffs/child");
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
