import { createServer } from "node:http";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { ModelsListResult } from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import type { ModelsListParams } from "../../../packages/gateway-protocol/src/schema/model-catalog.js";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import * as tmpDirOwner from "../../infra/tmp-openclaw-dir.js";
import { createSuiteTempRootTracker } from "../../test-helpers/temp-dir.js";
import { waitForCatalogPublication } from "./models-auth-catalog.test-support.js";
import {
  catalogAgents,
  createCatalogModel as catalogModel,
  writeCatalogPlugin,
} from "./models-catalog-fixture.test-support.js";
import {
  createModelsTestState,
  modelsTestConfig,
  serveModelsEndpoint,
  startModelsGateway,
} from "./models-integration.test-support.js";

const modelRow = (provider: string, id: string) => expect.objectContaining({ provider, id });

const coordinatorRoots = createSuiteTempRootTracker({ prefix: "native-catalog-coordinator-" });
beforeAll(() => coordinatorRoots.setup());
beforeEach(async () => {
  // Auth refresh writes config; its handoff lease must not use the operator's coordinator.
  vi.spyOn(tmpDirOwner, "resolvePreferredOpenClawTmpDir").mockReturnValue(
    await coordinatorRoots.make("coordinator"),
  );
});
afterAll(async () => {
  vi.mocked(tmpDirOwner.resolvePreferredOpenClawTmpDir).mockRestore();
  await coordinatorRoots.cleanup();
});

it.for([false, true])(
  "models.list discovers and renews native models (provider credentials: %s)",
  { timeout: 120_000 },
  async (withProviderCredentials, { signal }) => {
    await using state = await createModelsTestState("native-catalog-lifecycle", {
      layout: "state-only",
      env: {
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: withProviderCredentials ? "1" : undefined,
        OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
      },
    });
    const provider = "native-lifecycle-fixture";
    const otherProvider = "unrelated-native-fixture";
    const model = (id: string, owner = provider) => modelRow(owner, id);
    const harness = "native-lifecycle-runtime";
    const requests: string[] = [];
    const nativeRequests = (from = 0) =>
      requests.slice(from).filter((path) => path === "/native/models");
    const nativeModelId = "native-account-only";
    let outsideName = "Unrelated native model";
    let addOutsideModel = false;
    let failedProviderCatalog = true;
    let nativeRequested = createDeferred();
    let nativeReleased = createDeferred();
    const nativeRow = (id: string, name: string) => ({
      provider,
      id,
      name,
      nativeRuntime: harness,
    });
    const nativeRows = () => [
      nativeRow(nativeModelId, "Native account model"),
      nativeRow("configured-native", "Configured native model"),
      { provider, id: "harness-host-row", name: "Harness host model" },
      ...(withProviderCredentials
        ? [
            { ...nativeRow("unrelated-native-model", outsideName), provider: otherProvider },
            ...(addOutsideModel
              ? [
                  {
                    ...nativeRow("outside-scope-new", "Outside-scope new model"),
                    provider: otherProvider,
                  },
                ]
              : []),
          ]
        : []),
    ];
    const endpoint = createServer((request, response) => {
      requests.push(request.url ?? "");
      response.setHeader("Content-Type", "application/json");
      if (request.url === "/native/models") {
        nativeRequested.resolve();
        void nativeReleased.promise.then(() => response.end(JSON.stringify(nativeRows())));
      } else if (request.url === "/provider/models" || request.url === "/other/models") {
        if (failedProviderCatalog && request.url === "/provider/models") {
          response.writeHead(503).end();
          return;
        }
        response.end(JSON.stringify([{ id: "provider-account", name: "Provider account model" }]));
      } else {
        response.writeHead(404).end();
      }
    });
    const saveAccount = (access: string) =>
      state.writeAuthProfiles({
        version: 1,
        profiles: {
          [`${provider}:primary`]: {
            type: "oauth",
            provider,
            accountId: "native-account",
            access,
            refresh: `${access}-refresh`,
            expires: Date.now() + 3_600_000,
          },
        },
      });
    await using listening = await serveModelsEndpoint(endpoint, true);
    const { baseUrl } = listening;
    try {
      const pluginRoot = withProviderCredentials ? "native-plugin" : "bundled/native-plugin";
      await state.writeJson(`${pluginRoot}/openclaw.plugin.json`, {
        id: provider,
        providers: [provider, otherProvider],
        cliBackends: [harness],
        modelCatalog: {
          discovery: { [provider]: "refreshable" },
          providers: {
            [provider]: {
              baseUrl,
              api: "openai-completions",
              models: [catalogModel("unconfigured-starter", "Provider starter")],
            },
          },
        },
        configSchema: { type: "object", additionalProperties: false },
      });
      const pluginPath = await state.writeText(
        `${pluginRoot}/index.js`,
        `module.exports = {
      id: ${JSON.stringify(provider)}, register(api) {
        const observed = new WeakSet();
        api.registerAgentHarness({
          id: ${JSON.stringify(harness)}, label: "Native fixture", authBootstrap: "harness",
          supports: () => ({ supported: true }), runAttempt: async () => ({ ok: false, error: "unused" }),
          async loadModelCatalog(params) {
            const response = await fetch(${JSON.stringify(`${baseUrl}/native/models`)});
            if (!response.ok) throw new Error("Native catalog fixture unavailable");
            const rows = await response.json();
            observed.add(params.config);
            return rows;
          },
          readModelCatalogReadiness: params => observed.has(params.config) ? { accountType: "chatgpt" } : undefined,
        });
        for (const providerId of [${JSON.stringify(provider)}, ${JSON.stringify(otherProvider)}]) api.registerProvider({
          id: providerId, label: "Native fixture", auth: [],
          formatApiKey: credential => credential.access,
          staticCatalog: ${withProviderCredentials ? "false" : "true"} && providerId === ${JSON.stringify(provider)} ? {
            order: "simple", async run() {
              return { provider: require("./openclaw.plugin.json").modelCatalog.providers[${JSON.stringify(provider)}] };
            },
          } : undefined,
          catalog: { order: "profile", async run(ctx) {
            const auth = ctx.resolveProviderAuth(providerId);
            if (!auth.discoveryApiKey && ${withProviderCredentials ? "true" : "false"}) return null;
            const response = await fetch(${JSON.stringify(baseUrl)} + (providerId === ${JSON.stringify(provider)} ? "/provider/models" : "/other/models"));
            if (!response.ok) return { providers: {}, outcomes: [{ provider: providerId, status: "unavailable" }] };
            return { provider: { baseUrl: ${JSON.stringify(baseUrl)}, api: "openai-completions",
              models: (await response.json()).map(row => ({ ...row, reasoning: false, input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 4096 })) } };
          } },
        });
      }
    };`,
      );
      if (!withProviderCredentials) {
        state.envVars.OPENCLAW_BUNDLED_PLUGINS_DIR = state.statePath("bundled");
        state.applyEnv();
      }
      const token = "native-lifecycle-gateway-token";
      const cfg = {
        agents: catalogAgents(state, {
          model: `${provider}/static-model`,
          modelPolicy: { allow: [`${provider}/*`] },
          models: { [`${provider}/static-model`]: { agentRuntime: { id: harness } } },
        }),
        models: {
          providers: {
            [provider]: {
              baseUrl,
              api: "openai-completions",
              models: [
                { id: "static-model", name: "Static model" },
                { id: "configured-native", name: "Configured native model" },
              ],
            },
            ...(withProviderCredentials
              ? {
                  [otherProvider]: {
                    baseUrl,
                    api: "openai-completions",
                    apiKey: "unrelated-native-key",
                    models: [],
                  },
                }
              : {}),
          },
        },
        plugins: {
          allow: [provider],
          ...(withProviderCredentials ? { load: { paths: [pluginPath] } } : {}),
          slots: { memory: "none" },
          entries: { [provider]: { enabled: true } },
        },
        gateway: { mode: "local", auth: { mode: "token", token } },
      };
      await state.writeConfig(cfg);
      if (withProviderCredentials) {
        await saveAccount("native-original");
        failedProviderCatalog = false;
      }
      await using gateway = await startModelsGateway(state, cfg, token);
      const { client, server } = gateway;
      try {
        await server.startupSettled;
        const request = (params: ModelsListParams) =>
          client.request<ModelsListResult>("models.list", { agentId: "main", ...params });
        const list = () => request({ view: "all" });
        const preparedList = () => request({ view: "all", preparedOnly: true });
        const available = (result: ModelsListResult) =>
          result.models.find((row) => row.id === nativeModelId)?.available;
        const published = (ready: (result: ModelsListResult) => boolean) =>
          waitForCatalogPublication({ signal, read: list, ready });
        const cachedReads = async (check: (result: ModelsListResult) => void) => {
          const before = requests.length;
          const results = await Promise.all([list(), list()]);
          expect(requests).toHaveLength(before);
          results.forEach(check);
        };
        expect(nativeRequests()).toHaveLength(0);
        const firstReads = await Promise.all([list(), list()]);
        await withinTest(nativeRequested.promise, signal);
        const beforeReads = requests.length;
        // Ordinary and prepared-only reads return saved rows while discovery is held.
        const pending = [...firstReads, ...(await Promise.all([preparedList(), preparedList()]))];
        expect.soft(nativeRequests()).toHaveLength(1);
        expect(requests).toHaveLength(beforeReads);
        for (const result of pending) {
          expect(result.models.some((row) => row.id === "static-model")).toBe(true);
          expect(result.pendingProviders).toContain(provider);
          expect(result.models).not.toContainEqual(model(nativeModelId));
        }
        nativeReleased.resolve();
        await published((result) => available(result) === true);
        expect((await list()).models).toContainEqual(model("harness-host-row"));
        if (!withProviderCredentials) {
          // Cold startup discovers the full catalog, as an explicit refresh would.
          expect(requests.toSorted()).toEqual(["/native/models", "/provider/models"]);
          // Gateway refresh can return a pending snapshot before discovery publishes.
          const refresh = () =>
            waitForCatalogPublication({
              signal,
              start: () => request({ view: "all", refresh: true }),
              read: list,
              ready: (result) => !result.pendingProviders?.includes(provider),
            });
          const unavailable = await refresh();
          expect(unavailable.refreshFailed).toBe(true);
          expect.soft(unavailable.models).toContainEqual(model("unconfigured-starter"));
          expect(unavailable.models).toContainEqual(model(nativeModelId));
          failedProviderCatalog = false;
          await refresh();
          expect((await list()).models).toContainEqual(model("provider-account"));
          const beforeOpaqueReload = requests.length;
          nativeReleased = createDeferred();
          nativeRequested = createDeferred();
          await client.request("models.authRefresh", { agentId: "main", operation: "logout" });
          expect(requests.slice(beforeOpaqueReload)).not.toContain("/native/models");
          const firstOpaqueRead = await list();
          await withinTest(nativeRequested.promise, signal);
          const beforeOpaqueReads = requests.length;
          const opaquePending = [
            firstOpaqueRead,
            ...(await Promise.all([preparedList(), preparedList()])),
          ];
          expect(requests).toHaveLength(beforeOpaqueReads);
          for (const result of opaquePending) {
            expect(result.pendingProviders).toContain(provider);
            expect.soft(result.models).not.toContainEqual(model(nativeModelId));
            expect(result.models).toContainEqual(model("provider-account"));
          }
          nativeReleased.resolve();
          await published((result) => !result.pendingProviders?.includes(provider));
        } else {
          outsideName = "Outside-scope replacement";
          addOutsideModel = true;
          await request({ provider, refresh: true });
          const scoped = await list();
          expect(scoped.models).toContainEqual(
            expect.objectContaining({
              provider: otherProvider,
              id: "unrelated-native-model",
              name: "Unrelated native model",
            }),
          );
          expect(scoped.models).not.toContainEqual(model("outside-scope-new", otherProvider));
          const beforeReloadNative = nativeRequests().length;
          const config = await client.request<{ hash: string }>("config.get", {});
          await client.request("config.patch", {
            baseHash: config.hash,
            raw: JSON.stringify({
              agents: { defaults: { modelPolicy: { allow: [`${provider}/*`, "unused/*"] } } },
            }),
          });
          await published((result) => available(result) === true);
          expect(nativeRequests()).toHaveLength(beforeReloadNative + 1);
          const beforeRenewal = requests.length;
          nativeReleased = createDeferred();
          await saveAccount("native-renewed");
          await client.request("models.authRefresh", { agentId: "main", operation: "update" });
          expect((await list()).models.some((row) => row.id === "provider-account")).toBe(true);
          await expect
            .poll(() => nativeRequests(beforeRenewal).length, { timeout: 15_000 })
            .toBe(1);
          await cachedReads((result) => {
            expect(result.pendingProviders).toContain(provider);
            expect.soft(result.models).toContainEqual(model(nativeModelId));
            expect(result.models).not.toContainEqual(model("harness-host-row"));
          });
          nativeReleased.resolve();
          await expect
            .poll(async () => (await list()).pendingProviders ?? [], { timeout: 15_000 })
            .not.toContain(provider);
          await expect.poll(async () => available(await list()), { timeout: 15_000 }).toBe(true);
          expect(nativeRequests(beforeRenewal)).toHaveLength(1);
        }
        const settledRequests = requests.length;
        await Promise.all([list(), list(), list()]);
        expect(requests).toHaveLength(settledRequests);
      } finally {
        nativeReleased.resolve();
      }
    } finally {
      nativeReleased.resolve();
    }
  },
);

it("models.list discovers credential-free providers at startup and explicitly refreshes once", async ({
  signal,
}) => {
  await using state = await createModelsTestState("credential-free-catalog", {
    layout: "state-only",
    env: { OPENCLAW_TEST_MINIMAL_GATEWAY: undefined },
  });
  const provider = "credential-free-fixture";
  let requests = 0;
  const endpoint = createServer((_request, response) => {
    requests += 1;
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify([
        // Each response identifies the discovery that published it.
        catalogModel(`public-model-${requests}`, "Public model"),
      ]),
    );
  });
  await using listening = await serveModelsEndpoint(endpoint, true);
  const { baseUrl } = listening;
  await state.writeText(
    "catalog-plugin/provider-discovery.cjs",
    `module.exports = {
      id: ${JSON.stringify(provider)}, label: "Public fixture", auth: [],
      catalog: { order: "simple", async run() {
        const response = await fetch(${JSON.stringify(baseUrl)});
        return { provider: { baseUrl: ${JSON.stringify(baseUrl)}, api: "openai-completions", models: await response.json() } };
      } },
    };`,
  );
  const pluginPath = await writeCatalogPlugin(
    state,
    provider,
    `module.exports = {
      id: ${JSON.stringify(provider)}, register(api) { api.registerProvider(require("./provider-discovery.cjs")); }
    };`,
    { providerCatalogEntry: "./provider-discovery.cjs" },
  );
  const token = "credential-free-gateway-token";
  const cfg = modelsTestConfig(state, token, {
    agents: catalogAgents(state, { models: { [`${provider}/*`]: {} } }),
    plugins: {
      allow: [provider],
      load: { paths: [pluginPath] },
      slots: { memory: "none" },
      entries: { [provider]: { enabled: true } },
    },
  });
  await state.writeConfig(cfg);
  await using gateway = await startModelsGateway(state, cfg, token);
  const { client, server } = gateway;
  await server.startupSettled;
  const list = (refresh = false) =>
    client.request<ModelsListResult>("models.list", { agentId: "main", view: "all", refresh });
  const published = (modelId: string) => (result: ModelsListResult) =>
    !result.pendingProviders?.includes(provider) &&
    result.models.some((row) => row.provider === provider && row.id === modelId);
  // Cold startup runs the full discovery a refresh would, without an operator request.
  await waitForCatalogPublication({ signal, read: list, ready: published("public-model-1") });
  expect(requests).toBe(1);
  // An explicit refresh acquires fresh responses instead of reusing startup discovery.
  const refreshed = await waitForCatalogPublication({
    signal,
    start: () => list(true),
    read: list,
    ready: published("public-model-2"),
  });
  expect(refreshed.models).not.toContainEqual(modelRow(provider, "public-model-1"));
  expect(requests).toBe(2);
  expect((await list()).models).toContainEqual(modelRow(provider, "public-model-2"));
  expect(requests).toBe(2);
}, 120_000);
