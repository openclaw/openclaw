import { once } from "node:events";
import { createServer } from "node:http";
import { performance } from "node:perf_hooks";
import { expect, it } from "vitest";
import type { ModelsListResult } from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { disconnectGatewayClient, startGatewayWithClient } from "../test-helpers.e2e.js";

it.each([false, true])(
  "models.list learns native models after cold Gateway startup (provider credentials: %s)",
  async (withProviderCredentials) => {
    const state = await createOpenClawTestState({
      label: "native-catalog-lifecycle",
      layout: "state-only",
      env: {
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: withProviderCredentials ? "1" : undefined,
        OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
      },
    });
    const provider = "native-lifecycle-fixture";
    const harness = "native-lifecycle-runtime";
    const requests: string[] = [];
    let nativeModelId = "native-account-only";
    let emptyNativeCatalog = false;
    let failedNativeCatalog = false;
    let failedProviderCatalog = !withProviderCredentials;
    let noteNativeRequested!: () => void;
    const nativeRequested = new Promise<void>((resolve) => {
      noteNativeRequested = resolve;
    });
    let holdOther = false;
    let noteOtherRequested!: () => void;
    const otherRequested = new Promise<void>((resolve) => {
      noteOtherRequested = resolve;
    });
    let releaseOther!: () => void;
    const otherReleased = new Promise<void>((resolve) => {
      releaseOther = resolve;
    });
    let releaseNative!: () => void;
    let nativeReleased = new Promise<void>((resolve) => {
      releaseNative = resolve;
    });
    const endpoint = createServer((request, response) => {
      requests.push(request.url ?? "");
      response.setHeader("Content-Type", "application/json");
      if (request.url === "/native/models") {
        if (failedNativeCatalog) {
          void nativeReleased.then(() =>
            response
              .writeHead(503)
              .end(JSON.stringify({ error: "Native catalog fixture unavailable" })),
          );
          return;
        }
        noteNativeRequested();
        void nativeReleased.then(() =>
          response.end(
            JSON.stringify(
              emptyNativeCatalog
                ? []
                : [
                    {
                      provider,
                      id: nativeModelId,
                      name: "Native account model",
                      nativeRuntime: harness,
                    },
                    {
                      provider,
                      id: "configured-native",
                      name: "Configured native model",
                      nativeRuntime: harness,
                    },
                    {
                      provider,
                      id: "harness-host-row",
                      name: "Harness host model",
                    },
                    ...(withProviderCredentials
                      ? [
                          {
                            provider: "unrelated-native-fixture",
                            id: "unrelated-native-model",
                            name:
                              nativeModelId === "native-account-only"
                                ? "Unrelated native model"
                                : "Outside-scope replacement",
                            nativeRuntime: harness,
                          },
                          ...(nativeModelId === "native-account-only"
                            ? []
                            : [
                                {
                                  provider: "unrelated-native-fixture",
                                  id: "outside-scope-new",
                                  name: "Outside-scope new model",
                                  nativeRuntime: harness,
                                },
                              ]),
                        ]
                      : []),
                  ],
            ),
          ),
        );
      } else if (request.url === "/provider/models" || request.url === "/other/models") {
        if (failedProviderCatalog && request.url === "/provider/models") {
          response.writeHead(503).end();
          return;
        }
        const reply = () =>
          response.end(
            JSON.stringify([{ id: "provider-account", name: "Provider account model" }]),
          );
        if (holdOther && request.url === "/other/models") {
          noteOtherRequested();
          void otherReleased.then(reply);
        } else {
          reply();
        }
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
    try {
      endpoint.listen(0, "127.0.0.1");
      await once(endpoint, "listening");
      const address = endpoint.address();
      if (!address || typeof address === "string") {
        throw new Error("Native endpoint has no TCP address");
      }
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const pluginRoot = withProviderCredentials ? "native-plugin" : "bundled/native-plugin";
      await state.writeJson(`${pluginRoot}/openclaw.plugin.json`, {
        id: provider,
        providers: [provider, "unrelated-native-fixture"],
        cliBackends: [harness],
        modelCatalog: {
          discovery: { [provider]: "refreshable" },
          providers: {
            [provider]: {
              baseUrl,
              api: "openai-completions",
              models: [
                {
                  id: "unconfigured-starter",
                  name: "Provider starter",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 32768,
                  maxTokens: 4096,
                },
              ],
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
        for (const providerId of [${JSON.stringify(provider)}, "unrelated-native-fixture"]) api.registerProvider({
          id: providerId, label: "Native fixture", auth: [],
          formatApiKey: credential => credential.access,
          staticCatalog: ${withProviderCredentials ? "false" : "true"} && providerId === ${JSON.stringify(provider)} ? {
            order: "simple", async run() {
              return { provider: require("./openclaw.plugin.json").modelCatalog.providers[providerId] };
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
        agents: {
          defaults: {
            model: `${provider}/static-model`,
            modelPolicy: { allow: [`${provider}/*`] },
            models: { [`${provider}/static-model`]: { agentRuntime: { id: harness } } },
          },
          list: [{ id: "main", workspace: state.workspaceDir }],
        },
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
                  "unrelated-native-fixture": {
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
      }
      const { client, server } = await startGatewayWithClient({
        cfg,
        configPath: state.configPath,
        token,
        scopes: ["operator.admin"],
      });
      try {
        await server.startupSettled;
        const list = () =>
          client.request<ModelsListResult>("models.list", { agentId: "main", view: "all" });
        let waitTimer: ReturnType<typeof setTimeout> | undefined;
        const nativeStarted = await Promise.race([
          nativeRequested.then(() => true),
          new Promise<boolean>((resolve) => {
            waitTimer = setTimeout(() => resolve(false), 15_000);
          }),
        ]);
        clearTimeout(waitTimer);
        const beforeReads = requests.length;
        const readStarted = performance.now();
        const pending = await Promise.all([list(), list()]);
        const pendingReadMs = performance.now() - readStarted;
        console.log(
          "NATIVE_LIFECYCLE_PENDING",
          JSON.stringify({ nativeStarted, pendingReadMs, requests, pending }),
        );
        expect.soft(nativeStarted).toBe(true);
        expect.soft(requests.filter((path) => path === "/native/models")).toHaveLength(1);
        expect(pendingReadMs).toBeLessThan(1_000);
        expect(requests).toHaveLength(beforeReads);
        for (const result of pending) {
          expect(result.models.some((row) => row.id === "static-model")).toBe(true);
          expect.soft(result.pendingProviders).toContain(provider);
        }
        releaseNative();
        await expect
          .poll(
            async () => (await list()).models.find((row) => row.id === nativeModelId)?.available,
            { timeout: 15_000 },
          )
          .toBe(true);
        expect((await list()).models).toContainEqual(
          expect.objectContaining({ provider, id: "harness-host-row" }),
        );
        if (!withProviderCredentials) {
          expect(requests).toEqual(["/native/models"]);
          const unavailable = await client.request<ModelsListResult>("models.list", {
            agentId: "main",
            view: "all",
            refresh: true,
          });
          expect(unavailable.refreshFailed).toBe(true);
          expect
            .soft(unavailable.models)
            .toContainEqual(expect.objectContaining({ provider, id: "unconfigured-starter" }));
          expect(unavailable.models).toContainEqual(
            expect.objectContaining({ provider, id: nativeModelId }),
          );
          console.log("NATIVE_FIRST_PROVIDER_FAILURE", JSON.stringify({ requests, unavailable }));
          failedProviderCatalog = false;
          await client.request("models.list", { agentId: "main", view: "all", refresh: true });
          expect((await list()).models).toContainEqual(
            expect.objectContaining({ provider, id: "provider-account" }),
          );
          const beforeOpaqueReload = requests.length;
          nativeReleased = new Promise<void>((resolve) => {
            releaseNative = resolve;
          });
          await client.request("models.authRefresh", { agentId: "main", operation: "logout" });
          await expect
            .poll(
              () =>
                requests.slice(beforeOpaqueReload).filter((path) => path === "/native/models")
                  .length,
              { timeout: 15_000 },
            )
            .toBe(1);
          const beforeOpaqueReads = requests.length;
          const opaquePending = await Promise.all([list(), list()]);
          expect(requests).toHaveLength(beforeOpaqueReads);
          for (const result of opaquePending) {
            expect(result.pendingProviders).toContain(provider);
            expect
              .soft(result.models)
              .not.toContainEqual(expect.objectContaining({ provider, id: nativeModelId }));
            expect(result.models).toContainEqual(
              expect.objectContaining({ provider, id: "provider-account" }),
            );
          }
          console.log("NATIVE_OPAQUE_ACCOUNT_PENDING", JSON.stringify({ requests, opaquePending }));
          releaseNative();
          await expect
            .poll(async () => (await list()).pendingProviders ?? [], { timeout: 15_000 })
            .not.toContain(provider);
        }
        if (withProviderCredentials) {
          const beforeUnrelated = requests.length;
          holdOther = true;
          const firstRefresh = client.request<ModelsListResult>("models.list", {
            agentId: "main",
            provider: "unrelated-native-fixture",
            view: "all",
            refresh: true,
          });
          await otherRequested;
          const secondRefresh = client.request<ModelsListResult>("models.list", {
            agentId: "main",
            provider: "unrelated-native-fixture",
            view: "all",
            refresh: true,
          });
          const concurrentReadStarted = performance.now();
          expect((await list()).models.find((row) => row.id === nativeModelId)?.available).toBe(
            true,
          );
          const concurrentReadMs = performance.now() - concurrentReadStarted;
          expect(concurrentReadMs).toBeLessThan(1_000);
          const foregroundResults = await Promise.all([firstRefresh, secondRefresh]);
          for (const result of foregroundResults) {
            expect(result.pendingProviders).toContain("unrelated-native-fixture");
          }
          releaseOther();
          await expect
            .poll(async () => (await list()).pendingProviders ?? [], { timeout: 15_000 })
            .not.toContain("unrelated-native-fixture");
          expect(requests.slice(beforeUnrelated)).toEqual(["/other/models"]);
          console.log(
            "NATIVE_PROVIDER_REFRESH_CONTENTION",
            JSON.stringify({
              concurrentReadMs,
              foregroundResults,
              requests: requests.slice(beforeUnrelated),
            }),
          );
          expect((await list()).models.find((row) => row.id === nativeModelId)?.available).toBe(
            true,
          );
          expect((await list()).models).toContainEqual(
            expect.objectContaining({
              provider: "unrelated-native-fixture",
              id: "unrelated-native-model",
            }),
          );
          failedNativeCatalog = true;
          const beforeFailure = requests.length;
          await expect
            .soft(client.request("models.list", { agentId: "main", provider, refresh: true }))
            .rejects.toThrow("Native catalog fixture unavailable");
          expect(requests.slice(beforeFailure)).toEqual(["/provider/models", "/native/models"]);
          const beforeFailureReads = requests.length;
          const failedReads = await Promise.all([list(), list()]);
          expect(requests).toHaveLength(beforeFailureReads);
          for (const failed of failedReads) {
            expect.soft(failed.refreshFailed).toBe(true);
            expect(failed.pendingProviders ?? []).not.toContain(provider);
            expect(failed.models).toContainEqual(
              expect.objectContaining({ provider, id: "native-account-only" }),
            );
            expect(failed.models).toContainEqual(
              expect.objectContaining({ provider, id: "configured-native" }),
            );
            expect(failed.models).toContainEqual(
              expect.objectContaining({
                provider: "unrelated-native-fixture",
                id: "unrelated-native-model",
              }),
            );
          }
          failedNativeCatalog = false;
          const beforeRecovery = requests.length;
          await client.request("models.list", { agentId: "main", provider, refresh: true });
          expect(requests.slice(beforeRecovery)).toEqual(["/provider/models", "/native/models"]);
          const recovered = await list();
          expect(recovered.refreshFailed).not.toBe(true);
          expect(recovered.models).toContainEqual(
            expect.objectContaining({ provider, id: "native-account-only" }),
          );
          nativeModelId = "native-new-release";
          const beforeScoped = requests.length;
          await client.request("models.list", { agentId: "main", provider, refresh: true });
          expect(requests.slice(beforeScoped)).toEqual(["/provider/models", "/native/models"]);
          expect((await list()).models.find((row) => row.id === nativeModelId)?.available).toBe(
            true,
          );
          const withdrawn = await list();
          expect
            .soft(withdrawn.models)
            .not.toContainEqual(expect.objectContaining({ provider, id: "native-account-only" }));
          expect(withdrawn.models).toContainEqual(
            expect.objectContaining({
              provider: "unrelated-native-fixture",
              id: "unrelated-native-model",
              name: "Unrelated native model",
            }),
          );
          expect(withdrawn.models).not.toContainEqual(
            expect.objectContaining({
              provider: "unrelated-native-fixture",
              id: "outside-scope-new",
            }),
          );
          emptyNativeCatalog = true;
          const beforeEmpty = requests.length;
          await client.request("models.list", { agentId: "main", provider, refresh: true });
          expect(requests.slice(beforeEmpty)).toEqual(["/provider/models", "/native/models"]);
          const emptied = await list();
          expect
            .soft(emptied.models)
            .not.toContainEqual(expect.objectContaining({ provider, id: "native-new-release" }));
          expect
            .soft(emptied.models)
            .not.toContainEqual(expect.objectContaining({ provider, id: "native-account-only" }));
          expect(emptied.models).toContainEqual(
            expect.objectContaining({ provider, id: "static-model" }),
          );
          expect(emptied.models).toContainEqual(
            expect.objectContaining({ provider, id: "configured-native" }),
          );
          expect(emptied.models).toContainEqual(
            expect.objectContaining({
              provider: "unrelated-native-fixture",
              id: "unrelated-native-model",
            }),
          );
          expect(emptied.models).toContainEqual(
            expect.objectContaining({
              provider: "unrelated-native-fixture",
              id: "provider-account",
            }),
          );
          emptyNativeCatalog = false;
          await client.request("models.list", { agentId: "main", provider, refresh: true });
          const beforeReloadNative = requests.filter((path) => path === "/native/models").length;
          const config = await client.request<{ hash: string }>("config.get", {});
          await client.request("config.patch", {
            baseHash: config.hash,
            raw: JSON.stringify({
              agents: { defaults: { modelPolicy: { allow: [`${provider}/*`, "unused/*"] } } },
            }),
          });
          await expect
            .poll(() => requests.filter((path) => path === "/native/models").length, {
              timeout: 15_000,
            })
            .toBe(beforeReloadNative + 1);
          await expect
            .poll(
              async () => (await list()).models.find((row) => row.id === nativeModelId)?.available,
              { timeout: 15_000 },
            )
            .toBe(true);
          const beforeFullFailure = requests.length;
          nativeReleased = new Promise<void>((resolve) => {
            releaseNative = resolve;
          });
          failedNativeCatalog = true;
          const fullFailure = expect
            .soft(client.request("models.list", { agentId: "main", refresh: true }))
            .rejects.toThrow("Native catalog fixture unavailable");
          await expect
            .poll(
              () =>
                requests.slice(beforeFullFailure).filter((path) => path === "/native/models")
                  .length,
              { timeout: 15_000 },
            )
            .toBe(1);
          const beforeFullReads = requests.length;
          const fullReadStarted = performance.now();
          const fullPending = await Promise.all([list(), list()]);
          const fullReadMs = performance.now() - fullReadStarted;
          expect(fullReadMs).toBeLessThan(1_000);
          expect(requests).toHaveLength(beforeFullReads);
          console.log(
            "NATIVE_UNSCOPED_HELD",
            JSON.stringify({
              fullReadMs,
              requests: requests.slice(beforeFullFailure),
              fullPending,
            }),
          );
          for (const fullResult of fullPending) {
            expect(fullResult.pendingProviders).toContain(provider);
            expect
              .soft(fullResult.models)
              .toContainEqual(expect.objectContaining({ provider, id: nativeModelId }));
          }
          releaseNative();
          await fullFailure;
          const beforeFullFailedReads = requests.length;
          const fullFailed = await Promise.all([list(), list()]);
          expect(requests).toHaveLength(beforeFullFailedReads);
          console.log(
            "NATIVE_UNSCOPED_FAILED",
            JSON.stringify({ requests: requests.slice(beforeFullFailure), fullFailed }),
          );
          for (const failed of fullFailed) {
            expect(failed.refreshFailed).toBe(true);
            expect(failed.pendingProviders ?? []).not.toContain(provider);
            expect
              .soft(failed.models)
              .toContainEqual(expect.objectContaining({ provider, id: nativeModelId }));
          }
          failedNativeCatalog = false;
          await client.request("models.list", { agentId: "main", refresh: true });
          const fullRecovered = await list();
          expect(fullRecovered.refreshFailed).not.toBe(true);
          expect(fullRecovered.models).toContainEqual(
            expect.objectContaining({ provider, id: nativeModelId }),
          );
          expect(
            requests.slice(beforeFullFailure).filter((path) => path === "/native/models"),
          ).toHaveLength(2);
          const beforeRenewal = requests.length;
          nativeReleased = new Promise<void>((resolve) => {
            releaseNative = resolve;
          });
          await saveAccount("native-renewed");
          await client.request("models.authRefresh", { agentId: "main", operation: "update" });
          expect((await list()).models.some((row) => row.id === "provider-account")).toBe(true);
          await expect
            .poll(
              () =>
                requests.slice(beforeRenewal).filter((path) => path === "/native/models").length,
              { timeout: 15_000 },
            )
            .toBe(1);
          const beforeRenewalReads = requests.length;
          const renewalReadStarted = performance.now();
          const renewalPending = await Promise.all([list(), list()]);
          const renewalReadMs = performance.now() - renewalReadStarted;
          expect(renewalReadMs).toBeLessThan(1_000);
          expect(requests).toHaveLength(beforeRenewalReads);
          for (const result of renewalPending) {
            expect(result.pendingProviders).toContain(provider);
            expect
              .soft(result.models)
              .toContainEqual(expect.objectContaining({ provider, id: "native-new-release" }));
            expect(result.models).not.toContainEqual(
              expect.objectContaining({ provider, id: "harness-host-row" }),
            );
          }
          console.log(
            "NATIVE_RENEWAL_PENDING",
            JSON.stringify({
              renewalReadMs,
              requests: requests.slice(beforeRenewal),
              renewalPending,
            }),
          );
          releaseNative();
          await expect
            .poll(async () => (await list()).pendingProviders ?? [], { timeout: 15_000 })
            .not.toContain(provider);
          await expect
            .poll(
              async () => (await list()).models.find((row) => row.id === nativeModelId)?.available,
              { timeout: 15_000 },
            )
            .toBe(true);
          expect(
            requests.slice(beforeRenewal).filter((path) => path === "/native/models"),
          ).toHaveLength(1);
        }
        const settledRequests = requests.length;
        await Promise.all([list(), list(), list()]);
        expect(requests).toHaveLength(settledRequests);
        console.log(
          "NATIVE_LIFECYCLE_PROOF",
          JSON.stringify({ pendingReadMs, requests, pending, settled: await list() }),
        );
      } finally {
        releaseOther();
        releaseNative();
        await disconnectGatewayClient(client);
        await server.close();
      }
    } finally {
      releaseOther();
      releaseNative();
      endpoint.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        endpoint.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
      await state.cleanup();
    }
  },
  120_000,
);

it("models.list full refresh discovers an enabled provider without configured credentials", async () => {
  const state = await createOpenClawTestState({
    label: "credential-free-catalog",
    layout: "state-only",
    env: {
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_GMAIL_WATCHER: "1",
      OPENCLAW_SKIP_CRON: "1",
      OPENCLAW_SKIP_CANVAS_HOST: "1",
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    },
  });
  const provider = "credential-free-fixture";
  let requests = 0;
  const endpoint = createServer((_request, response) => {
    requests += 1;
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify([
        {
          id: "public-model",
          name: "Public model",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 32768,
          maxTokens: 4096,
        },
      ]),
    );
  });
  try {
    endpoint.listen(0, "127.0.0.1");
    await once(endpoint, "listening");
    const address = endpoint.address();
    if (!address || typeof address === "string") {
      throw new Error("Catalog endpoint has no TCP address");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;
    await state.writeJson("catalog-plugin/openclaw.plugin.json", {
      id: provider,
      providers: [provider],
      providerCatalogEntry: "./provider-discovery.cjs",
      configSchema: { type: "object", additionalProperties: false },
    });
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
    const pluginPath = await state.writeText(
      "catalog-plugin/index.cjs",
      `module.exports = {
      id: ${JSON.stringify(provider)}, register(api) { api.registerProvider(require("./provider-discovery.cjs")); }
    };`,
    );
    const token = "credential-free-gateway-token";
    const cfg = {
      agents: {
        defaults: { models: { [`${provider}/*`]: {} } },
        list: [{ id: "main", workspace: state.workspaceDir }],
      },
      plugins: {
        allow: [provider],
        load: { paths: [pluginPath] },
        slots: { memory: "none" },
        entries: { [provider]: { enabled: true } },
      },
      gateway: { mode: "local", auth: { mode: "token", token } },
    };
    await state.writeConfig(cfg);
    const { client, server } = await startGatewayWithClient({
      cfg,
      configPath: state.configPath,
      token,
      scopes: ["operator.admin"],
    });
    try {
      await server.startupSettled;
      const list = (refresh = false) =>
        client.request<ModelsListResult>("models.list", { agentId: "main", view: "all", refresh });
      expect((await list()).models.some((row) => row.id === "public-model")).toBe(false);
      expect(requests).toBe(0);
      const refreshed = await list(true);
      console.log("FULL_CATALOG_WITHOUT_CREDENTIALS", JSON.stringify({ requests, refreshed }));
      expect(refreshed.models).toContainEqual(
        expect.objectContaining({ provider, id: "public-model" }),
      );
      expect(requests).toBe(1);
      expect((await list()).models).toContainEqual(
        expect.objectContaining({ provider, id: "public-model" }),
      );
      expect(requests).toBe(1);
    } finally {
      await disconnectGatewayClient(client);
      await server.close();
    }
  } finally {
    endpoint.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      endpoint.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
    await state.cleanup();
  }
}, 120_000);
