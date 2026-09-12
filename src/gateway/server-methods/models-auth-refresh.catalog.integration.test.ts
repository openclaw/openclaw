import { once } from "node:events";
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import type { ModelsListResult } from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { disconnectGatewayClient, startGatewayWithClient } from "../test-helpers.e2e.js";

describe("models.authRefresh learned catalog", () => {
  it("models.authRefresh retains same-account rows while renewing and discovers a replacement account", async () => {
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
    let holdDiscovery = false;
    const heldResponses: Array<() => void> = [];
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
        heldResponses.push(reply);
      } else {
        reply();
      }
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
        const renewalRequest = once(discovery, "request");
        const renewalStarted = Date.now();
        await saveAccount("account-one", "account-one-renewed");
        await expect(
          client.request("models.authRefresh", { agentId: "main", operation: "update" }),
        ).resolves.toEqual({ refreshed: true });
        expect((await list()).map((model) => model.id)).toEqual(["account-one-learned"]);
        console.log(
          "RENEWAL_PENDING",
          await client.request("models.list", { agentId: "main", view: "all" }),
        );
        await renewalRequest;
        console.log("RENEWAL_REQUEST_MS", Date.now() - renewalStarted);
        expect(requests.slice(initialRequests)).toEqual(["Bearer account-one-renewed"]);
        const renewedRequests = requests.length;
        const replacementRequest = once(discovery, "request");
        await saveAccount("account-two", "account-two-original");
        await client.request("models.authRefresh", { agentId: "main", operation: "login" });
        expect((await list()).map((model) => model.id)).not.toContain("account-one-learned");
        await replacementRequest;
        await expect
          .poll(async () => (await list()).map((model) => model.id))
          .toEqual(["account-two-learned"]);
        expect(requests.slice(renewedRequests)).toEqual(["Bearer account-two-original"]);

        holdDiscovery = true;
        const heldRequest = once(discovery, "request");
        const refreshSettled = Promise.allSettled([
          client.request("models.list", { agentId: "main", provider, refresh: true }),
        ]);
        await heldRequest;
        await state.writeAuthProfiles({ version: 1, profiles: {} });
        const logoutStarted = Date.now();
        await client.request("models.authRefresh", { agentId: "main", operation: "logout" });
        const logoutMs = Date.now() - logoutStarted;
        console.log("LOGOUT_DURING_DISCOVERY_MS", logoutMs);
        expect(logoutMs).toBeLessThan(1_000);
        for (const reply of heldResponses) {
          reply();
        }
        await refreshSettled;
        expect((await list()).filter((model) => model.available)).toEqual([]);
        expect((await list()).map((model) => model.id)).not.toContain("account-two-learned");
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
