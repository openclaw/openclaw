import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import type { ModelsListResult } from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import type { WizardNextResult } from "../../../packages/gateway-protocol/src/schema/wizard.js";
import { createDeferred, withTestTimeout } from "../../../test/helpers/promise.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { disconnectGatewayClient, startGatewayWithClient } from "../test-helpers.e2e.js";
import {
  observeCatalogWorkerTasks,
  waitForCatalogPublication,
} from "./models-auth-catalog.test-support.js";

it(
  "models.authLogin publishes delayed account rows to passive models.list",
  { timeout: 120_000 },
  async ({ signal }) => {
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
    const catalogWork = observeCatalogWorkerTasks();
    const requests: string[] = [];
    let responseDelay = 7_000;
    let holdNextCatalogResponse = false;
    const automaticRequestStarted = createDeferred();
    const releaseEarlyResponse = createDeferred();
    const refreshRequestStarted = createDeferred<ServerResponse>();
    const releaseRefreshResponse = createDeferred();
    const endpoint = createServer((request, response) => {
      requests.push(request.url ?? "");
      response.setHeader("Content-Type", "application/json");
      if (request.url === "/token" && request.method === "POST") {
        response.end(
          JSON.stringify({ access_token: "fixture-access", refresh_token: "fixture-refresh" }),
        );
      } else if (
        request.url === "/models" &&
        request.headers.authorization === "Bearer fixture-access"
      ) {
        automaticRequestStarted.resolve();
        let responseReady: Promise<void>;
        if (holdNextCatalogResponse) {
          holdNextCatalogResponse = false;
          responseReady = releaseRefreshResponse.promise;
          refreshRequestStarted.resolve(response);
        } else {
          responseReady = delay(responseDelay).then(() => releaseEarlyResponse.promise);
        }
        void responseReady.then(() =>
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
          entries: { main: { workspace: state.workspaceDir } },
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
        const beforeLoginWork = catalogWork.read();
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
        const observePassiveReads = async (stage: "early" | "final") => {
          const before = requests.filter((url) => url === "/models").length;
          const reads = await Promise.all([list(), list()]);
          return {
            stage,
            before,
            after: requests.filter((url) => url === "/models").length,
            reads,
          };
        };
        await withTestTimeout(
          automaticRequestStarted.promise,
          10_000,
          "Login did not start automatic catalog discovery",
        );
        const observations = [await observePassiveReads("early")];
        await waitForCatalogPublication({
          signal,
          start: () => {
            releaseEarlyResponse.resolve();
            return list();
          },
          read: list,
          ready: ({ ids }) => ids.includes("account-exclusive"),
        });
        observations.push(await observePassiveReads("final"));
        expect(requests.filter((url) => url === "/models")).toHaveLength(1);
        expect(catalogWork.read()).toMatchObject({
          maxWorkers: 1,
          workersCreated: 1,
          pendingTasks: 0,
          completedTasks: beforeLoginWork.completedTasks + 1,
        });
        responseDelay = 0;
        const manualRefresh = await list(true);
        const session = await client.request<{ key: string }>("sessions.create", {
          agentId: "main",
        });
        await client.request("sessions.patch", {
          key: session.key,
          model: `${provider}/account-exclusive@${provider}:owner`,
        });
        holdNextCatalogResponse = true;
        const refresh = client.request("models.list", {
          agentId: "main",
          provider,
          refresh: true,
        });
        void refresh.catch((error: unknown) => {
          refreshRequestStarted.reject(error);
        });
        try {
          const heldResponse = await refreshRequestStarted.promise;
          const selectedAccount = await client.request<ModelsListResult>("models.list", {
            sessionKey: session.key,
            view: "configured",
          });
          expect(selectedAccount.pendingProviders ?? []).not.toContain(provider);
          expect(heldResponse.writableEnded).toBe(false);
          expect(heldResponse.destroyed).toBe(false);
        } finally {
          holdNextCatalogResponse = false;
          releaseRefreshResponse.resolve();
          await refresh;
        }
        expect(manualRefresh.ids).toContain("account-exclusive");
        expect(requests.filter((url) => url === "/token")).toHaveLength(1);
        for (const observation of observations) {
          expect.soft(observation.after).toBe(observation.before);
          for (const read of observation.reads) {
            expect.soft(read.elapsedMs).toBeLessThan(1_000);
            if (observation.stage === "early") {
              expect.soft(read.result.pendingProviders).toContain(provider);
            }
            if (observation.stage === "final") {
              expect.soft(read.ids).toContain("account-exclusive");
            }
          }
        }
      } finally {
        releaseEarlyResponse.resolve();
        await disconnectGatewayClient(client);
        await server.close();
      }
    } finally {
      catalogWork.close();
      endpoint.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        endpoint.close((error) => (error ? reject(error) : resolve()));
      });
      await state.cleanup();
    }
  },
);
