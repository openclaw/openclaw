import { once } from "node:events";
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import type { ModelsListResult } from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { disconnectGatewayClient, startGatewayWithClient } from "../test-helpers.e2e.js";

describe("models.authRefresh learned catalog", () => {
  it("retains discovery on same-account renewal and replaces it for another account", async () => {
    const state = await createOpenClawTestState({
      label: "models-auth-refresh-catalog",
      env: {
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      },
    });
    const provider = "renewal-fixture";
    const requests: string[] = [];
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
      response.end(JSON.stringify([{ id: `${account}-learned`, name: `${account} learned` }]));
    });
    const saveAccount = async (accountId: string, access: string) => {
      const store: AuthProfileStore = {
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
      };
      await state.writeAuthProfiles(store);
    };
    try {
      discovery.listen(0, "127.0.0.1");
      await once(discovery, "listening");
      const address = discovery.address();
      if (!address || typeof address === "string") {
        throw new Error("Discovery fixture did not bind a TCP port");
      }
      const baseUrl = `http://127.0.0.1:${address.port}`;
      await state.writeJson("catalog-plugin/openclaw.plugin.json", {
        id: provider,
        providers: [provider],
        configSchema: { type: "object", additionalProperties: false },
      });
      const pluginPath = await state.writeText(
        "catalog-plugin/index.cjs",
        `module.exports = {
          id: ${JSON.stringify(provider)},
          register(api) {
            api.registerProvider({
              id: ${JSON.stringify(provider)}, label: "Renewal fixture", auth: [],
              formatApiKey: (credential) => credential.access,
              catalog: {
                order: "profile",
                async run(ctx) {
                  const auth = ctx.resolveProviderAuth(${JSON.stringify(provider)});
                  if (!auth.discoveryApiKey) return null;
                  const response = await fetch(${JSON.stringify(`${baseUrl}/models`)}, {
                    headers: { Authorization: "Bearer " + auth.discoveryApiKey },
                  });
                  if (!response.ok) throw new Error("Fixture discovery rejected credentials");
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
          },
        };`,
      );
      const token = "catalog-renewal-gateway-token";
      const cfg = {
        agents: {
          defaults: { modelPolicy: { allow: [`${provider}/*`] } },
          list: [{ id: "main", workspace: state.workspaceDir }],
        },
        plugins: {
          allow: [provider],
          load: { paths: [pluginPath] },
          slots: { memory: "none" },
        },
        gateway: { mode: "local", auth: { mode: "token", token } },
      };
      await state.writeConfig(cfg);
      await saveAccount("account-one", "account-one-original");
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
          return result.models.filter((model) => model.provider === provider);
        };
        const original = await list(true);
        expect(original.map((model) => model.id)).toEqual(["account-one-learned"]);
        expect(requests.length).toBeGreaterThan(0);
        expect(
          requests.every((authorization) => authorization === "Bearer account-one-original"),
        ).toBe(true);
        const initialRequests = requests.length;

        await saveAccount("account-one", "account-one-renewed");
        await expect(
          client.request("models.authRefresh", { agentId: "main", operation: "update" }),
        ).resolves.toEqual({ refreshed: true });
        expect((await list()).map((model) => model.id)).toEqual(["account-one-learned"]);
        expect(requests).toHaveLength(initialRequests);

        // An explicit refresh proves that the renewed bearer is now used.
        await list(true);
        expect(requests.slice(initialRequests)).toEqual(["Bearer account-one-renewed"]);
        const renewedRequests = requests.length;
        await saveAccount("account-two", "account-two-original");
        await client.request("models.authRefresh", { agentId: "main", operation: "login" });
        expect((await list()).map((model) => model.id)).not.toContain("account-one-learned");
        expect(requests).toHaveLength(renewedRequests);
        expect((await list(true)).map((model) => model.id)).toEqual(["account-two-learned"]);
        expect(requests.slice(renewedRequests)).toEqual(["Bearer account-two-original"]);

        await state.writeAuthProfiles({ version: 1, profiles: {} });
        await client.request("models.authRefresh", { agentId: "main", operation: "logout" });
        expect((await list()).filter((model) => model.available)).toEqual([]);
      } finally {
        await disconnectGatewayClient(client);
        await server.close();
      }
    } finally {
      try {
        await new Promise<void>((resolve, reject) => {
          discovery.close((error) => (error ? reject(error) : resolve()));
        });
      } finally {
        await state.cleanup();
      }
    }
  });
});
