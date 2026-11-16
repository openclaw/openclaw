import { once } from "node:events";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import type { ResolvedGatewayAuth } from "../../src/gateway/auth.js";
import { createTestGatewayServer } from "../../src/gateway/server-http.test-harness.js";
import {
  createGatewayPluginRequestHandler,
  shouldEnforceGatewayAuthForPluginPath,
} from "../../src/gateway/server/plugins-http.js";
import { withTempConfig } from "../../src/gateway/test-temp-config.js";
import { createSubsystemLogger } from "../../src/logging/subsystem.js";
import { loadOpenClawPluginsAsync } from "../../src/plugins/loader.js";
import {
  clearActivePluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../../src/plugins/runtime.js";
import { closeOpenClawStateDatabaseAsync } from "../../src/state/openclaw-state-db.js";
import { listProfiles } from "../../src/state/user-profiles.js";
import { withOpenClawTestState } from "../../src/test-utils/openclaw-test-state.js";

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

async function registerBeam(config: OpenClawConfig) {
  const registry = await loadOpenClawPluginsAsync({
    config,
    logger: log,
    onlyPluginIds: ["beam"],
    preferBuiltPluginArtifacts: false,
    activate: false,
    cache: false,
  });
  setActivePluginRegistry(registry);
  const catalog = registry.sessionCatalogs.find((entry) => entry.provider.id === "beam");
  if (!catalog) {
    throw new Error("Beam did not register its session catalog");
  }
  return { registry, catalog: catalog.provider };
}

async function withBeamHttpServer(
  auth: ResolvedGatewayAuth,
  run: (origin: string, registration: Awaited<ReturnType<typeof registerBeam>>) => Promise<void>,
) {
  const cfg: OpenClawConfig = {
    agents: { entries: { main: {} } },
    gateway: { auth, trustedProxies: ["127.0.0.1", "::1"] },
    plugins: { entries: { beam: { enabled: true } } },
  };
  await withTempConfig({
    cfg,
    run: async () => {
      const registration = await registerBeam(cfg);
      const { registry } = registration;
      const server = createTestGatewayServer({
        resolvedAuth: auth,
        overrides: {
          handlePluginRequest: createGatewayPluginRequestHandler({ registry, log }),
          shouldEnforcePluginGatewayAuth: (pathContext) =>
            shouldEnforceGatewayAuthForPluginPath(registry, pathContext),
        },
      });
      const listening = once(server, "listening");
      server.listen(0, "127.0.0.1");
      await listening;
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Beam test server did not bind a TCP port");
      }
      try {
        await run(`http://127.0.0.1:${address.port}`, registration);
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        });
        await clearActivePluginRegistry(registry);
        resetPluginRuntimeStateForTest();
        await closeOpenClawStateDatabaseAsync();
      }
    },
  });
}

function snapshot(beamId: string, text: string) {
  return {
    version: 1,
    beamId,
    source: "fixture",
    title: "Synthetic uploader identity proof",
    updatedAt: new Date().toISOString(),
    completed: true,
    items: [
      { type: "userMessage", text },
      { type: "agentMessage", text: "Synthetic reply" },
    ],
  };
}

async function upload(
  origin: string,
  beamId: string,
  text: string,
  headers: Record<string, string>,
  expectedStatus = 200,
) {
  const response = await fetch(`${origin}${routePath}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(snapshot(beamId, text)),
    signal: AbortSignal.timeout(10_000),
  });
  const textBody = await response.text();
  expect(response.status, textBody).toBe(expectedStatus);
  const body: unknown = JSON.parse(textBody);
  expect(body).toMatchObject(expectedStatus === 200 ? { ok: true, beamId } : { ok: false });
}

describe("Beam authenticated uploader identity", () => {
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
          await upload(
            origin,
            beamId,
            "Forbidden read-only replacement",
            {
              "x-forwarded-user": principal,
              "x-forwarded-for": "198.51.100.20",
              "x-openclaw-scopes": "operator.read",
            },
            403,
          );
          const page = await catalog.read({ agentId: "main", hostId: "gateway", threadId: beamId });
          expect(page.items.find((item) => item.type === "userMessage")?.text).toBe(
            `Question from ${principal}`,
          );
          expect(page.items.find((item) => item.type === "userMessage")?.sender).toEqual({
            identity: { type: "profile", id: profile!.id },
          });
          expect(page.items.find((item) => item.type === "agentMessage")?.sender).toBeUndefined();
        }
        expect(new Set(profileIds).size).toBe(2);
      });

      // Re-register after closing SQLite: the uploader must come from the saved
      // snapshot, never a retained request or the reader's current identity.
      await withBeamHttpServer(tokenAuth, async (origin, { catalog }) => {
        const read = (threadId: string) =>
          catalog.read({ agentId: "main", hostId: "gateway", threadId });
        for (const [index, beamId] of [firstBeamId, secondBeamId].entries()) {
          const page = await read(beamId);
          expect(page.items.find((item) => item.type === "userMessage")?.sender).toEqual({
            identity: { type: "profile", id: profileIds[index] },
          });
        }
        await upload(origin, firstBeamId, "Shared-token replacement", {
          authorization: `Bearer ${tokenAuth.token}`,
          "x-forwarded-user": principals[0]!,
          "x-forwarded-for": "198.51.100.20",
        });
        const replaced = await read(firstBeamId);
        expect(replaced.items.find((item) => item.type === "userMessage")).toMatchObject({
          text: "Shared-token replacement",
        });
        const ownerProfile = (await listProfiles()).find((profile) => profile.emails.length === 0);
        expect(ownerProfile).toBeDefined();
        expect(profileIds).not.toContain(ownerProfile!.id);
        expect(replaced.items.find((item) => item.type === "userMessage")?.sender).toEqual({
          identity: { type: "profile", id: ownerProfile!.id },
        });
        expect(replaced.items.find((item) => item.type === "agentMessage")?.sender).toBeUndefined();
        expect(
          (await read(secondBeamId)).items.find((item) => item.type === "userMessage")?.sender,
        ).toEqual({ identity: { type: "profile", id: profileIds[1] } });
        expect(await listProfiles()).toHaveLength(3);
      });
    });
  });
});
