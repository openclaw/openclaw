import { fileURLToPath } from "node:url";
import { createPluginStateKeyedStoreV2ForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { registerTestPlugin } from "openclaw/plugin-sdk/plugin-test-contracts";
import { expect, test } from "vitest";
import type {
  SessionsCatalogListResult,
  SessionsCatalogReadResult,
} from "../../packages/gateway-protocol/src/index.js";
import { loadOpenClawPluginsAsync } from "../plugins/loader.js";
import { projectPluginContributions } from "../plugins/registry-contributions.js";
import { createTestPluginRegistry } from "../plugins/registry-runtime.test-helpers.js";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import {
  BROWSER_ORIGIN,
  CONTROL_UI_CLIENT,
  TRUSTED_BROWSER_HEADERS,
  browserProxyAuth,
  configureBrowserAuth,
  connectReq,
  installGatewayTestHooks,
  openWs,
  rpcReq,
  withGatewayServer,
} from "./server.auth.test-helpers.js";
import { setTestPluginRegistry } from "./test-helpers.plugin-registry.js";

installGatewayTestHooks({ scope: "suite" });

test("HTTP Visitor publications are privately readable by their initial publisher through admitted RPC", async () => {
  const roles = {
    default: "guest",
    definitions: {
      guest: {
        accessPolicyPlugin: "visitor-access",
        sessions: { others: "view" as const },
        agents: "*" as const,
        scopes: ["operator.sessions.write" as const],
      },
      staff: {
        sessions: { others: "write" as const },
        agents: "*" as const,
        scopes: ["operator.admin" as const],
      },
      reader: {
        sessions: { others: "view" as const },
        agents: "*" as const,
        scopes: ["operator.read" as const],
      },
    },
  };
  await configureBrowserAuth(browserProxyAuth(), { roles });
  for (const role of ["staff", "reader"]) {
    setUserProfileRole(ensureProfileForEmail(role + "@example.test").id, role);
  }
  const grants = new Map(
    ["alice", "bob"].map((name) => [name + "@example.test", new AbortController()]),
  );
  const fixture = {
    config: {
      agents: { entries: { main: {} } },
      plugins: { entries: { beam: { enabled: true } } },
    },
    registry: createTestPluginRegistry(createPluginRuntime()),
  };
  registerTestPlugin({
    ...fixture,
    record: createPluginRecord({ id: "visitor-access", origin: "bundled" }),
    register(api) {
      api.registerGatewayAccessPolicy({
        authorize({ requiredByRole, profile }) {
          const grant = grants.get(profile.emails[0] ?? "");
          if (!requiredByRole) {
            return undefined;
          }
          if (!grant) {
            throw new Error("No synthetic Visitor invitation");
          }
          grant.signal.throwIfAborted();
          return {
            grantId: "synthetic-" + profile.profileId,
            signal: grant.signal,
            assertCurrent() {
              grant.signal.throwIfAborted();
            },
          };
        },
      });
    },
  });
  // The real loader captures the operation module source together with its instance.
  // A direct registration fixture has a lifetime, but no admitted operation-code owner.
  const registry = await loadOpenClawPluginsAsync({
    config: fixture.config,
    // The minimal Gateway fixture deliberately disables bundled discovery. Load only
    // Beam from this checkout without changing the Gateway's isolation environment.
    env: {
      ...process.env,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "0",
      OPENCLAW_BUNDLED_PLUGINS_DIR: fileURLToPath(new URL("../../extensions/", import.meta.url)),
    },
    onlyPluginIds: ["beam"],
    preferBuiltPluginArtifacts: false,
    activate: false,
    cache: false,
    throwOnLoadError: true,
  });
  expect(registry.plugins).toContainEqual(
    expect.objectContaining({ id: "beam", status: "loaded" }),
  );
  expect(registry.httpRoutes).toContainEqual(
    expect.objectContaining({ pluginId: "beam", path: "/api/v1/beam/sessions" }),
  );
  for (const record of fixture.registry.registry.plugins) {
    registry.plugins.push(record);
    projectPluginContributions(fixture.registry.registry, record, registry);
  }
  setTestPluginRegistry(registry);
  await withGatewayServer(async ({ port }) => {
    const connect = async (name: string) => {
      const ws = await openWs(port, {
        ...TRUSTED_BROWSER_HEADERS,
        "x-forwarded-user": name + "@example.test",
      });
      expect(
        (
          await connectReq(ws, {
            prePairDevice: true,
            client: CONTROL_UI_CLIENT,
            browserOrigin: BROWSER_ORIGIN,
            skipDefaultAuth: true,
            scopes: ["operator.read", "operator.write", "operator.sessions.write"],
          })
        ).ok,
      ).toBe(true);
      return ws;
    };
    const alice = await connect("alice"),
      bob = await connect("bob"),
      staff = await connect("staff"),
      reader = await connect("reader");
    const ids = ["a".repeat(32), "b".repeat(32), "c".repeat(32), "d".repeat(32)];
    // A retained pre-ownership snapshot is not claimable through matching uploader attribution.
    await createPluginStateKeyedStoreV2ForTests(
      "beam",
      {
        namespace: "sessions",
        maxEntries: 500,
        overflowPolicy: "evict-oldest",
        defaultTtlMs: 7 * 24 * 60 * 60 * 1000,
      },
      { assertCurrent() {} },
    ).register(ids[3]!, {
      version: 1,
      beamId: ids[3],
      title: "Legacy ownerless",
      source: "fixture",
      updatedAt: "2026-11-02T12:00:00Z",
      completed: true,
      createdAt: Date.now(),
      receivedAt: Date.now(),
      uploaderProfileId: ensureProfileForEmail("alice@example.test").id,
      items: [{ type: "userMessage", text: "Private legacy synthetic" }],
    });
    const upload = async (name: string, id: string, headers = {}) =>
      fetch(`http://127.0.0.1:${port}/api/v1/beam/sessions`, {
        method: "POST",
        headers: {
          ...TRUSTED_BROWSER_HEADERS,
          "x-forwarded-user": name + "@example.test",
          "x-openclaw-scopes":
            name === "staff"
              ? "operator.write"
              : name === "reader"
                ? "operator.read"
                : "operator.sessions.write",
          "content-type": "application/json",
          ...headers,
        },
        body: JSON.stringify({
          version: 1,
          beamId: id,
          title: "Synthetic " + name,
          source: "fixture",
          updatedAt: "2026-11-02T12:00:00Z",
          completed: true,
          items: [{ type: "userMessage", text: "Private synthetic " + name }],
        }),
      });
    try {
      const anonymous = await openWs(port, { origin: BROWSER_ORIGIN });
      try {
        expect(
          (
            await connectReq(anonymous, {
              prePairDevice: true,
              client: CONTROL_UI_CLIENT,
              browserOrigin: BROWSER_ORIGIN,
              skipDefaultAuth: true,
              scopes: ["operator.sessions.write"],
            })
          ).ok,
        ).toBe(false);
      } finally {
        anonymous.close();
      }
      const published = await upload("alice", ids[0]!);
      expect(published.status, await published.clone().text()).toBe(200);
      expect(await published.json()).toMatchObject({
        ok: true,
        canView: true,
        url: "/beam/synthetic-alice-aaaaaaaaaaaa",
      });
      expect((await upload("bob", ids[1]!)).status).toBe(200);
      expect((await upload("staff", ids[2]!)).status).toBe(200);
      expect((await upload("reader", ids[0]!)).status).toBe(403);
      expect(
        (await fetch(`http://127.0.0.1:${port}/api/v1/beam/sessions`, { method: "POST" })).status,
      ).toBe(401);
      // This is the original failure: shared catalog admission remains forbidden, not broadened.
      expect(
        await rpcReq(alice, "sessions.catalog.list", { search: "aaaaaaaaaaaa" }),
      ).toMatchObject({ ok: false, error: { message: "missing scope: operator.read" } });
      const own = await rpcReq<SessionsCatalogListResult>(alice, "beam.owned.list", {
        search: "aaaaaaaaaaaa",
        limitPerHost: 2,
      });
      expect(own.ok, JSON.stringify(own.error)).toBe(true);
      expect(own.payload?.catalogs[0]?.hosts[0]?.sessions).toMatchObject([
        { threadId: ids[0], canContinue: false, canArchive: false },
      ]);
      expect(JSON.stringify(own)).not.toContain("publisherProfileId");
      const request = { catalogId: "beam", hostId: "gateway", threadId: ids[0] };
      const page = await rpcReq<SessionsCatalogReadResult>(alice, "beam.owned.read", request);
      expect(page.ok, JSON.stringify(page.error)).toBe(true);
      expect(page.payload?.items).toEqual([
        {
          id: ids[0] + ":0",
          type: "userMessage",
          text: "Private synthetic alice",
          timestamp: "2026-11-02T12:00:00Z",
        },
      ]);
      expect((await upload("staff", ids[0]!)).status).toBe(200);
      const replaced = await rpcReq<SessionsCatalogReadResult>(alice, "beam.owned.read", request);
      expect(replaced.ok).toBe(true);
      expect(replaced.payload?.items[0]?.text).toBe("Private synthetic staff");
      expect(replaced.payload?.items[0]?.sender).toBeUndefined();
      for (const [ws, id] of [
        [bob, ids[0]],
        [alice, ids[1]],
        [alice, ids[2]],
        [alice, ids[3]],
        [reader, ids[0]],
      ] as const) {
        const denied = await rpcReq(ws, "beam.owned.read", { ...request, threadId: id });
        expect(denied.ok).toBe(false);
        if (ws !== reader) {
          expect(denied.error?.code).toBe("FORBIDDEN");
        }
        expect(JSON.stringify(denied)).not.toContain("Private");
      }
      expect(
        (await rpcReq<SessionsCatalogListResult>(alice, "beam.owned.list", {})).payload?.catalogs[0]
          ?.hosts[0]?.sessions,
      ).toHaveLength(1);
      expect((await rpcReq(staff, "sessions.catalog.read", request)).ok).toBe(true);
      expect((await rpcReq(alice, "sessions.catalog.archive", request)).ok).toBe(false);
      const revokedConnection = new Promise<number>((resolve) => {
        alice.once("close", resolve);
      });
      grants.get("alice@example.test")!.abort(new Error("synthetic invitation expired or revoked"));
      expect(await revokedConnection).toBe(4001);
      expect(
        (
          await rpcReq(staff, "sessions.catalog.archive", {
            ...request,
            confirmNoOtherRunner: true,
          })
        ).ok,
      ).toBe(true);
    } finally {
      for (const ws of [alice, bob, staff, reader]) {
        ws.close();
      }
    }
  });
});
