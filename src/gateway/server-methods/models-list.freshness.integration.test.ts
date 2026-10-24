import { createServer, type ServerResponse } from "node:http";
import { expect, it, vi } from "vitest";
import type { ModelsListResult } from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { getPublishedPreparedModelCatalogOwnerSnapshot } from "../../agents/prepared-model-catalog.js";
import { resolvePreparedModelRuntimeOwnerBySnapshot } from "../../agents/prepared-model-runtime.owner.js";
import { waitForCatalogPublication } from "./models-auth-catalog.test-support.js";
import {
  catalogAgents,
  catalogModelDefaults,
  catalogModelIds,
  createCatalogAuthProfiles,
  createCatalogState,
  writeCatalogPlugin,
} from "./models-catalog-fixture.test-support.js";
import { serveModelsEndpoint, startModelsGateway } from "./models-integration.test-support.js";
import * as modelsListResult from "./models-list-result.js";

it.for([
  { withSibling: true, getterBacked: false, initiallyEmpty: false },
  { withSibling: false, getterBacked: true, initiallyEmpty: false },
  { withSibling: true, getterBacked: false, initiallyEmpty: true },
])(
  "models.list reuses inventory until explicit refresh (sibling: $withSibling, getter-backed: $getterBacked, empty: $initiallyEmpty)",
  { timeout: 120_000 },
  async ({ withSibling, getterBacked, initiallyEmpty }, { signal }) => {
    await using state = await createCatalogState("catalog-freshness");
    const provider = "freshness-fixture";
    const sibling = "a-failing-fixture";
    const providers = withSibling ? [sibling, provider] : [provider];
    let requests = 0;
    let hold = false;
    const renewal = createDeferred();
    let fail = false;
    let failSibling = false;
    const original = initiallyEmpty ? [] : ["original"];
    let advertised = original;
    const held: ServerResponse[] = [];
    const reply = (response: ServerResponse) => {
      response.writeHead(fail ? 503 : 200, { "content-type": "application/json" });
      response.end(JSON.stringify(advertised));
    };
    const release = () => {
      hold = false;
      for (const response of held.splice(0)) {
        reply(response);
      }
    };
    const endpoint = createServer((request, response) => {
      if (request.url === `/${sibling}`) {
        response.writeHead(failSibling ? 503 : 200, { "content-type": "application/json" });
        response.end(JSON.stringify(["sibling"]));
        return;
      }
      requests++;
      if (hold) {
        held.push(response);
        renewal.resolve();
      } else {
        reply(response);
      }
    });
    await using listening = await serveModelsEndpoint(endpoint);
    const { baseUrl } = listening;
    const pluginPath = await writeCatalogPlugin(
      state,
      providers,
      `module.exports = {
      id: ${JSON.stringify(provider)}, register(api) {
        for (const provider of ${JSON.stringify(providers)}) api.registerProvider({ id: provider, label: "Freshness fixture", auth: [],
          catalog: { order: "profile", async run(ctx) {
            const auth = ctx.resolveProviderAuth(provider);
            if (!auth.discoveryApiKey) return null;
            const { buildLiveModelProviderConfig, clearLiveCatalogCacheForTests } = await import("openclaw/plugin-sdk/provider-catalog-live-runtime");
            // The Gateway fixture controls inventory expiry; each acquisition crosses HTTP.
            clearLiveCatalogCacheForTests();
            const accepted = await buildLiveModelProviderConfig({
              providerId: provider, discoveryMode: "strict", discoveryApiKey: auth.discoveryApiKey,
              endpoint: ${JSON.stringify(baseUrl)} + "/" + provider, ttlMs: 86_400_000,
              providerConfig: { baseUrl: ${JSON.stringify(baseUrl)}, api: "openai-completions" }, models: [],
              fetchGuard: async ({ url, init }) => ({ response: await fetch(url, init), finalUrl: url, release: async () => {} }),
              readRows: body => body,
              projectRows: rows => rows.map(id => ({ id, name: id, ...${JSON.stringify(catalogModelDefaults())} })),
            });
            const outcomes = [{ provider, profileId: auth.profileId, status: "ready" }];
            if (${getterBacked}) {
              let evaluated = false;
              return { outcomes, get providers() {
                if (evaluated) return { "unaccepted-projection": accepted };
                evaluated = true;
                return { [provider]: accepted };
              } };
            }
            return { provider: accepted, outcomes };
          } },
        });
      },
    };`,
      { id: provider },
    );
    const token = "catalog-freshness-gateway-token";
    const cfg = {
      // A UI-only write must not also perform the fixture's first model-policy migration.
      meta: { migrations: { modelPolicyAllowlist: true, utilityModelSeparation: true } },
      agents: catalogAgents(state, { modelPolicy: { allow: providers.map((id) => `${id}/*`) } }),
      plugins: { allow: [provider], load: { paths: [pluginPath] }, slots: { memory: "none" } },
      gateway: { mode: "local", auth: { mode: "token", token } },
    };
    await state.writeConfig(cfg);
    await state.writeAuthProfiles(
      createCatalogAuthProfiles({
        [provider]: "freshness-account-key",
        ...(withSibling ? { [sibling]: "sibling-account-key" } : {}),
      }),
    );
    await using gateway = await startModelsGateway(state, cfg, token);
    const { client, server } = gateway;
    let requestedRefresh: Promise<unknown> | undefined;
    try {
      await server.startupSettled;
      const list = (refresh = false) =>
        client.request<ModelsListResult>("models.list", {
          agentId: "main",
          view: "all",
          refresh,
        });
      const ids = (result: ModelsListResult) => catalogModelIds(result, provider);
      const siblingIds = (result: ModelsListResult) => catalogModelIds(result, sibling);
      const initial = await waitForCatalogPublication({
        signal,
        // Startup discovers nonempty inventory; forcing refresh would bypass TTL renewal.
        start: initiallyEmpty ? () => list(true) : list,
        read: list,
        ready: (result) =>
          (initiallyEmpty
            ? !result.pendingProviders?.includes(provider)
            : ids(result).includes("original")) &&
          (!withSibling || siblingIds(result).includes("sibling")),
      });
      expect(ids(initial)).toEqual(original);
      const initialRequests = requests;
      if (!initiallyEmpty) {
        expect(initialRequests).toBe(1);
      }
      if (withSibling && !initiallyEmpty) {
        const projection = vi.spyOn(modelsListResult, "prepareModelsListResult");
        try {
          for (let index = 0; index < 6; index++) {
            const ack = await client.request<{ ok: boolean; config?: unknown }>("config.patch", {
              raw: JSON.stringify({ ui: { prefs: { chatShowToolCalls: index % 2 === 0 } } }),
              response: "summary",
            });
            expect(ack.ok).toBe(true);
            expect(ack).not.toHaveProperty("config");
            const after = await list();
            expect(after.models.filter((row) => row.provider === provider)).toEqual(
              initial.models.filter((row) => row.provider === provider),
            );
            expect(requests).toBe(initialRequests);
          }
          expect(projection.mock.calls.length).toBe(0);
          const noop = await client.request("config.patch", {
            raw: JSON.stringify({ ui: { prefs: { chatShowToolCalls: false } } }),
            response: "summary",
          });
          expect(noop).toMatchObject({ ok: true, noop: true, changedPaths: [] });
          expect(noop).not.toHaveProperty("config");
        } finally {
          projection.mockRestore();
        }
      }
      const owner = getPublishedPreparedModelCatalogOwnerSnapshot({ agentId: "main" });
      if (!owner?.readFullModelCatalog) {
        throw new Error("Missing published freshness fixture inventory");
      }
      const readPublished = async () => owner.readFullModelCatalog!();
      const expire = (providerIds: string[]) => {
        for (const id of providerIds) {
          const facts =
            resolvePreparedModelRuntimeOwnerBySnapshot(owner)?.catalogInventory?.providers.get(id);
          // Successful empty catalogs must carry the cache expiry too.
          expect(facts?.expiresAt).toEqual(expect.any(Number));
          facts!.expiresAt = 0;
        }
      };
      const acceptRenewal = async (start: () => unknown) => {
        const accepted = await readPublished();
        expect(accepted).toBeDefined();
        await waitForCatalogPublication({
          signal,
          start: async () => {
            await start();
            return readPublished();
          },
          read: readPublished,
          ready: (catalog) => catalog !== accepted,
        });
        return list();
      };
      hold = true;
      advertised = [...original, "newly-published"];
      if (initiallyEmpty) {
        expect(ids(await list())).toEqual([]);
        expect(requests).toBe(initialRequests);
      }
      // Arm the response hold before making any accepted inventory due.
      failSibling = withSibling && !initiallyEmpty;
      expire(withSibling && !initiallyEmpty ? providers : [provider]);
      // Expiring a provider response cache does not invalidate the published Gateway view.
      const saved = await withinTest(list(), signal);
      expect(ids(saved)).toEqual(original);
      expect(siblingIds(saved)).toEqual(withSibling ? ["sibling"] : []);
      expect(owner.readFullModelCatalog!()?.pendingProviders).toBeUndefined();
      expect(requests).toBe(initialRequests);
      requestedRefresh = list(true);
      void requestedRefresh.catch(() => undefined);
      await withinTest(renewal.promise, signal);
      const concurrent = await withinTest(Promise.all([list(), list()]), signal);
      expect(concurrent.map(ids)).toEqual([original, original]);
      expect(requests).toBe(initialRequests + 1);
      const renewed = await acceptRenewal(release);
      await requestedRefresh;
      expect(ids(renewed)).toEqual(["newly-published", ...original]);

      if (!withSibling || initiallyEmpty) {
        fail = true;
        expire([provider]);
        await list(true);
      }
      const failed = await waitForCatalogPublication({
        signal,
        read: list,
        ready: (result) => result.refreshFailed === true,
      });
      expect(failed.refreshFailed).toBe(true);
      if (withSibling && !initiallyEmpty) {
        advertised = ["original", "newly-published", "after-sibling-failure"];
        const afterSiblingFailure = await acceptRenewal(() => {
          expire([provider]);
          return list(true);
        });
        expect(ids(afterSiblingFailure)).toEqual([
          "after-sibling-failure",
          "newly-published",
          "original",
        ]);
        expect((await list()).refreshFailed).toBe(true);
      } else {
        const failedRequests = requests;
        expect(ids(await list())).toEqual(["newly-published", ...original]);
        expect((await list()).refreshFailed).toBe(true);
        expect(siblingIds(await list())).toEqual(withSibling ? ["sibling"] : []);
        expect(requests).toBe(failedRequests);
        fail = false;
      }
      failSibling = false;
      const recovered = await waitForCatalogPublication({
        signal,
        start: () => list(true),
        read: list,
        ready: (result) => result.refreshFailed !== true,
      });
      expect(recovered.refreshFailed).not.toBe(true);
    } finally {
      release();
      await requestedRefresh?.catch(() => undefined);
    }
  },
);
