import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { GATEWAY_CLIENT_CAPS } from "../../packages/gateway-protocol/src/client-info.js";
import { withinTest } from "../../test/helpers/promise.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { clearConfigCache } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getActiveRuntimePluginRegistry } from "../plugins/active-runtime-registry.js";
import { clawHubSecurityResponse } from "../plugins/clawhub.test-fixtures.js";
import { createClawHubArchiveFactory } from "../plugins/clawhub.test-support.js";
import { readPersistedInstalledPluginIndexInstallRecordsAsync } from "../plugins/installed-plugin-index-records.js";
import { createDeferredCore } from "../shared/deferred.js";
import { applyTemplateAddPlanStateless } from "../templates/add-stateless.js";
import { buildGatewayTemplateAddPlan } from "../templates/gateway-add-plan.js";
import { bindTemplatePluginInstallConsent } from "../templates/gateway-plugin-consent.js";
import { projectTemplatePluginCapabilityReviews } from "../templates/plugin-capability-review.js";
import { readTemplateManifestFile } from "../templates/reader.js";
import { setTestEnvValue } from "../test-utils/env.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { APPROVALS_SCOPE, WRITE_SCOPE } from "./method-scopes.js";
import { createTestGate } from "./server-close.lifecycle.test-support.js";
import { startGatewayServer } from "./server.js";
import { connectGatewayClient, disconnectGatewayClient } from "./test-helpers.e2e.js";
import { KERNEL_TEST_ENV } from "./test-helpers.env.js";
import { acquireGatewayE2ePortBlock, startClaimedGateway } from "./test-helpers.listener.js";
import { configureManualGatewayBackgroundEnv } from "./test-helpers.manual-gateway-env.js";

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

const createClawHubArchive = createClawHubArchiveFactory(afterEach);
const packageName = "@openclaw/lobster";
const version = "1.0.0";

it("lets the installed plugin request review and gates its effect on Allow once or Deny", async ({
  signal,
}) => {
  const gate = createTestGate(signal);
  const state = await createOpenClawTestState({
    label: "template-plugin-approval",
    env: {
      ...KERNEL_TEST_ENV,
      OPENCLAW_CLAWHUB_URL: undefined,
      CLAWHUB_URL: undefined,
      OPENCLAW_GATEWAY_URL: undefined,
      OPENCLAW_GATEWAY_TOKEN: undefined,
      OPENCLAW_GATEWAY_PASSWORD: undefined,
      OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
    },
  });
  let server: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
  let caller: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
  let reviewer: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
  try {
    const { home } = state;
    const templateDir = path.join(home, "template");
    const markerPath = path.join(home, "approved.log");
    await fs.mkdir(templateDir);
    const config: OpenClawConfig = {
      gateway: { mode: "local", controlUi: { experimental: { templates: true } } },
      agents: { entries: {} },
    };
    await state.writeConfig(config);
    const manifestPath = path.join(templateDir, "template.json");
    await fs.writeFile(
      manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        agent: { id: "approval-template", name: "Approval Template" },
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

    configureManualGatewayBackgroundEnv(home);

    const source = await readTemplateManifestFile(manifestPath);
    assert(source.ok, "Expected a valid Template package");
    const plan = await buildGatewayTemplateAddPlan(source, { config, sourceMcpServers: {} });
    expect(plan.blockers).toEqual([]);
    const review = projectTemplatePluginCapabilityReviews(plan)[0];
    assert(review?.pluginId === "lobster", "Expected an official lobster capability review");
    const pluginConsent = bindTemplatePluginInstallConsent([review], [review], () => {});
    const added = await applyTemplateAddPlanStateless(plan, {
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
    const token = "template-plugin-approval-e2e-token";
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
        agentId: "approval-template",
        sessionKey: "agent:approval-template:main",
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
    await runQaGatewayFixture(
      async () => {},
      ...[caller, reviewer].map((client) => async () => {
        if (client) {
          await disconnectGatewayClient(client);
        }
      }),
      async () => server?.close(),
      () => state.cleanup(),
      () => clearConfigCache(),
      () => vi.clearAllMocks(),
    );
  }
});
