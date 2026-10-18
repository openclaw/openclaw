import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import beamPlugin from "../../extensions/beam/index.js";
import { sampleUpload } from "../../extensions/beam/src/beam-store.test-support.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import type { ResolvedGatewayAuth } from "../../src/gateway/auth.js";
import { createTestGatewayServer } from "../../src/gateway/server-http.test-harness.js";
import {
  createGatewayPluginRequestHandler,
  shouldEnforceGatewayAuthForPluginPath,
} from "../../src/gateway/server/plugins-http.js";
import { withTempConfig } from "../../src/gateway/test-temp-config.js";
import { createSubsystemLogger } from "../../src/logging/subsystem.js";
import { closePluginStateDatabase } from "../../src/plugin-state/plugin-state-store.sqlite.js";
import { createPluginRecord } from "../../src/plugins/loader-records.js";
import { createPluginRegistry } from "../../src/plugins/registry.js";
import {
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../../src/plugins/runtime.js";
import { createPluginRuntime } from "../../src/plugins/runtime/index.js";
import { listProfiles } from "../../src/state/user-profiles.js";
import { withOpenClawTestState } from "../../src/test-utils/openclaw-test-state.js";
import { closeHttpServer, listenLoopback } from "../helpers/gateway-integration-fixtures.js";

const routePath = "/api/v1/beam/sessions";
const log = createSubsystemLogger("test/beam-http-identity");
const proxyAuth: ResolvedGatewayAuth = {
  mode: "trusted-proxy",
  allowTailscale: false,
  trustedProxy: { userHeader: "x-forwarded-user", allowLoopback: true },
};
const tokenAuth: ResolvedGatewayAuth = {
  mode: "token",
  allowTailscale: false,
  token: "synthetic-beam-operator-token",
};

function registerBeam(config: OpenClawConfig) {
  const builder = createPluginRegistry({
    runtime: createPluginRuntime(),
    logger: log,
    activateGlobalSideEffects: false,
  });
  const record = createPluginRecord({
    id: "beam",
    source: fileURLToPath(new URL("../../extensions/beam/index.ts", import.meta.url)),
    origin: "bundled",
    enabled: true,
    configSchema: true,
  });
  builder.registry.plugins.push(record);
  beamPlugin.register(builder.createApi(record, { config }));
  setActivePluginRegistry(builder.registry);
  const catalog = builder.registry.sessionCatalogs.find((entry) => entry.provider.id === "beam");
  if (!catalog) {
    throw new Error("Beam did not register its session catalog");
  }
  return { registry: builder.registry, catalog: catalog.provider };
}

async function withBeamHttpServer(
  auth: ResolvedGatewayAuth,
  run: (origin: string, registration: ReturnType<typeof registerBeam>) => Promise<void>,
) {
  const cfg: OpenClawConfig = {
    agents: { entries: { main: {} } },
    gateway: { auth, trustedProxies: ["127.0.0.1", "::1"] },
    plugins: { entries: { beam: { enabled: true } } },
  };
  await withTempConfig({
    cfg,
    run: async () => {
      const registration = registerBeam(cfg);
      const { registry } = registration;
      const server = createTestGatewayServer({
        resolvedAuth: auth,
        overrides: {
          handlePluginRequest: createGatewayPluginRequestHandler({ registry, log }),
          shouldEnforcePluginGatewayAuth: (pathContext) =>
            shouldEnforceGatewayAuthForPluginPath(registry, pathContext),
        },
      });
      const origin = await listenLoopback(server);
      try {
        await run(origin, registration);
      } finally {
        await closeHttpServer(server);
        resetPluginRuntimeStateForTest();
        closePluginStateDatabase();
      }
    },
  });
}

async function upload(
  origin: string,
  beamId: string,
  text: string,
  headers: Record<string, string>,
) {
  const response = await fetch(`${origin}${routePath}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(
      sampleUpload({
        beamId,
        updatedAt: new Date().toISOString(),
        completed: true,
        items: [
          { type: "userMessage", text },
          { type: "agentMessage", text: "Synthetic reply" },
        ],
      }),
    ),
    signal: AbortSignal.timeout(10_000),
  });
  const body: unknown = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(200);
  expect(body).toMatchObject({ ok: true, beamId });
}

async function expectPublisher(
  catalog: ReturnType<typeof registerBeam>["catalog"],
  threadId: string,
  profileId: string,
  text?: string,
) {
  const { items } = await catalog.read({ agentId: "main", hostId: "gateway", threadId });
  const user = items.find((item) => item.type === "userMessage");
  expect(user?.sender).toEqual({ identity: { type: "profile", id: profileId } });
  expect(items.find((item) => item.type === "agentMessage")?.sender).toBeUndefined();
  if (text !== undefined) {
    expect(user).toMatchObject({ text });
  }
}

it("persists real HTTP principals through registry scope and uses owner attribution for shared-token replacement", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const firstBeamId = "a".repeat(32);
    const secondBeamId = "b".repeat(32);
    const principals = ["alice@example.test", "bob@example.test"];
    const profileIds: string[] = [];

    await withBeamHttpServer(proxyAuth, async (origin, { catalog }) => {
      expect(await listProfiles()).toEqual([]);
      for (const [index, principal] of principals.entries()) {
        const beamId = index === 0 ? firstBeamId : secondBeamId;
        await upload(origin, beamId, `Question from ${principal}`, {
          "x-forwarded-user": principal,
          "x-forwarded-for": "198.51.100.20",
        });
        const profile = (await listProfiles()).find((candidate) =>
          candidate.emails.includes(principal),
        );
        expect(profile).toBeDefined();
        profileIds.push(profile!.id);
        await expectPublisher(catalog, beamId, profile!.id);
      }
      expect(new Set(profileIds).size).toBe(2);
    });

    // Re-register after closing SQLite: the uploader must come from the saved
    // snapshot, never a retained request or the reader's current identity.
    await withBeamHttpServer(tokenAuth, async (origin, { catalog }) => {
      for (const [index, beamId] of [firstBeamId, secondBeamId].entries()) {
        await expectPublisher(catalog, beamId, profileIds[index]!);
      }
      await upload(origin, firstBeamId, "Shared-token replacement", {
        authorization: `Bearer ${tokenAuth.token}`,
        "x-forwarded-user": principals[0]!,
        "x-forwarded-for": "198.51.100.20",
      });
      const ownerProfile = (await listProfiles()).find((profile) => profile.emails.length === 0);
      expect(ownerProfile).toBeDefined();
      expect(profileIds).not.toContain(ownerProfile!.id);
      await expectPublisher(catalog, firstBeamId, ownerProfile!.id, "Shared-token replacement");
      await expectPublisher(catalog, secondBeamId, profileIds[1]!);
      expect(await listProfiles()).toHaveLength(3);
    });
  });
});
