import { once } from "node:events";
import { createServer } from "node:http";
import { expect, it } from "vitest";
import type { ModelsListResult } from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";
import {
  observeCatalogWorkerTasks,
  waitForCatalogPublication,
} from "./models-auth-catalog.test-support.js";
import {
  catalogDiscoverySource,
  writeCatalogPlugin,
} from "./models-catalog-fixture.test-support.js";
import {
  closeModelsEndpoint,
  createModelsTestState,
  listenModelsEndpoint,
  modelsTestConfig,
  startModelsGateway,
  writeAuthStoreExternally,
} from "./models-integration.test-support.js";

it("models.authRefresh retains same-account rows while renewing and discovers a replacement account", async ({
  signal,
}) => {
  await using state = await createModelsTestState("models-auth-refresh-catalog");
  const provider = "renewal-fixture";
  const catalogWork = observeCatalogWorkerTasks();
  const initialRefreshReturned = createDeferred();
  const requests: string[] = [];
  let holdDiscovery = false;
  const heldResponses: Array<() => void> = [];
  let releasedHeldResponses = 0;
  const accounts = new Map([
    ["Bearer account-one-original", "account-one"],
    ["Bearer account-one-renewed", "account-one"],
    ["Bearer account-two-original", "account-two"],
  ]);
  const discovery = createServer((request, response) => {
    const authorization = request.headers.authorization ?? "";
    requests.push(authorization);
    const account = accounts.get(authorization);
    if (request.url !== "/models" || !account) {
      response.writeHead(401).end();
      return;
    }
    response.setHeader("Content-Type", "application/json");
    const reply = () =>
      response.end(JSON.stringify([{ id: `${account}-learned`, name: `${account} learned` }]));
    if (holdDiscovery) {
      heldResponses.push(() => {
        releasedHeldResponses++;
        reply();
      });
    } else if (requests.length === 1) {
      // Keep publication pending after the foreground refresh has returned.
      void initialRefreshReturned.promise.then(() => {
        setTimeout(reply, 1_500);
      });
    } else {
      reply();
    }
  });
  const accountStore = (accountId: string, access: string): AuthProfileStore => ({
    version: 1,
    profiles: {
      [`${provider}:primary`]: {
        type: "oauth",
        provider,
        accountId,
        email: `${accountId}@example.invalid`,
        access,
        refresh: `${access}-refresh`,
        expires: Date.now() + 3_600_000,
      },
    },
  });
  try {
    const baseUrl = await listenModelsEndpoint(discovery);
    const pluginPath = await writeCatalogPlugin(
      state,
      provider,
      `module.exports = {
          id: ${JSON.stringify(provider)},
          register(api) {
            api.registerProvider({
              id: ${JSON.stringify(provider)}, label: "Renewal fixture", auth: [],
              formatApiKey: (credential) => credential.access,
              ${catalogDiscoverySource(provider, baseUrl, { error: "Fixture discovery rejected credentials" })},
            });
          },
        };`,
    );
    const token = "catalog-renewal-gateway-token";
    const cfg = modelsTestConfig(state, token, {
      agents: {
        defaults: { modelPolicy: { allow: [`${provider}/*`] } },
      },
      plugins: {
        allow: [provider],
        load: { paths: [pluginPath] },
        slots: { memory: "none" },
      },
    });
    await state.writeConfig(cfg);
    const agentDatabasePath = await state.writeAuthProfiles(
      accountStore("account-one", "account-one-original"),
    );
    const writePersistedAuthProfiles = (store: AuthProfileStore) =>
      writeAuthStoreExternally(state, agentDatabasePath, store);
    await using gateway = await startModelsGateway(state, cfg, token);
    const { client } = gateway;
    try {
      await gateway.server.startupSettled;
      const list = async (refresh = false) => {
        const result = await client.request<ModelsListResult>("models.list", {
          agentId: "main",
          view: "all",
          refresh,
        });
        return result.models.filter((model) => model.provider === provider);
      };
      const waitForIdle = () =>
        waitForCatalogPublication({
          signal,
          read: async () => catalogWork.read().pendingTasks,
          ready: (pending) => pending === 0,
        });
      const original = await waitForCatalogPublication({
        signal,
        start: async () => {
          const result = await list(true);
          initialRefreshReturned.resolve();
          return result;
        },
        read: list,
        ready: (models) => models.some((model) => model.id === "account-one-learned"),
      });
      expect(original.map((model) => model.id)).toEqual(["account-one-learned"]);
      expect(new Set(requests)).toEqual(new Set(["Bearer account-one-original"]));
      await waitForIdle();
      const initialRequests = requests.length;
      const initialTasks = catalogWork.read().completedTasks;
      const renewalRequest = once(discovery, "request");
      await writePersistedAuthProfiles(accountStore("account-one", "account-one-renewed"));
      await expect(
        client.request("models.authRefresh", { agentId: "main", operation: "update" }),
      ).resolves.toEqual({ refreshed: true });
      expect((await list()).map((model) => model.id)).toEqual(["account-one-learned"]);
      await renewalRequest;
      await waitForIdle();
      expect(requests.slice(initialRequests)).toEqual(["Bearer account-one-renewed"]);
      expect(catalogWork.read()).toMatchObject({
        workersCreated: 1,
        completedTasks: initialTasks + 1,
      });
      const renewedRequests = requests.length;
      const renewedTasks = catalogWork.read().completedTasks;
      const replacementRequest = once(discovery, "request");
      await writePersistedAuthProfiles(accountStore("account-two", "account-two-original"));
      await client.request("models.authRefresh", { agentId: "main", operation: "login" });
      expect((await list()).map((model) => model.id)).not.toContain("account-one-learned");
      await replacementRequest;
      const replacement = await waitForCatalogPublication({
        signal,
        read: list,
        ready: (models) => models.some((model) => model.id === "account-two-learned"),
      });
      expect(replacement.map((model) => model.id)).toEqual(["account-two-learned"]);
      expect(requests.slice(renewedRequests)).toEqual(["Bearer account-two-original"]);
      expect(catalogWork.read()).toMatchObject({
        maxWorkers: 1,
        workersCreated: 1,
        pendingTasks: 0,
        completedTasks: renewedTasks + 1,
      });

      holdDiscovery = true;
      const heldRequest = once(discovery, "request");
      const refreshSettled = Promise.allSettled([
        client.request("models.list", { agentId: "main", provider, refresh: true }),
      ]);
      await heldRequest;
      try {
        expect(heldResponses).toHaveLength(1);
        expect(catalogWork.read().pendingTasks).toBeGreaterThan(0);
        await writePersistedAuthProfiles({ version: 1, profiles: {} });
        await expect(
          client.request("models.authRefresh", { agentId: "main", operation: "logout" }),
        ).resolves.toEqual({ refreshed: true });
        // Revocation must publish while the old discovery response is still withheld.
        const revoked = await list();
        expect(revoked.filter((model) => model.available)).toEqual([]);
        expect(revoked.map((model) => model.id)).not.toContain("account-two-learned");
        expect(releasedHeldResponses).toBe(0);
      } finally {
        for (const reply of heldResponses) {
          reply();
        }
      }
      await refreshSettled;
      expect((await list()).filter((model) => model.available)).toEqual([]);
      expect((await list()).map((model) => model.id)).not.toContain("account-two-learned");
    } finally {
      initialRefreshReturned.resolve();
    }
  } finally {
    initialRefreshReturned.resolve();
    catalogWork.close();
    await closeModelsEndpoint(discovery);
  }
});
