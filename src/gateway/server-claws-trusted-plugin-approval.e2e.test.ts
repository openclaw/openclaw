import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_CLIENT_CAPS } from "../../packages/gateway-protocol/src/client-info.js";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { applyClawAddPlan } from "../claws/add.js";
import { buildGatewayClawAddPlan } from "../claws/gateway-add-plan.js";
import { bindClawPluginInstallConsent } from "../claws/gateway-plugin-consent.js";
import { projectClawPluginCapabilityReviews } from "../claws/plugin-capability-review.js";
import { readClawManifestFile } from "../claws/reader.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store-writer-state.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getActiveRuntimePluginRegistry } from "../plugins/active-runtime-registry.js";
import { createClawHubArchiveFactory } from "../plugins/clawhub.test-support.js";
import { readPersistedInstalledPluginIndexInstallRecords } from "../plugins/installed-plugin-index-records.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import { APPROVALS_SCOPE, WRITE_SCOPE } from "./method-scopes.js";
import { startGatewayServer } from "./server.js";
import { connectGatewayClient, disconnectGatewayClient } from "./test-helpers.e2e.js";
import { acquireGatewayE2ePortBlock, startClaimedGateway } from "./test-helpers.listener.js";
import {
  configureManualGatewayBackgroundEnv,
  MANUAL_GATEWAY_ENV_KEYS,
} from "./test-helpers.manual-gateway-env.js";

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

const dirs = useAutoCleanupTempDirTracker(afterEach);
const createClawHubArchive = createClawHubArchiveFactory(afterEach);
const packageName = "@openclaw/lobster";
const version = "1.0.0";

describe("Claw-managed official plugin approvals (real Gateway)", () => {
  it("lets the installed plugin request review and gates its effect on Allow once or Deny", async ({
    signal,
  }) => {
    const home = dirs.make("openclaw-claw-plugin-approval-");
    const stateDir = path.join(home, ".openclaw");
    const configPath = path.join(stateDir, "openclaw.json");
    const clawDir = path.join(home, "claw");
    const markerPath = path.join(home, "approved.log");
    await fs.mkdir(stateDir, { recursive: true });
    await fs.mkdir(clawDir);
    const config: OpenClawConfig = {
      gateway: { mode: "local", controlUi: { experimental: { claws: true } } },
      agents: { entries: {} },
    };
    await fs.writeFile(configPath, JSON.stringify(config));
    const manifestPath = path.join(clawDir, "claw.json");
    await fs.writeFile(
      manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        agent: { id: "approval-claw", name: "Approval Claw" },
        workspace: { bootstrapFiles: {}, files: [] },
        packages: [{ kind: "plugin", source: "clawhub", ref: packageName, version }],
        mcpServers: {},
        cronJobs: [],
      }),
    );

    // Synthetic package uses the official catalog identity but no Lobster runtime dependency.
    const archive = await createClawHubArchive({
      "package.json": JSON.stringify({
        name: packageName,
        version,
        type: "commonjs",
        main: "index.cjs",
        openclaw: { extensions: ["./index.cjs"] },
      }),
      "openclaw.plugin.json": JSON.stringify({
        id: "lobster",
        contracts: { tools: ["approval_probe"] },
        configSchema: { type: "object" },
      }),
      "index.cjs": `module.exports = { id: "lobster", register(api) {
        api.registerTool((ctx) => ({
          name: "approval_probe",
          description: "Write one marker only after operator approval",
          parameters: { type: "object", properties: {} },
          execute: async () => {
            const result = await api.runtime.gateway.request(
              "plugin.approval.request",
              {
                pluginId: api.id,
                title: "Review marker write",
                description: "Append one test marker",
                agentId: ctx.agentId,
                sessionKey: ctx.sessionKey,
                ...(ctx.approvalReviewerDeviceIds?.length
                  ? { approvalReviewerDeviceIds: ctx.approvalReviewerDeviceIds }
                  : {}),
                timeoutMs: 10_000,
              },
              { scopes: ["operator.approvals"], timeoutMs: 11_000 },
            );
            if (result.decision === "allow-once") {
              require("node:fs").appendFileSync(${JSON.stringify(markerPath)}, "approved\\n");
            }
            return { content: [{ type: "text", text: result.decision ?? "cancelled" }] };
          },
        }), { name: "approval_probe" });
      } };`,
    });
    clawhub.detail.mockResolvedValue({
      package: {
        name: packageName,
        displayName: "Lobster",
        family: "code-plugin",
        channel: "official",
        isOfficial: true,
        runtimeId: "lobster",
        latestVersion: version,
        createdAt: 0,
        updatedAt: 0,
      },
    });
    clawhub.artifact.mockResolvedValue({ version: { version, sha256hash: archive.integrity } });
    clawhub.security.mockResolvedValue({
      package: { name: packageName, displayName: "Lobster", family: "code-plugin" },
      release: { version },
      overview: "Synthetic official plugin fixture",
      verdict: "clean",
      securityAuditUrl: `https://clawhub.ai/plugins/${packageName}/security-audit?version=${version}`,
      trust: {
        scanStatus: "clean",
        moderationState: "approved",
        blockedFromDownload: false,
        reasons: [],
        pending: false,
        stale: false,
      },
    });
    clawhub.download.mockResolvedValue({ ...archive, cleanup: async () => {} });

    const envSnapshot = captureEnv([
      "HOME",
      ...MANUAL_GATEWAY_ENV_KEYS,
      "OPENCLAW_HOME",
      "OPENCLAW_STATE_DIR",
      "OPENCLAW_CONFIG_PATH",
      "OPENCLAW_CLAWHUB_URL",
      "CLAWHUB_URL",
      "OPENCLAW_GATEWAY_URL",
      "OPENCLAW_GATEWAY_TOKEN",
      "OPENCLAW_GATEWAY_PASSWORD",
      "OPENCLAW_TEST_MINIMAL_GATEWAY",
    ]);
    let server: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
    let caller: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
    let reviewer: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
    try {
      setTestEnvValue("HOME", home);
      setTestEnvValue("OPENCLAW_HOME", home);
      setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
      setTestEnvValue("OPENCLAW_CONFIG_PATH", configPath);
      deleteTestEnvValue("OPENCLAW_CLAWHUB_URL");
      deleteTestEnvValue("CLAWHUB_URL");
      deleteTestEnvValue("OPENCLAW_GATEWAY_URL");
      deleteTestEnvValue("OPENCLAW_GATEWAY_TOKEN");
      deleteTestEnvValue("OPENCLAW_GATEWAY_PASSWORD");
      configureManualGatewayBackgroundEnv(home);
      setTestEnvValue("OPENCLAW_TEST_MINIMAL_GATEWAY", "0");

      const source = await readClawManifestFile(manifestPath);
      expect(source.ok).toBe(true);
      if (!source.ok) {
        throw new Error("Expected a valid Claw package");
      }
      const plan = await buildGatewayClawAddPlan(source, { config, sourceMcpServers: {} });
      expect(plan.blockers).toEqual([]);
      const review = projectClawPluginCapabilityReviews(plan)[0];
      expect(review?.pluginId).toBe("lobster");
      if (!review) {
        throw new Error("Expected an official plugin capability review");
      }
      const pluginConsent = bindClawPluginInstallConsent(
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
      );
      const added = await applyClawAddPlan(plan, {
        env: {
          OPENCLAW_HOME: home,
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_CONFIG_PATH: configPath,
        },
        config,
        consentPlanIntegrity: plan.planIntegrity,
        pluginConsent,
      });
      expect(added.status).toBe("complete");
      expect(readPersistedInstalledPluginIndexInstallRecords()?.lobster).toMatchObject({
        source: "clawhub",
        clawhubPackage: packageName,
        clawhubUrl: "https://clawhub.ai",
        clawhubChannel: "official",
      });

      const claim = await acquireGatewayE2ePortBlock();
      const token = "claw-plugin-approval-e2e-token";
      const url = `ws://127.0.0.1:${claim.port}`;
      setTestEnvValue("OPENCLAW_GATEWAY_PORT", String(claim.port));
      server = await startClaimedGateway(claim, () =>
        startGatewayServer(claim.port, {
          bind: "loopback",
          auth: { mode: "token", token },
          controlUiEnabled: false,
          sidecarStartup: "defer",
        }),
      );
      let requested = createDeferredCore<string>();
      reviewer = await connectGatewayClient({
        url,
        token,
        clientDisplayName: "plugin approval reviewer",
        scopes: [APPROVALS_SCOPE],
        caps: [GATEWAY_CLIENT_CAPS.APPROVALS],
        onEvent: (event) => {
          if (event.event !== "plugin.approval.requested") {
            return;
          }
          const id = (event.payload as { id?: unknown } | undefined)?.id;
          if (typeof id === "string") {
            requested.resolve(id);
          }
        },
        timeoutMs: 60_000,
      });
      caller = await connectGatewayClient({
        url,
        token,
        clientDisplayName: "write-only plugin tool caller",
        scopes: [WRITE_SCOPE],
        requestTimeoutMs: 15_000,
        timeoutMs: 60_000,
      });
      const invoke = () =>
        caller!.request("tools.invoke", {
          name: "approval_probe",
          agentId: "approval-claw",
          sessionKey: "agent:approval-claw:main",
          args: {},
        });

      const allowed = invoke();
      const allowId = await withinTest(
        awaitGateBeforeSettlement(
          requested.promise,
          allowed,
          "The plugin tool settled before requesting approval",
        ),
        signal,
      );
      await expect(fs.readFile(markerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      await withinTest(
        reviewer.request("plugin.approval.resolve", { id: allowId, decision: "allow-once" }),
        signal,
      );
      await expect(withinTest(allowed, signal)).resolves.toMatchObject({
        ok: true,
        output: { content: [{ type: "text", text: "allow-once" }] },
      });
      expect(await fs.readFile(markerPath, "utf8")).toBe("approved\n");

      requested = createDeferredCore<string>();
      const denied = invoke();
      const denyId = await withinTest(
        awaitGateBeforeSettlement(
          requested.promise,
          denied,
          "The plugin tool settled before requesting approval",
        ),
        signal,
      );
      expect(await fs.readFile(markerPath, "utf8")).toBe("approved\n");
      await withinTest(
        reviewer.request("plugin.approval.resolve", { id: denyId, decision: "deny" }),
        signal,
      );
      await expect(withinTest(denied, signal)).resolves.toMatchObject({
        ok: true,
        output: { content: [{ type: "text", text: "deny" }] },
      });
      expect(await fs.readFile(markerPath, "utf8")).toBe("approved\n");

      expect(
        getActiveRuntimePluginRegistry()?.plugins.find((plugin) => plugin.id === "lobster"),
      ).toMatchObject({
        status: "loaded",
        trustedOfficialInstall: true,
        trust: { reason: "trusted-official" },
      });
    } finally {
      try {
        if (caller) {
          await disconnectGatewayClient(caller).catch(() => undefined);
        }
        if (reviewer) {
          await disconnectGatewayClient(reviewer).catch(() => undefined);
        }
        await server?.close();
      } finally {
        try {
          await closeStateDatabaseForTest();
        } finally {
          envSnapshot.restore();
          clearRuntimeConfigSnapshot();
          clearConfigCache();
          clearSessionStoreCacheForTest();
          vi.clearAllMocks();
        }
      }
    }
  });
});
