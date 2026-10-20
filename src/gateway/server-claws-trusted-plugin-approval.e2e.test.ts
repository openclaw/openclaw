import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { GATEWAY_CLIENT_CAPS } from "../../packages/gateway-protocol/src/client-info.js";
import { withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { applyClawAddPlanStateless } from "../claws/add-stateless.js";
import { buildGatewayClawAddPlan } from "../claws/gateway-add-plan.js";
import { bindClawPluginInstallConsent } from "../claws/gateway-plugin-consent.js";
import { projectClawPluginCapabilityReviews } from "../claws/plugin-capability-review.js";
import { readClawManifestFile } from "../claws/reader.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store-writer-state.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getActiveRuntimePluginRegistry } from "../plugins/active-runtime-registry.js";
import { clawHubSecurityResponse } from "../plugins/clawhub.test-fixtures.js";
import { createClawHubArchiveFactory } from "../plugins/clawhub.test-support.js";
import { readPersistedInstalledPluginIndexInstallRecordsAsync } from "../plugins/installed-plugin-index-records.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import { APPROVALS_SCOPE, WRITE_SCOPE } from "./method-scopes.js";
import { createTestGate } from "./server-close.lifecycle.test-support.js";
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

it("lets the installed plugin request review and gates its effect on Allow once or Deny", async ({
  signal,
}) => {
  const gate = createTestGate(signal);
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
      packages: [{ kind: "plugin", source: "clawhub", ref: packageName, version }],
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
    },
  });
  clawhub.artifact.mockResolvedValue({ version: { version, sha256hash: archive.integrity } });
  clawhub.security.mockResolvedValue(
    clawHubSecurityResponse(packageName, version, { moderationState: "approved" }),
  );
  clawhub.download.mockResolvedValue({ ...archive, cleanup: async () => {} });

  const env: Record<string, string | undefined> = {
    HOME: home,
    OPENCLAW_HOME: home,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_CLAWHUB_URL: undefined,
    CLAWHUB_URL: undefined,
    OPENCLAW_GATEWAY_URL: undefined,
    OPENCLAW_GATEWAY_TOKEN: undefined,
    OPENCLAW_GATEWAY_PASSWORD: undefined,
    OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
  };
  const envSnapshot = captureEnv([...MANUAL_GATEWAY_ENV_KEYS, ...Object.keys(env)]);
  let server: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
  let caller: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
  let reviewer: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
  try {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) {
        deleteTestEnvValue(key);
      } else {
        setTestEnvValue(key, value);
      }
    }
    configureManualGatewayBackgroundEnv(home);

    const source = await readClawManifestFile(manifestPath);
    assert(source.ok, "Expected a valid Claw package");
    const plan = await buildGatewayClawAddPlan(source, { config, sourceMcpServers: {} });
    expect(plan.blockers).toEqual([]);
    const review = projectClawPluginCapabilityReviews(plan)[0];
    assert(review?.pluginId === "lobster", "Expected an official lobster capability review");
    const pluginConsent = bindClawPluginInstallConsent([review], [review], () => {});
    const added = await applyClawAddPlanStateless(plan, {
      config,
      consentPlanIntegrity: plan.planIntegrity,
      pluginConsent,
    });
    expect(added.status).toBe("complete");
    expect((await readPersistedInstalledPluginIndexInstallRecordsAsync())?.lobster).toMatchObject({
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
    const connection = { url, token, timeoutMs: 60_000 };
    reviewer = await connectGatewayClient({
      ...connection,
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
    });
    caller = await connectGatewayClient({
      ...connection,
      clientDisplayName: "write-only plugin tool caller",
      scopes: [WRITE_SCOPE],
      requestTimeoutMs: 15_000,
    });
    const invoke = () =>
      caller!.request("tools.invoke", {
        name: "approval_probe",
        agentId: "approval-claw",
        sessionKey: "agent:approval-claw:main",
        args: {},
      });

    const reviewEffect = async (decision: "allow-once" | "deny", before: () => Promise<void>) => {
      requested = createDeferredCore<string>();
      const pending = invoke();
      const id = await gate(requested.promise, pending, "Tool settled before requesting approval");
      await before();
      await withinTest(reviewer!.request("plugin.approval.resolve", { id, decision }), signal);
      await expect(withinTest(pending, signal)).resolves.toMatchObject({
        ok: true,
        output: { content: [{ type: "text", text: decision }] },
      });
      expect(await fs.readFile(markerPath, "utf8")).toBe("approved\n");
    };
    await reviewEffect("allow-once", async () => {
      await expect(fs.readFile(markerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    });
    await reviewEffect("deny", async () => {
      expect(await fs.readFile(markerPath, "utf8")).toBe("approved\n");
    });

    expect(
      getActiveRuntimePluginRegistry()?.plugins.find((plugin) => plugin.id === "lobster"),
    ).toMatchObject({
      status: "loaded",
      trustedOfficialInstall: true,
      trust: { reason: "trusted-official" },
    });
  } finally {
    try {
      for (const client of [caller, reviewer]) {
        if (client) {
          await disconnectGatewayClient(client).catch(() => undefined);
        }
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
