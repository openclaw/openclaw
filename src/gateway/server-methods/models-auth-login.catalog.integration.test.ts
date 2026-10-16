import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import type { ModelsListResult } from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import type { WizardNextResult } from "../../../packages/gateway-protocol/src/schema/wizard.js";
import { createDeferred, withinTest, withTestTimeout } from "../../../test/helpers/promise.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { disconnectGatewayClient, startGatewayWithClient } from "../test-helpers.e2e.js";
import {
  observeCatalogWorkerTasks,
  waitForCatalogPublication,
} from "./models-auth-catalog.test-support.js";

it.for([false, true])(
  "models.authLogin publishes delayed account rows to passive models.list (configured: %s)",
  { timeout: 120_000 },
  async (configured, { signal }) => {
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
    let listingStatus = 200;
    let heldCatalogResponse: ReturnType<typeof holdNextCatalogResponse> | undefined;
    function holdNextCatalogResponse() {
      const held = { started: createDeferred<ServerResponse>(), release: createDeferred() };
      heldCatalogResponse = held;
      return held;
    }
    const automaticRequestStarted = createDeferred();
    const releaseEarlyResponse = createDeferred();
    const endpoint = createServer((request, response) => {
      requests.push(request.url ?? "");
      response.setHeader("Content-Type", "application/json");
      const send = (data: unknown, code = 200) =>
        response.writeHead(code).end(JSON.stringify(data));
      if (request.url === "/token" && request.method === "POST") {
        send({ access_token: "fixture-access", refresh_token: "fixture-refresh" });
      } else if (
        request.url === "/models" &&
        request.headers.authorization === "Bearer fixture-access"
      ) {
        automaticRequestStarted.resolve();
        let responseReady: Promise<void>;
        const held = heldCatalogResponse;
        if (held) {
          heldCatalogResponse = undefined;
          responseReady = held.release.promise;
          held.started.resolve(response);
        } else {
          responseReady = delay(responseDelay).then(() => releaseEarlyResponse.promise);
        }
        void responseReady.then(() =>
          send(
            listingStatus === 200
              ? [{ id: "account-exclusive", name: "Account exclusive" }]
              : { error: "unavailable" },
            listingStatus,
          ),
        );
      } else {
        send({ error: "unauthorized" }, 401);
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
        modelCatalog: {
          discovery: { [provider]: "refreshable" },
          providers: {
            [provider]: {
              baseUrl,
              api: "openai-completions",
              models: [{ id: "known-chat", name: "Known chat" }],
            },
          },
        },
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
          ...(configured ? { defaults: { modelPolicy: { allow: [`${provider}/*`] } } } : {}),
          entries: { main: { workspace: state.workspaceDir } },
        },
        plugins: { allow: [provider], load: { paths: [pluginPath] }, slots: { memory: "none" } },
        gateway: { mode: "local", auth: { mode: "token", token } },
      };
      const { client, server } = await startGatewayWithClient({
        cfg,
        configPath: state.configPath,
        token,
        scopes: ["operator.admin"],
      });
      try {
        await server.startupSettled;
        const forAgent = <T = unknown>(
          method: Parameters<typeof client.request>[0],
          params: Record<string, unknown> = {},
        ) => client.request<T>(method, { agentId: "main", ...params });
        const requestCount = (url: string) => requests.filter((request) => request === url).length;
        const list = async (refresh = false) => {
          const started = performance.now();
          const result = await forAgent<ModelsListResult>("models.list", {
            view: "configured",
            refresh,
          });
          return {
            elapsedMs: performance.now() - started,
            ids: result.models.filter((row) => row.provider === provider).map((row) => row.id),
            result,
          };
        };
        const waitFor = (
          ready: (read: Awaited<ReturnType<typeof list>>) => boolean,
          start?: () => ReturnType<typeof list>,
        ) => waitForCatalogPublication({ signal, read: list, ready, start });
        const waitForAccount = (start?: () => ReturnType<typeof list>) =>
          waitFor(({ ids }) => ids.includes("account-exclusive"), start);
        const holdRefresh = () => {
          const held = holdNextCatalogResponse();
          const request = forAgent("models.list", { provider, refresh: true });
          void request.catch((error: unknown) => held.started.reject(error));
          return { ...held, request };
        };
        expect((await list()).ids).not.toContain("account-exclusive");
        // A configured provider can queue this refresh behind startup discovery.
        await waitFor(
          ({ result }) => {
            const { completedTasks, pendingTasks } = catalogWork.read();
            return (
              completedTasks > 0 &&
              pendingTasks === 0 &&
              !result.pendingProviders?.includes(provider)
            );
          },
          () => list(true),
        );
        await forAgent("models.authLogin", {
          sessionId: "fixture-login",
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
        const assertPassiveReads = async (stage: "early" | "final") => {
          const before = requestCount("/models");
          const reads = await Promise.all([list(), list()]);
          expect.soft(requestCount("/models")).toBe(before);
          for (const read of reads) {
            expect.soft(read.elapsedMs).toBeLessThan(1_000);
            expect
              .soft(read.ids)
              .toEqual(stage === "early" ? ["known-chat"] : ["account-exclusive"]);
            if (stage === "early") {
              expect.soft(read.result.pendingProviders).toContain(provider);
            }
          }
        };
        await withTestTimeout(
          automaticRequestStarted.promise,
          10_000,
          "Login did not start automatic catalog discovery",
        );
        await assertPassiveReads("early");
        await waitForAccount(() => {
          releaseEarlyResponse.resolve();
          return list();
        });
        await assertPassiveReads("final");
        expect(requestCount("/models")).toBe(1);
        expect(catalogWork.read()).toMatchObject({
          maxWorkers: 1,
          workersCreated: 1,
          pendingTasks: 0,
        });
        responseDelay = 0;
        const manualRefresh = await list(true);
        const session = await forAgent<{ key: string }>("sessions.create");
        await client.request("sessions.patch", {
          key: session.key,
          model: `${provider}/account-exclusive@${provider}:owner`,
        });
        const selectedRefresh = holdRefresh();
        try {
          const heldResponse = await selectedRefresh.started.promise;
          const selectedAccount = await client.request<ModelsListResult>("models.list", {
            sessionKey: session.key,
            view: "configured",
          });
          expect(selectedAccount.pendingProviders ?? []).not.toContain(provider);
          expect(heldResponse).toMatchObject({ writableEnded: false, destroyed: false });
        } finally {
          selectedRefresh.release.resolve();
          await selectedRefresh.request;
        }
        // A listing started for the signed-out account must not republish its rows.
        const staleRefresh = holdRefresh();
        const staleRefreshSettled = Promise.allSettled([staleRefresh.request]);
        void staleRefreshSettled.then(([outcome]) => staleRefresh.started.reject(outcome));
        await staleRefresh.started.promise;
        await forAgent("models.authLogout", { provider });
        const signedOut = await list();
        staleRefresh.release.resolve();
        await staleRefreshSettled;
        expect(signedOut.ids).toEqual([]);
        expect((await list()).ids).toEqual([]);
        // API-key sign-in also rewrites auth.profiles; its config reload must keep the known rows,
        // and a failed first listing must not take them away.
        listingStatus = 500;
        const apiKeyListing = holdNextCatalogResponse();
        await forAgent("models.authSetApiKey", { provider, apiKey: "fixture-access" });
        await withinTest(apiKeyListing.started.promise, signal);
        const apiKeyPending = await list();
        apiKeyListing.release.resolve();
        expect(apiKeyPending.ids).toEqual(["known-chat"]);
        const apiKeyFailed = await waitFor(
          ({ result }) =>
            result.refreshFailed === true && !result.pendingProviders?.includes(provider),
        );
        expect(apiKeyFailed.ids).toEqual(["known-chat"]);
        listingStatus = 200;
        await waitForAccount(() => list(true));
        expect(manualRefresh.ids).toContain("account-exclusive");
        expect(requestCount("/token")).toBe(1);
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
