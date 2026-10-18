import { createServer, type ServerResponse } from "node:http";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import type { ModelsListResult } from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { withPreparedModelRuntimePluginGenerationScope } from "../../agents/prepared-model-runtime-generation-scope.js";
import { startSerializedSnapshotBuildBatch } from "../../agents/prepared-model-runtime.build.js";
import {
  acquireAgentRunPreparedModelRuntime,
  loadPublishedGatewayReplyDispatchRuntime,
} from "../../agents/prepared-model-runtime.js";
import { retainPreparedPluginGeneration } from "../../agents/prepared-model-runtime.plugin-lifetime.js";
import { registerPreparedModelRuntimePublicationListener } from "../../agents/prepared-model-runtime.publication-events.js";
import { getRuntimeConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as updateStartup from "../../infra/update-startup.js";
import { redactSensitiveText } from "../../logging/redact.js";
import * as bundledStamp from "../../model-catalog/bundled-catalog-stamp.js";
import * as pricing from "../../model-catalog/pricing.js";
import { setRemoteModelCatalogOverlaySourcesForTest } from "../../model-catalog/remote-overlay.test-support.js";
import { refreshRemoteModelCatalog } from "../../model-catalog/remote-refresh.js";
import { resolveModelCostConfig } from "../../utils/usage-format.js";
import { disconnectGatewayClient } from "../test-helpers.e2e.js";
import {
  closeCatalogServer,
  createCatalogState,
  createCatalogModel,
  catalogAgents,
  catalogModelIds,
  createCatalogAuthProfiles,
  catalogModelDefaults,
  listenCatalogServer,
  startCatalogGateway,
  writeCatalogPlugin,
} from "./models-catalog-fixture.test-support.js";

afterEach(() => vi.restoreAllMocks());

it.for([1, 2])(
  "publishes one remote rows/pricing generation without blocking readers or repricing admitted runs (v%s)",
  { timeout: 120_000 },
  async (schemaVersion, { signal }) => {
    const createUpdateCheck = updateStartup.createGatewayUpdateCheck;
    vi.spyOn(updateStartup, "createGatewayUpdateCheck").mockImplementation((params) => ({
      ...createUpdateCheck(params),
      start: () => {},
    }));
    const unexpectedRestart = vi.fn(() => {
      throw new Error("Remote catalog publication unexpectedly requested a Gateway restart");
    });
    const state = await createCatalogState("remote-catalog-publication", {
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
    });
    const generatedAt = Date.now() + 86_400_000;
    const makeModel = (id: string, name: string, input: number) => ({
      ...createCatalogModel(id, name),
      api: "anthropic-messages",
      cost: { input, output: input * 2 },
    });
    const makeCatalog = (generation: number, models: ReturnType<typeof makeModel>[]) => ({
      schemaVersion: 1,
      generatedAt: generatedAt + generation,
      sourceCommit: "remote-catalog-fixture",
      providers: { kimi: { models } },
    });
    const first = makeCatalog(0, [makeModel("remote-first", "Remote First", 1)]);
    const next = makeCatalog(1, [
      makeModel("remote-first", "Remote First", 7),
      makeModel("remote-next", "Remote Next", 9),
    ]);
    const encode = (catalog: typeof first) =>
      JSON.stringify(
        schemaVersion === 1
          ? catalog
          : {
              ...catalog,
              schemaVersion: 2,
              providers: { kimi: {} },
              models: catalog.providers.kimi.models.map(({ cost, ...model }) => ({
                ...model,
                provider: "kimi",
                pricing: { status: "known", currency: "USD", unit: "million_tokens", ...cost },
              })),
            },
      );
    let body = encode(first);
    let exitWorkerOnce = false;
    let providerThread = 0;
    const replyProvider = (response: ServerResponse) => {
      response.writeHead(200, { "content-type": "application/json" });
      const payload = exitWorkerOnce ? { exitWorker: true } : ["known-provider-model"];
      exitWorkerOnce = false;
      response.end(JSON.stringify(payload));
    };
    const endpoint = createServer((request, response) => {
      if (request.url === "/catalog.json") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(body);
      } else {
        providerThread = Number(
          new URL(request.url ?? "/", "http://fixture.invalid").searchParams.get("thread"),
        );
        replyProvider(response);
      }
    });
    try {
      const baseUrl = await listenCatalogServer(endpoint);
      const provider = "remote-catalog-fixture";
      const pluginPath = await writeCatalogPlugin(
        state,
        provider,
        `module.exports = {
      id: ${JSON.stringify(provider)}, register(api) {
        api.registerProvider({ id: ${JSON.stringify(provider)}, label: "Catalog fixture", auth: [],
          catalog: { order: "profile", async run(ctx) {
            const auth = ctx.resolveProviderAuth(${JSON.stringify(provider)});
            if (!auth.discoveryApiKey) return null;
            const { buildLiveModelProviderConfig, clearLiveCatalogCacheForTests } = await import("openclaw/plugin-sdk/provider-catalog-live-runtime");
            clearLiveCatalogCacheForTests();
            return { provider: await buildLiveModelProviderConfig({
              providerId: ${JSON.stringify(provider)}, discoveryMode: "strict", discoveryApiKey: auth.discoveryApiKey,
              endpoint: ${JSON.stringify(baseUrl + "/provider?thread=")} + require("node:worker_threads").threadId, ttlMs: 86_400_000,
              providerConfig: { baseUrl: ${JSON.stringify(baseUrl)}, api: "openai-completions" }, models: [],
              fetchGuard: async ({ url, init }) => ({ response: await fetch(url, init), finalUrl: url, release: async () => {} }),
              readRows: body => {
                if (body.exitWorker) {
                  if (require("node:worker_threads").isMainThread) throw new Error("Expected catalog worker");
                  process.exit(42);
                }
                return body;
              },
              projectRows: rows => rows.map(id => ({ id, name: id, ...${JSON.stringify(catalogModelDefaults())} })),
            }) };
          } },
        });
      },
    };`,
      );
      const token = "remote-catalog-gateway-fixture-token";
      const catalogConfig = { models: { catalogRefresh: { url: `${baseUrl}/catalog.json` } } };
      const bundledGeneratedAt = () => generatedAt - 1;
      vi.spyOn(bundledStamp, "bundledCatalogGeneratedAt").mockImplementation(bundledGeneratedAt);
      const refresh = () => refreshRemoteModelCatalog({ config: catalogConfig, force: true });
      const cfg = {
        ...catalogConfig,
        agents: catalogAgents(state, { model: { primary: "kimi/remote-first" } }),
        models: {
          ...catalogConfig.models,
          providers: {
            kimi: {
              baseUrl: "https://api.kimi.com/coding/",
              api: "anthropic-messages",
              models: [{ id: "remote-first", name: "Remote First" }],
            },
          },
        },
        plugins: {
          allow: ["kimi", provider],
          load: { paths: [pluginPath] },
          slots: { memory: "none" },
        },
        update: { checkOnStart: false },
        gateway: { mode: "local", auth: { mode: "token", token } },
      };
      await state.writeConfig(cfg);
      state.applyEnv();
      await state.writeAuthProfiles(
        createCatalogAuthProfiles({ [provider]: "catalog-fixture-key" }),
      );
      setRemoteModelCatalogOverlaySourcesForTest({ bundledGeneratedAt });
      const initialRefresh = await refresh();
      expect(initialRefresh.status, redactSensitiveText(JSON.stringify(initialRefresh))).toBe(
        "updated",
      );
      const { client, server } = await startCatalogGateway(state, cfg, token, {
        hotReloadRecovery: unexpectedRestart,
      });
      const preparing = createDeferred();
      const commit = createDeferred();
      let pausePublication = false;
      const preparePricing = pricing.prepareModelPricingContext;
      vi.spyOn(pricing, "prepareModelPricingContext").mockImplementation(async (...args) => {
        const result = await preparePricing(...args);
        if (pausePublication) {
          preparing.resolve();
          await commit.promise;
        }
        return result;
      });
      try {
        await server.startupSettled;
        const list = (refreshCatalog = false) =>
          client.request<ModelsListResult>("models.list", { view: "all", refresh: refreshCatalog });
        const kimiIds = (catalog: ModelsListResult) => catalogModelIds(catalog, "kimi");
        const waitForRows = async (
          model: string,
          isReady: (catalog: ModelsListResult) => boolean = () => true,
        ) => {
          const ready = createDeferred<ModelsListResult>();
          const read = () => {
            void list().then((catalog) => {
              if (kimiIds(catalog).includes(model) && isReady(catalog)) {
                ready.resolve(catalog);
              }
            }, ready.reject);
          };
          const stop = registerPreparedModelRuntimePublicationListener((event) => {
            if (event.phase === "published" || event.phase === "catalog-published") {
              read();
            }
          });
          try {
            read();
            return await withinTest(ready.promise, signal);
          } finally {
            stop();
          }
        };
        const price = (config: OpenClawConfig, model = "remote-first") =>
          resolveModelCostConfig({
            config,
            agentDir: state.agentDir(),
            provider: "kimi",
            model,
          })?.input;
        const currentPrice = (model = "remote-first") => price(getRuntimeConfig(), model);
        const settleInterrupted = async (pending: Promise<ModelsListResult>) => {
          await withinTest(
            pending.catch((error: unknown) => {
              expect(error).toMatchObject({ code: "UNAVAILABLE" });
            }),
            signal,
          );
        };
        expect(kimiIds(await list(true))).toContain("remote-first");
        // Remote rows can precede executable provider publication; admit only its completed pair.
        await waitForRows(
          "remote-first",
          (catalog) =>
            !catalog.pendingProviders?.length &&
            catalog.models.some(
              (row) => row.provider === provider && row.id === "known-provider-model",
            ),
        );
        const config = getRuntimeConfig();
        const input = {
          config,
          agentId: "main",
          agentDir: state.agentDir(),
          workspaceDir: state.workspaceDir,
        };
        await using oldRun = await acquireAgentRunPreparedModelRuntime(input, {
          catalogMode: "static",
        });
        const runModel = (run: typeof oldRun) =>
          run.snapshot.createStores().modelRegistry.find("kimi", "remote-first");
        const oldModel = expectDefined(runModel(oldRun), "old run model");
        expect(oldModel.cost.input).toBe(1);
        pausePublication = true;
        body = encode(next);
        expect((await refresh()).status).toBe("updated");
        expect(kimiIds(await list(true))).not.toContain("remote-next");
        await withinTest(preparing.promise, signal);
        // The candidate's commit stays held below; a picker read that joined it never settles.
        const saved = await withinTest(Promise.all([list(), list(), list()]), signal);
        for (const catalog of saved) {
          expect(kimiIds(catalog)).toContain("remote-first");
          expect(kimiIds(catalog)).not.toContain("remote-next");
          expect(
            catalog.models.some(
              (row) => row.provider === provider && row.id === "known-provider-model",
            ),
          ).toBe(true);
        }
        expect(price(config)).toBe(1);
        pausePublication = false;
        commit.resolve();
        const published = await waitForRows("remote-next");
        expect(kimiIds(published)).toContain("remote-next");
        expect(price(config, "remote-next")).toBe(9);
        expect(
          withPreparedModelRuntimePluginGenerationScope(oldRun.pluginGeneration, () =>
            price(config),
          ),
        ).toBe(1);
        expect(oldModel.cost.input).toBe(1);
        await using newRun = await acquireAgentRunPreparedModelRuntime(input, {
          catalogMode: "static",
        });
        const newModel = expectDefined(runModel(newRun), "new run model");
        expect(newModel.cost.input).toBe(7);
        const retirement = new AbortController();
        const retainedBuild = startSerializedSnapshotBuildBatch(
          [
            {
              input: { ...input, allowGatewaySubagentBinding: true },
              pluginGeneration: oldRun.pluginGeneration,
              catalogOwner: oldRun.snapshot.catalogOwner,
              retirementSignal: retirement.signal,
              isGenerationCurrent: () => !retirement.signal.aborted,
            },
          ],
          new Map(),
          30_000,
          "static",
        );
        const retained = expectDefined((await retainedBuild.pending)[0], "retained generation");
        const releaseRetained = retainPreparedPluginGeneration(retained.pluginGeneration);
        try {
          const retainedCatalog = expectDefined(
            await retained.snapshot.loadFullModelCatalog?.({
              refresh: true,
            }),
            "retained catalog",
          );
          const retainedIds = catalogModelIds({ models: retainedCatalog.entries }, "kimi");
          expect(retainedIds).toContain("remote-first");
          expect(retainedIds).not.toContain("remote-next");
        } finally {
          retirement.abort();
          await releaseRetained();
          await retainedBuild.completion;
        }
        for (const rejected of [
          "{",
          JSON.stringify({ ...next, generatedAt: generatedAt + 2, minVersion: "9999.1.1" }),
        ]) {
          body = rejected;
          expect((await refresh()).status).toBe("error");
          expect(kimiIds(await list())).toContain("remote-next");
          expect(price(config)).toBe(7);
        }
        body = encode(first);
        const stale = await refresh();
        expect(stale).toMatchObject({ status: "unchanged", generatedAt: generatedAt + 1 });
        expect(kimiIds(await list())).toContain("remote-next");
        expect(price(config)).toBe(7);

        const committedThread = providerThread;
        exitWorkerOnce = true;
        await settleInterrupted(list(true));
        await loadPublishedGatewayReplyDispatchRuntime({ agentId: "main" });
        expect(kimiIds(await list(true))).toContain("remote-next");
        await waitForRows("remote-next", () => providerThread !== committedThread);
        expect(providerThread).not.toBe(committedThread);
        expect(currentPrice()).toBe(7);

        const finalCatalog = makeCatalog(2, [
          makeModel("remote-first", "Remote First", 11),
          ...next.providers.kimi.models.slice(1),
          makeModel("remote-last", "Remote Last", 13),
        ]);
        body = encode(finalCatalog);
        expect((await refresh()).status).toBe("updated");
        await list(true);
        expect(kimiIds(await waitForRows("remote-last"))).toContain("remote-last");
        expect(currentPrice()).toBe(11);
        expect(currentPrice("remote-last")).toBe(13);
        expect(oldModel.cost.input).toBe(1);
        expect(runModel(newRun)?.cost.input).toBe(7);

        const beforeDisable = await client.request<{ hash: string }>("config.get", {});
        await client.request("config.patch", {
          baseHash: beforeDisable.hash,
          raw: JSON.stringify({ models: { catalogRefresh: { enabled: false } } }),
        });
        await loadPublishedGatewayReplyDispatchRuntime({ agentId: "main" });
        const withoutRemote = await list(true);
        expect(kimiIds(withoutRemote)).not.toContain("remote-next");
        expect(kimiIds(withoutRemote)).not.toContain("remote-last");
        expect(currentPrice("remote-last")).toBeUndefined();
        const disabledThread = providerThread;
        exitWorkerOnce = true;
        await settleInterrupted(list(true));
        await loadPublishedGatewayReplyDispatchRuntime({ agentId: "main" });
        expect(kimiIds(await list(true))).not.toContain("remote-last");
        await waitForRows("remote-first", () => providerThread !== disabledThread);
        expect(currentPrice("remote-last")).toBeUndefined();
        expect(providerThread).not.toBe(disabledThread);
        expect([oldModel.cost.input, newModel.cost.input]).toEqual([1, 7]);
        expect(unexpectedRestart).not.toHaveBeenCalled();
      } finally {
        commit.resolve();
        await disconnectGatewayClient(client);
        await server.close();
      }
    } finally {
      await closeCatalogServer(endpoint);
      setRemoteModelCatalogOverlaySourcesForTest();
      await state.cleanup();
    }
  },
);
