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
import { buildGatewayClawAddPlan } from "./gateway-add-plan.js";
import { bindClawPluginInstallConsent } from "./gateway-plugin-consent.js";
import { projectClawPluginCapabilityReviews } from "./plugin-capability-review.js";
import { readClawInstallRecord, readClawPackageRefs } from "./provenance.js";
import { readClawManifestFile } from "./reader.js";
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
const packageName = "@openclaw/lobster";
const agentId = "lobster-claw";

async function createOfficialLobsterClaw(root: string) {
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
    plugins: { entries: { lobster: { hooks: { allowConversationAccess: true } } } },
  };
  await fs.writeFile(configPath, JSON.stringify(config));
  const clawDir = path.join(root, "claw");
  await fs.mkdir(clawDir);
  const manifestPath = path.join(clawDir, "claw.json");
  await fs.writeFile(
    manifestPath,
    JSON.stringify({
      schemaVersion: 1,
      agent: { id: agentId, name: "Lobster Claw" },
      workspace: { bootstrapFiles: {}, files: [] },
      packages: [{ kind: "plugin", source: "clawhub", ref: packageName, version: "1.0.0" }],
      mcpServers: {},
      cronJobs: [],
    }),
  );
  const archive = await createClawHubArchive({
    "package.json": JSON.stringify({
      name: packageName,
      version: "1.0.0",
      openclaw: { extensions: ["./index.js"] },
    }),
    "openclaw.plugin.json": JSON.stringify({
      id: "lobster",
      contracts: { tools: ["audit.read"] },
      configSchema: { type: "object" },
    }),
    "index.js": "export const version = '1.0.0';\n",
  });
  let verdict: "clean" | "review" | "malicious" = "clean";
  let nextDownloadHook: (() => Promise<void>) | undefined;
  clawhub.detail.mockResolvedValue({
    package: {
      name: packageName,
      displayName: "Lobster",
      family: "code-plugin",
      channel: "official",
      isOfficial: true,
      runtimeId: "lobster",
      latestVersion: "1.0.0",
      createdAt: 0,
      updatedAt: 0,
    },
  });
  clawhub.artifact.mockResolvedValue({
    version: { version: "1.0.0", sha256hash: archive.integrity },
  });
  clawhub.security.mockImplementation(
    async ({ name, version }: { name: string; version: string }) => ({
      package: { name, displayName: "Lobster", family: "code-plugin" },
      release: { version },
      overview: "Plugin security review",
      verdict,
      securityAuditUrl: `https://clawhub.ai/plugins/${name}/security-audit?version=${version}`,
      trust: {
        scanStatus: "clean",
        moderationState: "approved",
        blockedFromDownload: false,
        reasons: [],
        pending: false,
        stale: false,
      },
    }),
  );
  clawhub.download.mockImplementation(async () => {
    const hook = nextDownloadHook;
    nextDownloadHook = undefined;
    await hook?.();
    return { ...archive, cleanup: async () => {} };
  });
  return {
    config,
    configPath,
    env,
    manifestPath,
    setVerdict: (value: typeof verdict) => {
      verdict = value;
    },
    onNextDownload: (hook: () => Promise<void>) => {
      nextDownloadHook = hook;
    },
  };
}

async function planLobsterClaw(fixture: Awaited<ReturnType<typeof createOfficialLobsterClaw>>) {
  const source = await readClawManifestFile(fixture.manifestPath);
  if (!source.ok) {
    throw new Error("Expected a valid Lobster Claw package.");
  }
  return await buildGatewayClawAddPlan(source, {
    config: fixture.config,
    sourceMcpServers: {},
  });
}

function consentForPluginPlan(plan: ClawAddPlan) {
  const review = projectClawPluginCapabilityReviews(plan)[0];
  if (!review) {
    throw new Error("Expected a Lobster plugin review.");
  }
  return bindClawPluginInstallConsent(
    [review],
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
}

describe("official Claw-managed plugin trust", () => {
  it("blocks a malicious aggregate verdict before Add downloads or persists Lobster", async () => {
    const fixture = await createOfficialLobsterClaw(dirs.make("openclaw-claw-lobster-blocked-"));
    fixture.setVerdict("malicious");
    clawhub.download.mockClear();

    await withEnvAsync(fixture.env, async () => {
      const plan = await planLobsterClaw(fixture);
      expect(plan.blockers).toContainEqual(
        expect.objectContaining({ code: "clawhub_download_blocked" }),
      );
      expect(clawhub.download).not.toHaveBeenCalled();
      await expect(
        applyClawAddPlan(plan, {
          env: fixture.env,
          config: fixture.config,
          consentPlanIntegrity: plan.planIntegrity,
        }),
      ).rejects.toMatchObject({ code: "plan_blocked" });
      expect(
        readPersistedInstalledPluginIndexInstallRecords({ env: fixture.env })?.lobster,
      ).toBeFalsy();
      await expect(
        fs.stat(path.join(resolveDefaultPluginExtensionsDir(fixture.env), "lobster")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(readClawInstallRecord(agentId, { env: fixture.env })).toBeUndefined();
      expect(readClawPackageRefs({ env: fixture.env, agentId })).toEqual([]);
      expect(await fs.readFile(fixture.configPath, "utf8")).toBe(JSON.stringify(fixture.config));
    });
  });

  it("rechecks trust before the final managed install commits", async () => {
    const fixture = await createOfficialLobsterClaw(dirs.make("openclaw-claw-lobster-recheck-"));

    await withEnvAsync(fixture.env, async () => {
      const plan = await planLobsterClaw(fixture);
      expect(plan.blockers).toEqual([]);
      const pluginConsent = consentForPluginPlan(plan);
      clawhub.security.mockClear();
      clawhub.download.mockClear();
      fixture.onNextDownload(async () => fixture.setVerdict("malicious"));

      const result = await applyClawAddPlan(plan, {
        env: fixture.env,
        config: fixture.config,
        consentPlanIntegrity: plan.planIntegrity,
        pluginConsent,
      });

      expect(result).toMatchObject({
        status: "partial",
        error: { message: expect.stringContaining("ClawHub blocked this release") },
      });
      expect(clawhub.security).toHaveBeenCalledTimes(2);
      expect(clawhub.download).toHaveBeenCalledTimes(1);
      expect(
        readPersistedInstalledPluginIndexInstallRecords({ env: fixture.env })?.lobster,
      ).toBeFalsy();
      await expect(
        fs.stat(path.join(resolveDefaultPluginExtensionsDir(fixture.env), "lobster")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(readClawPackageRefs({ env: fixture.env, agentId })).not.toContainEqual(
        expect.objectContaining({ ref: packageName, status: "complete" }),
      );
      expect(readClawInstallRecord(agentId, { env: fixture.env })?.status).toBe("partial");
      const installedConfig = JSON.parse(
        await fs.readFile(fixture.configPath, "utf8"),
      ) as OpenClawConfig;
      expect(installedConfig.agents?.entries?.[agentId]).toBeUndefined();
    });
  });

  it("requires a separate plugin risk acknowledgement for a Review verdict", async () => {
    const fixture = await createOfficialLobsterClaw(dirs.make("openclaw-claw-lobster-review-"));
    fixture.setVerdict("review");

    await withEnvAsync(fixture.env, async () => {
      const plan = await planLobsterClaw(fixture);
      expect(plan.blockers).toEqual([]);
      const review = projectClawPluginCapabilityReviews(plan)[0];
      expect(review?.riskWarning).toContain("Outcome: Review");
      if (!review) {
        return;
      }
      expect(() =>
        bindClawPluginInstallConsent(
          [review],
          [
            {
              actionId: review.actionId,
              pluginId: review.pluginId,
              reviewToken: review.reviewToken,
              capabilityGrants: review.capabilityGrants,
              capabilityGrantsByPluginId: review.capabilityGrantsByPluginId,
            },
          ],
          () => {},
        ),
      ).toThrow("Plugin capabilities changed; review the Claw again.");

      const result = await applyClawAddPlan(plan, {
        env: fixture.env,
        config: fixture.config,
        consentPlanIntegrity: plan.planIntegrity,
        pluginConsent: consentForPluginPlan(plan),
      });
      expect(result.status).toBe("complete");
      expect(
        readPersistedInstalledPluginIndexInstallRecords({ env: fixture.env })?.lobster,
      ).toMatchObject({
        clawhubPackage: packageName,
        clawhubTrustDisposition: "review-required",
      });
    });
  });
});
