import { once } from "node:events";
import { createServer } from "node:http";
import { expect, it } from "vitest";
import type { ModelsListResult } from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { disconnectGatewayClient, startGatewayWithClient } from "../test-helpers.e2e.js";

it.each([
  {
    allow: ["membership-fixture/manual"],
    agentPolicy: false,
    secondHook: false,
    expected: ["account-only", "manual"],
  },
  { allow: [], agentPolicy: false, secondHook: false, expected: ["account-only", "manual"] },
  {
    allow: ["membership-fixture/manual"],
    agentPolicy: true,
    secondHook: false,
    expected: ["manual"],
  },
  {
    allow: ["membership-fixture/manual"],
    agentPolicy: false,
    secondHook: true,
    expected: ["account-only", "manual", "sibling-only"],
  },
])(
  "models.list recomposes fetched membership after config.patch from $allow (agent override: $agentPolicy, second hook: $secondHook) without discovery",
  async ({ allow, agentPolicy, secondHook, expected }) => {
    const state = await createOpenClawTestState({
      label: "catalog-membership",
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
    const provider = "membership-fixture";
    let requests = 0;
    const endpoint = createServer((request, response) => {
      requests++;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify(
          request.url === "/sibling" ? ["manual", "sibling-only"] : ["manual", "account-only"],
        ),
      );
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
        providers: secondHook ? [provider, "membership-sibling"] : [provider],
        configSchema: { type: "object", additionalProperties: false },
      });
      const pluginPath = await state.writeText(
        "catalog-plugin/index.cjs",
        `module.exports = {
          id: "membership-fixture", register(api) {
            for (const [id, suffix] of ${JSON.stringify(
              secondHook
                ? [
                    [provider, ""],
                    ["membership-sibling", "/sibling"],
                  ]
                : [[provider, ""]],
            )}) api.registerProvider({ id, hookAliases: ["membership-fixture"], label: "Membership fixture", auth: [],
              catalog: { order: "profile", async run(ctx) {
                if (!ctx.resolveProviderAuth("membership-fixture").discoveryApiKey) return null;
                const response = await fetch(${JSON.stringify(baseUrl)} + suffix);
                const rows = await response.json();
                return { providers: { "membership-fixture": { baseUrl: ${JSON.stringify(baseUrl)}, api: "openai-completions",
                  models: rows.map(id => ({ id, name: id, reasoning: false, input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 4096 })) } } };
              } },
            });
          },
        };`,
      );
      const token = "membership-gateway-token";
      const cfg = {
        agents: {
          defaults: {
            model: `${provider}/manual`,
            modelPolicy: { allow: agentPolicy ? [`${provider}/*`] : allow },
          },
          entries: {
            main: {
              workspace: state.workspaceDir,
              ...(agentPolicy ? { modelPolicy: { allow } } : {}),
            },
          },
        },
        models: {
          catalogRefresh: { enabled: false },
          providers: {
            [provider]: {
              baseUrl,
              api: "openai-completions" as const,
              models: [
                {
                  id: "manual",
                  name: "Manual model",
                  reasoning: false,
                  input: ["text" as const],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 32768,
                  maxTokens: 4096,
                },
              ],
            },
          },
        },
        plugins: {
          enabled: true,
          allow: [provider],
          entries: { [provider]: { enabled: true } },
          load: { paths: [pluginPath] },
          slots: { memory: "none" },
        },
        gateway: { mode: "local", auth: { mode: "token", token } },
      };
      await state.writeConfig(cfg);
      await state.writeAuthProfiles({
        version: 1,
        profiles: {
          [`${provider}:default`]: { type: "api_key", provider, key: "membership-account-key" },
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
            refresh,
          });
          return result.models.filter((row) => row.provider === provider).map((row) => row.id);
        };
        expect(await list(true)).toEqual(["manual"]);
        expect(requests).toBeGreaterThan(0);
        const acquired = requests;
        expect(await list()).toEqual(["manual"]);
        expect(requests).toBe(acquired);

        const setPolicy = async (refs: string[]) => {
          const config = await client.request<{ hash: string }>("config.get", {});
          await client.request("config.patch", {
            baseHash: config.hash,
            replacePaths: ["agents.defaults.modelPolicy.allow"],
            raw: JSON.stringify({
              agents: { defaults: { modelPolicy: { allow: refs } } },
            }),
          });
        };
        await setPolicy([`${provider}/*`]);
        await expect.poll(() => list(), { timeout: 15_000 }).toEqual(expected);
        expect(requests).toBe(acquired);

        await setPolicy([`${provider}/manual`]);
        await expect.poll(() => list(), { timeout: 15_000 }).toEqual(["manual"]);
        expect(requests).toBe(acquired);
      } finally {
        await disconnectGatewayClient(client);
        await server.close({ reason: "catalog membership test complete" });
      }
    } finally {
      await new Promise<void>((resolve) => {
        endpoint.close(() => resolve());
      });
      await state.cleanup();
    }
  },
  60_000,
);
