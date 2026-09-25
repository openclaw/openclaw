import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { expect, it } from "vitest";
import type { ModelsListResult } from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import { createDeferred, withTestTimeout } from "../../../test/helpers/promise.js";
import { getPublishedPreparedModelCatalogOwnerSnapshot } from "../../agents/prepared-model-catalog.js";
import { resolvePreparedModelRuntimeOwnerBySnapshot } from "../../agents/prepared-model-runtime.owner.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { disconnectGatewayClient, startGatewayWithClient } from "../test-helpers.e2e.js";
import { waitForCatalogPublication } from "./models-auth-catalog.test-support.js";

it.for([
  { withSibling: false, getterBacked: false, initiallyEmpty: false },
  { withSibling: true, getterBacked: false, initiallyEmpty: false },
  { withSibling: false, getterBacked: true, initiallyEmpty: false },
  { withSibling: true, getterBacked: false, initiallyEmpty: true },
])(
  "models.list renews accepted inventory (sibling: $withSibling, getter-backed: $getterBacked, empty: $initiallyEmpty)",
  { timeout: 120_000 },
  async ({ withSibling, getterBacked, initiallyEmpty }, { signal }) => {
    const state = await createOpenClawTestState({
      label: "catalog-freshness",
      env: {
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      },
    });
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
    try {
      endpoint.listen(0, "127.0.0.1");
      await once(endpoint, "listening");
      const address = endpoint.address();
      if (!address || typeof address === "string") {
        throw new Error("Catalog fixture did not bind a TCP port");
      }
      const baseUrl = `http://127.0.0.1:${address.port}`;
      await state.writeJson("catalog-plugin/openclaw.plugin.json", {
        id: provider,
        providers,
        configSchema: { type: "object", additionalProperties: false },
      });
      const pluginPath = await state.writeText(
        "catalog-plugin/index.cjs",
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
              projectRows: rows => rows.map(id => ({ id, name: id, reasoning: false, input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 4096 })),
            });
            if (${getterBacked}) {
              let evaluated = false;
              return { get providers() {
                if (evaluated) return { "unaccepted-projection": accepted };
                evaluated = true;
                return { [provider]: accepted };
              } };
            }
            return { provider: accepted };
          } },
        });
      },
    };`,
      );
      const token = "catalog-freshness-gateway-token";
      const cfg = {
        agents: {
          defaults: { modelPolicy: { allow: providers.map((id) => `${id}/*`) } },
          list: [{ id: "main", workspace: state.workspaceDir }],
        },
        plugins: { allow: [provider], load: { paths: [pluginPath] }, slots: { memory: "none" } },
        gateway: { mode: "local", auth: { mode: "token", token } },
      };
      await state.writeConfig(cfg);
      await state.writeAuthProfiles({
        version: 1,
        profiles: {
          [`${provider}:default`]: { type: "api_key", provider, key: "freshness-account-key" },
          ...(withSibling
            ? {
                [`${sibling}:default`]: {
                  type: "api_key" as const,
                  provider: sibling,
                  key: "sibling-account-key",
                },
              }
            : {}),
        },
      });
      const { client, server } = await startGatewayWithClient({
        cfg,
        configPath: state.configPath,
        token,
        scopes: ["operator.admin"],
      });
      try {
        await server.startupSettled;
        const list = async (refresh = false) => {
          const result = await client.request<ModelsListResult>("models.list", {
            agentId: "main",
            view: "all",
            refresh,
          });
          return {
            ...result,
            models: result.models.filter((row) => row.provider === provider),
            siblingModels: result.models
              .filter((row) => row.provider === sibling)
              .map((row) => row.id),
          };
        };
        const initial = await waitForCatalogPublication({
          signal,
          // Startup discovers nonempty inventory; forcing refresh would bypass TTL renewal.
          start: initiallyEmpty ? () => list(true) : list,
          read: list,
          ready: (result) =>
            (initiallyEmpty
              ? !result.pendingProviders?.includes(provider)
              : result.models.some((row) => row.id === "original")) &&
            (!withSibling || result.siblingModels.includes("sibling")),
        });
        expect(initial.models.map((row) => row.id)).toEqual(original);
        const owner = getPublishedPreparedModelCatalogOwnerSnapshot({ agentId: "main" });
        if (!owner?.readFullModelCatalog) {
          throw new Error("Missing published freshness fixture inventory");
        }
        const readPublished = async () => owner.readFullModelCatalog!();
        const expire = (providerIds: string[]) => {
          for (const id of providerIds) {
            const facts =
              resolvePreparedModelRuntimeOwnerBySnapshot(owner)?.catalogInventory?.providers.get(
                id,
              );
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
        const initialRequests = requests;
        if (!initiallyEmpty) {
          expect(initialRequests).toBe(1);
        }
        hold = true;
        advertised = [...original, "newly-published"];
        if (initiallyEmpty) {
          expect((await list()).models).toEqual([]);
          expect(requests).toBe(initialRequests);
        }
        // Arm the response hold before making any accepted inventory due.
        failSibling = withSibling && !initiallyEmpty;
        expire(withSibling && !initiallyEmpty ? providers : [provider]);
        const saved = await withTestTimeout(
          list(),
          1_000,
          "models.list waited for expired provider inventory",
        );
        expect(saved.models.map((row) => row.id)).toEqual(original);
        expect(saved.siblingModels).toEqual(withSibling ? ["sibling"] : []);
        await withTestTimeout(
          renewal.promise,
          3_000,
          "models.list did not refresh the expired provider",
        );
        const concurrent = await withTestTimeout(
          Promise.all([list(), list()]),
          1_000,
          "concurrent catalog reads waited for discovery",
        );
        expect(concurrent.map((result) => result.models.map((row) => row.id))).toEqual([
          original,
          original,
        ]);
        expect(requests).toBe(initialRequests + 1);
        const renewed = await acceptRenewal(() => {
          hold = false;
          for (const response of held.splice(0)) {
            reply(response);
          }
        });
        expect(renewed.models.map((row) => row.id)).toEqual(["newly-published", ...original]);

        if (!withSibling || initiallyEmpty) {
          fail = true;
          expire([provider]);
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
            return list();
          });
          expect(afterSiblingFailure.models.map((row) => row.id)).toEqual([
            "after-sibling-failure",
            "newly-published",
            "original",
          ]);
          expect((await list()).refreshFailed).toBe(true);
        } else {
          const failedRequests = requests;
          expect((await list()).models.map((row) => row.id)).toEqual([
            "newly-published",
            ...original,
          ]);
          expect((await list()).refreshFailed).toBe(true);
          expect((await list()).siblingModels).toEqual(withSibling ? ["sibling"] : []);
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
        hold = false;
        for (const response of held.splice(0)) {
          reply(response);
        }
        await disconnectGatewayClient(client);
        await server.close();
      }
    } finally {
      endpoint.closeAllConnections();
      await new Promise<void>((resolve) => {
        endpoint.close(() => resolve());
      });
      await state.cleanup();
    }
  },
);
