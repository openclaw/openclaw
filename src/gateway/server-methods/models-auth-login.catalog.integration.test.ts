import { once } from "node:events";
import { createServer } from "node:http";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import type { ModelsListResult } from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import type { WizardNextResult } from "../../../packages/gateway-protocol/src/schema/wizard.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { disconnectGatewayClient, startGatewayWithClient } from "../test-helpers.e2e.js";

it.each([0, 7_000])(
  "models.authLogin publishes account rows to passive models.list (endpoint delay %i ms)",
  async (catalogDelay) => {
    const state = await createOpenClawTestState({
      label: "login-discovery",
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
    const provider = "login-discovery-fixture";
    const trace: Array<{ path: string; time: number; method: string; authenticated: boolean }> = [];
    let responseDelay = catalogDelay;
    const endpoint = createServer((request, response) => {
      trace.push({
        path: request.url ?? "",
        time: performance.now(),
        method: request.method ?? "",
        authenticated: request.headers.authorization === "Bearer fixture-access",
      });
      response.setHeader("Content-Type", "application/json");
      if (request.url === "/token" && request.method === "POST") {
        response.end(
          JSON.stringify({ access_token: "fixture-access", refresh_token: "fixture-refresh" }),
        );
      } else if (
        request.url === "/models" &&
        request.headers.authorization === "Bearer fixture-access"
      ) {
        void delay(responseDelay).then(() =>
          response.end(JSON.stringify([{ id: "account-exclusive", name: "Account exclusive" }])),
        );
      } else {
        response.writeHead(401).end(JSON.stringify({ error: "unauthorized" }));
      }
    });
    try {
      endpoint.listen(0, "127.0.0.1");
      await once(endpoint, "listening");
      const address = endpoint.address();
      if (!address || typeof address === "string") {
        throw new Error("Fixture endpoint has no TCP address");
      }
      const baseUrl = `http://127.0.0.1:${address.port}`;
      await state.writeJson("login-plugin/openclaw.plugin.json", {
        id: provider,
        providers: [provider],
        configSchema: { type: "object", additionalProperties: false },
        providerAuthChoices: [
          {
            provider,
            method: "oauth",
            choiceId: "fixture-oauth",
            choiceLabel: "Fixture account",
            appGuidedAuth: "device-code",
            credentialOnly: true,
            channelLogin: {},
          },
        ],
      });
      const pluginPath = await state.writeText(
        "login-plugin/index.cjs",
        `module.exports = {
      id: ${JSON.stringify(provider)}, register(api) { api.registerProvider({
        id: ${JSON.stringify(provider)}, label: "Fixture account", formatApiKey: credential => credential.access,
        auth: [{ id: "oauth", label: "Fixture account", kind: "oauth", async run(ctx) {
          if (ctx.credentialOnly !== true) throw new Error("Expected registered credential-only login");
          const approved = await ctx.prompter.confirm({ message: "Approve fixture account", initialValue: true });
          if (!approved) throw new Error("Fixture account was not approved");
          const response = await fetch(${JSON.stringify(`${baseUrl}/token`)}, { method: "POST" });
          if (!response.ok) throw new Error("Fixture token exchange failed");
          const token = await response.json();
          return { profiles: [{ profileId: ${JSON.stringify(`${provider}:owner`)}, credential: {
            type: "oauth", provider: ${JSON.stringify(provider)}, access: token.access_token,
            refresh: token.refresh_token, expires: Date.now() + 3600000,
            accountId: "fixture-account", email: "fixture@example.invalid",
          } }] };
        } }], catalog: { order: "profile", async run(ctx) {
          const auth = ctx.resolveProviderAuth(${JSON.stringify(provider)});
          if (!auth.discoveryApiKey) return null;
          const response = await fetch(${JSON.stringify(`${baseUrl}/models`)}, { headers: { Authorization: "Bearer " + auth.discoveryApiKey } });
          if (!response.ok) throw new Error("Fixture catalog rejected account");
          return { provider: { baseUrl: ${JSON.stringify(baseUrl)}, api: "openai-completions",
            models: (await response.json()).map(row => ({ ...row, reasoning: false, input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 4096 })) } };
        } },
      }); }
    };`,
      );
      const token = "login-discovery-gateway-token";
      const cfg = {
        agents: {
          defaults: { modelPolicy: { allow: [`${provider}/*`] } },
          list: [{ id: "main", workspace: state.workspaceDir }],
        },
        plugins: { allow: [provider], load: { paths: [pluginPath] }, slots: { memory: "none" } },
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
        const list = async (refresh = false) => {
          const started = performance.now();
          const result = await client.request<ModelsListResult>("models.list", {
            agentId: "main",
            view: "configured",
            refresh,
          });
          return {
            elapsedMs: performance.now() - started,
            ids: result.models.filter((row) => row.provider === provider).map((row) => row.id),
            result,
          };
        };
        expect((await list()).ids).not.toContain("account-exclusive");
        await client.request("models.authLogin", {
          sessionId: "fixture-login",
          agentId: "main",
          authChoice: `${provider}/fixture-oauth`,
        });
        let wizard = await client.request<WizardNextResult>("wizard.next", {
          sessionId: "fixture-login",
        });
        while (!wizard.done) {
          const step = wizard.step;
          if (!step || !["note", "confirm"].includes(step.type)) {
            throw new Error(`Unexpected login step: ${JSON.stringify(wizard)}`);
          }
          wizard = await client.request<WizardNextResult>("wizard.next", {
            sessionId: "fixture-login",
            answer: { stepId: step.id, value: step.type === "confirm" ? true : null },
          });
        }
        expect(wizard.status, wizard.error).toBe("done");
        const loginCompleted = performance.now();
        const observations = [];
        for (const offsetMs of [1_000, 10_000]) {
          await delay(Math.max(0, loginCompleted + offsetMs - performance.now()));
          const before = trace.filter((row) => row.path === "/models").length;
          const reads = await Promise.all([list(), list()]);
          observations.push({
            offsetMs,
            observedAtMs: performance.now() - loginCompleted,
            before,
            after: trace.filter((row) => row.path === "/models").length,
            reads,
          });
        }
        const automaticTrace = trace.map((row) => ({ ...row, time: row.time - loginCompleted }));
        responseDelay = 0;
        const manualRefresh = await list(true);
        if (catalogDelay === 7_000) {
          const session = await client.request<{ key: string }>("sessions.create", {
            agentId: "main",
          });
          await client.request("sessions.patch", {
            key: session.key,
            model: `${provider}/account-exclusive@${provider}:owner`,
          });
          responseDelay = 7_000;
          const refreshStarted = once(endpoint, "request");
          const refresh = client.request("models.list", {
            agentId: "main",
            provider,
            refresh: true,
          });
          await refreshStarted;
          const selectedAccount = await client.request<ModelsListResult>("models.list", {
            sessionKey: session.key,
            view: "configured",
          });
          expect(selectedAccount.pendingProviders ?? []).not.toContain(provider);
          await refresh;
        }
        console.log(
          "LOGIN_DISCOVERY_PROOF",
          JSON.stringify({
            catalogDelay,
            observations,
            automaticTrace,
            manualRefresh,
            finalTrace: trace.map((row) => ({ ...row, time: row.time - loginCompleted })),
          }),
        );
        expect(manualRefresh.ids).toContain("account-exclusive");
        expect(trace.filter((row) => row.path === "/token")).toHaveLength(1);
        for (const observation of observations) {
          expect.soft(observation.after).toBe(observation.before);
          for (const read of observation.reads) {
            expect.soft(read.elapsedMs).toBeLessThan(1_000);
            if (
              observation.offsetMs === 1_000 &&
              (catalogDelay === 7_000 || !read.ids.includes("account-exclusive"))
            ) {
              expect.soft(read.result.pendingProviders).toContain(provider);
            }
            if (observation.offsetMs === 10_000) {
              expect.soft(read.ids).toContain("account-exclusive");
            }
          }
        }
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
  },
  120_000,
);
