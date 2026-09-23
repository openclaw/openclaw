import { once } from "node:events";
import { createServer } from "node:http";
import { expect, it } from "vitest";
import type { ModelsListResult } from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { disconnectGatewayClient, startGatewayWithClient } from "../test-helpers.e2e.js";

it("models.list preserves provider starters and retires unavailable account rows after an authoritative empty refresh", async () => {
  const state = await createOpenClawTestState({
    label: "models-list-discovery-lifecycle",
    env: {
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_GMAIL_WATCHER: "1",
      OPENCLAW_SKIP_CRON: "1",
      OPENCLAW_SKIP_CANVAS_HOST: "1",
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
      OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
      OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
    },
  });
  const providers = ["lifecycle-a", "lifecycle-b", "lifecycle-c"];
  const rows = new Map([
    ["lifecycle-a", ["learned", "Learned"]],
    ["lifecycle-b", []],
    ["lifecycle-c", []],
  ]);
  const unavailable = new Set(["lifecycle-c"]);
  const requests: string[] = [];
  const endpoint = createServer((request, response) => {
    const provider = request.url?.slice(1) ?? "";
    requests.push(provider);
    if (!rows.has(provider) || request.headers.authorization !== `Bearer ${provider}-key`) {
      response.writeHead(401).end();
      return;
    }
    if (unavailable.has(provider)) {
      response.writeHead(503).end();
      return;
    }
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(rows.get(provider)!.map((id) => ({ id, name: id }))));
  });
  try {
    endpoint.listen(0, "127.0.0.1");
    await once(endpoint, "listening");
    const address = endpoint.address();
    if (!address || typeof address === "string") {
      throw new Error("Discovery fixture did not bind a TCP port");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;
    await state.writeJson("bundled/lifecycle-catalog/openclaw.plugin.json", {
      id: "lifecycle-catalog",
      providers,
      modelCatalog: {
        discovery: Object.fromEntries(providers.map((provider) => [provider, "refreshable"])),
        providers: {
          "lifecycle-c": {
            baseUrl,
            api: "openai-completions",
            models: [
              {
                id: "starter",
                name: "Starter",
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
    await state.writeText(
      "bundled/lifecycle-catalog/index.js",
      `module.exports = {
        id: "lifecycle-catalog",
        register(api) {
          for (const provider of ${JSON.stringify(providers)}) {
            api.registerProvider({
              id: provider, label: provider, auth: [],
              staticCatalog: provider === "lifecycle-c" ? {
                order: "simple",
                async run() {
                  return { provider: require("./openclaw.plugin.json").modelCatalog.providers[provider] };
                },
              } : undefined,
              catalog: {
                order: "profile",
                async run(ctx) {
                  const auth = ctx.resolveProviderAuth(provider);
                  if (!auth.discoveryApiKey) return null;
                  const response = await fetch(${JSON.stringify(baseUrl)} + "/" + provider, {
                    headers: { Authorization: "Bearer " + auth.discoveryApiKey },
                  });
                  if (!response.ok) return { providers: {}, outcomes: [{ provider, status: "unavailable" }] };
                  const rows = await response.json();
                  return { provider: {
                    baseUrl: ${JSON.stringify(baseUrl)}, api: "openai-completions",
                    models: rows.map((row) => ({
                      ...row, reasoning: false, input: ["text"],
                      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                      contextWindow: 32768, maxTokens: 4096,
                    })),
                  } };
                },
              },
            });
          }
        },
      };`,
    );
    state.envVars.OPENCLAW_BUNDLED_PLUGINS_DIR = state.statePath("bundled");
    state.applyEnv();
    const token = "catalog-lifecycle-gateway-token";
    const cfg = {
      models: {
        providers: {
          "lifecycle-c": {
            baseUrl,
            api: "openai-completions",
            apiKey: "lifecycle-c-key",
            models: [],
          },
        },
      },
      agents: {
        defaults: { modelPolicy: { allow: providers.map((provider) => `${provider}/*`) } },
        list: [{ id: "main", workspace: state.workspaceDir }],
      },
      plugins: {
        allow: ["lifecycle-catalog"],
        entries: { "lifecycle-catalog": { enabled: true } },
        slots: { memory: "none" },
      },
      gateway: { mode: "local", auth: { mode: "token", token } },
    };
    await state.writeConfig(cfg);
    await state.writeAuthProfiles({
      version: 1,
      profiles: Object.fromEntries(
        providers
          .filter((provider) => provider !== "lifecycle-c")
          .map((provider) => [
            `${provider}:default`,
            { type: "api_key", provider, key: `${provider}-key` },
          ]),
      ),
    });
    const { client, server } = await startGatewayWithClient({
      cfg,
      configPath: state.configPath,
      token,
      scopes: ["operator.admin"],
    });
    try {
      await server.startupSettled;
      const list = (provider?: string) =>
        client.request<ModelsListResult>("models.list", {
          agentId: "main",
          view: "all",
          refresh: true,
          ...(provider ? { provider } : {}),
        });
      const ids = (result: ModelsListResult, provider: string) =>
        result.models
          .filter((model) => model.provider === provider)
          .map((model) => model.id)
          .toSorted();
      expect(ids(await list("lifecycle-b"), "lifecycle-b")).toEqual([]);
      const firstUnavailable = await list("lifecycle-c");
      expect(requests.indexOf("lifecycle-b")).toBeGreaterThanOrEqual(0);
      expect(requests.indexOf("lifecycle-c")).toBeGreaterThan(requests.indexOf("lifecycle-b"));
      expect(requests.filter((provider) => provider === "lifecycle-c")).toHaveLength(1);
      expect(ids(firstUnavailable, "lifecycle-c")).toEqual(["starter"]);
      expect(firstUnavailable.refreshFailed).toBe(true);
      unavailable.delete("lifecycle-c");
      rows.set("lifecycle-b", ["sibling"]);
      expect(ids(await list(), "lifecycle-a")).toEqual(["Learned", "learned"]);

      unavailable.add("lifecycle-a");
      rows.set("lifecycle-b", ["sibling-new"]);
      const degraded = await list();
      expect(ids(degraded, "lifecycle-a")).toEqual(["Learned", "learned"]);
      expect(ids(degraded, "lifecycle-b")).toEqual(["sibling-new"]);
      expect(degraded.refreshFailed).toBe(true);

      unavailable.delete("lifecycle-a");
      rows.set("lifecycle-a", []);
      const beforeEmpty = requests.length;
      const empty = await list("lifecycle-a");
      expect(ids(empty, "lifecycle-a")).toEqual([]);
      expect(requests.slice(beforeEmpty)).toEqual(["lifecycle-a"]);
      const afterEmpty = await client.request<ModelsListResult>("models.list", {
        agentId: "main",
        view: "all",
      });
      expect(ids(afterEmpty, "lifecycle-b")).toEqual(["sibling-new"]);
      expect(afterEmpty.refreshFailed).not.toBe(true);

      unavailable.add("lifecycle-a");
      const failedAgain = await list("lifecycle-a");
      expect(ids(failedAgain, "lifecycle-a")).toEqual([]);
      expect(failedAgain.refreshFailed).toBe(true);

      unavailable.delete("lifecycle-a");
      rows.set("lifecycle-a", ["recovered"]);
      const recovered = await list("lifecycle-a");
      expect(ids(recovered, "lifecycle-a")).toEqual(["recovered"]);
      expect(recovered.refreshFailed).not.toBe(true);
      const afterRecovery = requests.length;
      for (let read = 0; read < 3; read++) {
        const published = await client.request<ModelsListResult>("models.list", {
          agentId: "main",
          view: "all",
        });
        expect(ids(published, "lifecycle-a")).toEqual(["recovered"]);
        expect(ids(published, "lifecycle-b")).toEqual(["sibling-new"]);
      }
      expect(requests).toHaveLength(afterRecovery);
    } finally {
      await disconnectGatewayClient(client);
      await server.close();
    }
  } finally {
    endpoint.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      endpoint.close((error) => (error ? reject(error) : resolve()));
    });
    await state.cleanup();
  }
}, 120_000);
