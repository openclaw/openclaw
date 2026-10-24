import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HelloOk } from "../../packages/gateway-protocol/src/index.js";
import type { ClawLifecyclePlanResult } from "../../packages/gateway-protocol/src/schema/claws.js";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
} from "../infra/device-identity.js";
import { approveDevicePairing } from "../infra/device-pairing-approval.js";
import { rotateDeviceToken } from "../infra/device-pairing-tokens.js";
import { requestDevicePairing } from "../infra/device-pairing.js";
import { clawHubSecurityResponse } from "../plugins/clawhub.test-fixtures.js";
import { createClawHubArchiveFactory } from "../plugins/clawhub.test-support.js";
import { readPersistedInstalledPluginIndexInstallRecordsAsync } from "../plugins/installed-plugin-index-records.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { GatewayClient, type GatewayClientOptions } from "./client.js";
import { startGatewayServerCore } from "./server-start.js";
import { KERNEL_TEST_ENV } from "./test-helpers.env.js";
import { acquireGatewayE2ePortBlock, startClaimedGateway } from "./test-helpers.listener.js";

const token = "claw-add-authority-test-token";
const version = "1.0.0";
const clawhub = vi.hoisted(() => ({
  detail: vi.fn(),
  artifact: vi.fn(),
  download: vi.fn(),
  security: vi.fn(),
  pauseBeforeEffect: async () => {},
  installSettled: (_error?: unknown) => {},
  officialCatalog: vi.fn(async () => ({ source: "hosted" as const, entries: [] })),
}));

// Only remote ClawHub responses are fixed; source verification and installation stay real.
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
vi.mock("../plugins/management-mutations.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/management-mutations.js")>();
  return {
    ...actual,
    installManagedPlugin: async (params: Parameters<typeof actual.installManagedPlugin>[0]) => {
      try {
        const result = await actual.installManagedPlugin({
          ...params,
          beforePersistentEffect: async () => {
            await clawhub.pauseBeforeEffect();
            await params.beforePersistentEffect?.();
          },
        });
        clawhub.installSettled();
        return result;
      } catch (error) {
        clawhub.installSettled(error);
        throw error;
      }
    },
  };
});

type Fixture = {
  clawName: string;
  pluginName: string;
  pluginId: string;
  agentId: string;
  clawArchive: Awaited<ReturnType<ReturnType<typeof createClawHubArchiveFactory>>>;
  pluginArchive: Awaited<ReturnType<ReturnType<typeof createClawHubArchiveFactory>>>;
  clawSha256: string;
};

const createArchive = createClawHubArchiveFactory(afterEach);

async function makeFixture(label: string): Promise<Fixture> {
  const clawName = `@openclaw/${label}-claw`;
  const pluginName = `@openclaw/${label}-plugin`;
  const pluginId = `${label}-plugin`;
  const agentId = `${label}-claw`;
  const clawArchive = await createArchive({
    "package.json": JSON.stringify({ name: clawName, version, openclaw: { claw: "claw.json" } }),
    "CLAW.md": `# ${label} Claw\n`,
    "claw.json": JSON.stringify({
      schemaVersion: 1,
      agent: { id: agentId, name: `${label} Claw` },
      workspace: { bootstrapFiles: {}, files: [] },
      packages: [{ kind: "plugin", source: "clawhub", ref: pluginName, version }],
      mcpServers: {},
      cronJobs:
        label === "allowed"
          ? [
              {
                id: "daily-probe",
                schedule: { cron: "0 8 * * *", timezone: "UTC" },
                session: "isolated",
                message: "Report the synthetic probe status.",
              },
            ]
          : [],
    }),
  });
  const pluginArchive = await createArchive({
    "package.json": JSON.stringify({
      name: pluginName,
      version,
      type: "commonjs",
      main: "index.cjs",
      openclaw: { extensions: ["./index.cjs"] },
    }),
    "openclaw.plugin.json": JSON.stringify({
      id: pluginId,
      contracts: { tools: [`${label}_probe`] },
      configSchema: { type: "object" },
    }),
    "index.cjs": `module.exports = { id: ${JSON.stringify(pluginId)}, register(api) {
      api.registerTool({ name: ${JSON.stringify(`${label}_probe`)}, description: "Probe",
        parameters: { type: "object", properties: {} },
        execute: async () => ({ content: [{ type: "text", text: "ready" }] }) });
    } };`,
  });
  const clawSha256 = createHash("sha256")
    .update(await fs.readFile(clawArchive.archivePath))
    .digest("hex");
  return { clawName, pluginName, pluginId, agentId, clawArchive, pluginArchive, clawSha256 };
}

function setClawHubFixtures(fixtures: Fixture[]) {
  const byName = new Map<string, { fixture: Fixture; kind: "claw" | "plugin" }>(
    fixtures.flatMap((fixture) => [
      [fixture.clawName, { fixture, kind: "claw" as const }],
      [fixture.pluginName, { fixture, kind: "plugin" as const }],
    ]),
  );
  const lookup = (name: string) => {
    const found = byName.get(name);
    if (!found) {
      throw new Error(`Unexpected ClawHub request for ${name}`);
    }
    return found;
  };
  clawhub.detail.mockImplementation(async ({ name }: { name: string }) => {
    const { fixture, kind } = lookup(name);
    return {
      package: {
        name,
        displayName: name,
        family: kind === "claw" ? "claw" : "code-plugin",
        channel: "official",
        isOfficial: true,
        ownerHandle: "openclaw",
        ...(kind === "plugin" ? { runtimeId: fixture.pluginId } : {}),
        latestVersion: version,
        createdAt: 0,
        updatedAt: 0,
      },
      owner: { handle: "openclaw" },
    };
  });
  clawhub.artifact.mockImplementation(async ({ name }: { name: string }) => {
    const { fixture, kind } = lookup(name);
    return kind === "claw"
      ? {
          package: { name, family: "claw" },
          version,
          artifact: {
            kind: "npm-pack",
            sha256: fixture.clawSha256,
            npmIntegrity: "sha512-test-fixture",
          },
        }
      : { version: { version, sha256hash: fixture.pluginArchive.integrity } };
  });
  clawhub.security.mockImplementation(async ({ name }: { name: string }) => {
    const { fixture, kind } = lookup(name);
    return {
      ...clawHubSecurityResponse(name, version, { moderationState: "approved" }),
      package: { name, displayName: name, family: kind === "claw" ? "claw" : "code-plugin" },
      securityAuditUrl: `https://clawhub.ai/${kind}s/${name}/security-audit`,
      release:
        kind === "claw"
          ? {
              version,
              artifactKind: "npm-pack",
              artifactSha256: fixture.clawSha256,
              npmIntegrity: "sha512-test-fixture",
            }
          : { version },
    };
  });
  clawhub.download.mockImplementation(async ({ name }: { name: string }) => {
    const { fixture, kind } = lookup(name);
    return kind === "claw"
      ? {
          archivePath: fixture.clawArchive.archivePath,
          artifact: "clawpack",
          sha256Hex: fixture.clawSha256,
          npmIntegrity: "sha512-test-fixture",
          cleanup: async () => {},
        }
      : { ...fixture.pluginArchive, cleanup: async () => {} };
  });
}

describe("Claw Add dependency consent authority (real Gateway RPC)", () => {
  it("publishes for admin, rejects read-only, and fences a revoked admin before effect", async ({
    signal,
  }) => {
    const state = await createOpenClawTestState({
      label: "claw-add-authority",
      env: {
        ...KERNEL_TEST_ENV,
        OPENCLAW_CLAWHUB_URL: undefined,
        CLAWHUB_URL: undefined,
        OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      },
    });
    const clients: GatewayClient[] = [];
    const release = createDeferredCore();
    const recoveryRestart = vi.fn(() => {
      throw new Error("Claw Add must hot-apply without a recovery restart");
    });
    let server: Awaited<ReturnType<typeof startGatewayServerCore>> | undefined;
    try {
      const [allowedFixture, revokedFixture] = await Promise.all([
        makeFixture("allowed"),
        makeFixture("revoked"),
      ]);
      setClawHubFixtures([allowedFixture, revokedFixture]);
      const claim = await acquireGatewayE2ePortBlock();
      const port = claim.port;
      await state.writeConfig({
        gateway: {
          mode: "local",
          bind: "loopback",
          auth: { mode: "token", token },
          controlUi: { enabled: false, experimental: { claws: true } },
        },
        logging: { level: "silent", consoleLevel: "silent" },
        agents: { defaults: { workspace: state.workspaceDir } },
      });
      server = await startClaimedGateway(claim, () =>
        startGatewayServerCore(port, {
          controlUiEnabled: false,
          hotReloadRecovery: recoveryRestart,
        }),
      );
      await server.startupSettled;

      const connect = async (options: {
        scopes: string[];
        token?: string;
        deviceToken?: string;
        deviceIdentity?: GatewayClientOptions["deviceIdentity"];
      }) => {
        const ready = createDeferredCore<HelloOk>();
        const closed = createDeferredCore();
        const client = new GatewayClient({
          url: `ws://127.0.0.1:${port}`,
          clientName: options.deviceToken ? "test" : "gateway-client",
          clientVersion: "1.0.0",
          platform: "test",
          mode: options.deviceToken ? "test" : "backend",
          deviceIdentity: null,
          ...options,
          hostDeps: {
            loadDeviceAuthToken: () => null,
            storeDeviceAuthToken: () => {},
            clearDeviceAuthToken: () => {},
          },
          onHelloOk: (hello) => ready.resolve(hello),
          onConnectError: (error) => ready.reject(error),
          onClose: () => closed.resolve(),
        });
        clients.push(client);
        client.start();
        const hello = await withinTest(ready.promise, signal);
        expect(hello.auth.scopes).toEqual(expect.arrayContaining(options.scopes));
        return { client, closed: closed.promise };
      };

      const admin = await connect({ scopes: ["operator.read", "operator.admin"], token });
      const reader = await connect({ scopes: ["operator.read"], token });
      const source = (fixture: Fixture) => ({ packageName: fixture.clawName, version });
      const plan = async (client: GatewayClient, fixture: Fixture) =>
        await client.request<ClawLifecyclePlanResult>("claws.add.plan", {
          source: source(fixture),
        });
      const applyParams = (fixture: Fixture, reviewed: ClawLifecyclePlanResult) => ({
        source: source(fixture),
        planIntegrity: reviewed.planIntegrity,
        acknowledgeCapabilities: reviewed.pluginReviews.map((review) => ({
          actionId: review.actionId,
          pluginId: review.pluginId,
          reviewToken: review.reviewToken,
          capabilityGrants: review.capabilityGrants,
          capabilityGrantsByPluginId: review.capabilityGrantsByPluginId,
          ...(review.riskWarning ? { acknowledgeRiskWarning: true } : {}),
        })),
      });
      const installed = async (fixture: Fixture) => {
        const config = JSON.parse(await fs.readFile(state.configPath, "utf8")) as OpenClawConfig;
        const records = await readPersistedInstalledPluginIndexInstallRecordsAsync();
        const extension = await fs
          .stat(state.statePath("extensions", fixture.pluginId))
          .catch(() => null);
        return {
          agent: config.agents?.entries?.[fixture.agentId],
          plugin: records?.[fixture.pluginId],
          extension: Boolean(extension),
        };
      };
      const expectNotInstalled = async (fixture: Fixture) => {
        expect(await installed(fixture)).toEqual({
          agent: undefined,
          plugin: undefined,
          extension: false,
        });
      };

      const allowedPlan = await plan(reader.client, allowedFixture);
      expect(allowedPlan.pluginReviews).toHaveLength(1);
      expect(allowedPlan.blockers).toEqual([]);
      await expect(
        reader.client.request("claws.add.apply", applyParams(allowedFixture, allowedPlan)),
      ).rejects.toThrow("missing scope: operator.admin");
      await expectNotInstalled(allowedFixture);

      const allowed = await admin.client.request<{ status: string }>(
        "claws.add.apply",
        applyParams(allowedFixture, allowedPlan),
      );
      expect(allowed, JSON.stringify(allowed)).toMatchObject({ status: "complete" });
      const schedules = await admin.client.request<{
        jobs: Array<{ agentId: string; declarationKey: string }>;
      }>("cron.list", { includeDisabled: true });
      expect(schedules.jobs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            agentId: allowedFixture.agentId,
            declarationKey: "claw:allowed-claw:daily-probe",
          }),
        ]),
      );
      expect(await installed(allowedFixture)).toMatchObject({
        agent: expect.objectContaining({}),
        plugin: { source: "clawhub" },
        extension: true,
      });

      const revokedPlan = await plan(admin.client, revokedFixture);
      expect(revokedPlan.pluginReviews).toHaveLength(1);
      expect(revokedPlan.blockers).toEqual([]);
      const identity = loadOrCreateDeviceIdentity({
        path: state.path("revoked-identity", "client", "credentials.sqlite"),
      });
      const pendingPairing = await requestDevicePairing({
        deviceId: identity.deviceId,
        publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
        clientId: "test",
        clientMode: "test",
        role: "operator",
        scopes: ["operator.read", "operator.admin"],
      });
      await approveDevicePairing(pendingPairing.request.requestId, {
        callerScopes: ["operator.admin"],
      });
      const issued = await rotateDeviceToken({
        deviceId: identity.deviceId,
        role: "operator",
        scopes: ["operator.read", "operator.admin"],
      });
      if (!issued.ok) {
        throw new Error("Could not issue synthetic device token");
      }
      const device = await connect({
        scopes: ["operator.read", "operator.admin"],
        deviceIdentity: identity,
        deviceToken: issued.entry.token,
      });
      const reached = createDeferredCore();
      const settled = createDeferredCore<unknown>();
      clawhub.pauseBeforeEffect = async () => {
        reached.resolve();
        await release.promise;
      };
      clawhub.installSettled = (error) => settled.resolve(error);
      const request = device.client.request(
        "claws.add.apply",
        applyParams(revokedFixture, revokedPlan),
      );
      const reply = request.then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
      await awaitGateBeforeSettlement(
        reached.promise,
        reply,
        "Claw Add settled before final effect",
      );
      await expectNotInstalled(revokedFixture);
      expect(recoveryRestart).not.toHaveBeenCalled();
      await admin.client.request("device.token.revoke", {
        deviceId: identity.deviceId,
        role: "operator",
      });
      await withinTest(device.closed, signal);
      release.resolve();
      expect(await withinTest(settled.promise, signal)).toBeDefined();
      await reply;
      await expectNotInstalled(revokedFixture);
    } finally {
      release.resolve();
      clawhub.pauseBeforeEffect = async () => {};
      clawhub.installSettled = () => {};
      await runQaGatewayFixture(
        async () => {},
        ...clients.map((client) => () => client.stopAndWait()),
        async () => server?.close(),
        () => state.cleanup(),
        () => clearPluginMetadataLifecycleCaches(),
      );
    }
  });
});
