import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { expect, it } from "vitest";
import { readRequestText, respondJson } from "../../test/helpers/gateway-integration-fixtures.js";
import {
  loadAuthProfileStoreWithoutExternalProfilesAsync,
  saveAuthProfileStore,
} from "../agents/auth-profiles/store-runtime.js";
import { readAuthProfileUsageStats } from "../agents/auth-profiles/usage-state.js";
import { closeProvider, listenProvider } from "./gateway-provider-fixture.test-support.js";
import { createStartupTestState } from "./server-startup.test-support.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";

const failedModel = "gemini-4-argon";
const siblingModel = "deepseek-v4.1-flash";
const profileId = "opencode-go:default";
const model = (id: string) => ({
  id,
  name: id,
  reasoning: false,
  input: ["text"],
  contextWindow: 128_000,
  maxTokens: 256,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
});

it(
  "keeps a shared OpenCode Go profile usable across Gateway fallback and a later sibling turn",
  { timeout: 120_000 },
  async () => {
    await using state = await createStartupTestState("opencode-go-endpoint-unavailable", {
      OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
      OPENCLAW_SKIP_PROVIDERS: undefined,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "0",
      OPENCLAW_BUNDLED_PLUGINS_DIR: path.resolve("dist/extensions"),
    });
    state.applyEnv();
    for (const agentId of ["main", "sibling"]) {
      const agentDir = state.agentDir(agentId);
      await fs.mkdir(agentDir, { recursive: true });
      await fs.writeFile(
        path.join(agentDir, "settings.json"),
        JSON.stringify({ retry: { provider: { maxRetries: 1 } } }),
      );
    }
    saveAuthProfileStore({
      version: 1,
      profiles: { [profileId]: { type: "api_key", provider: "opencode-go", key: "synthetic-key" } },
    });
    const requestedModels: string[] = [];
    const authorizations: Array<string | undefined> = [];
    const fixtureErrors: unknown[] = [];
    const fallbackReasons: string[] = [];
    const provider = createServer((request, response) => {
      void (async () => {
        if (request.method === "GET" && request.url === "/v1/models") {
          respondJson(response, { data: [{ id: failedModel }, { id: siblingModel }] });
          return;
        }
        expect(request.method).toBe("POST");
        expect(request.url).toBe("/v1/chat/completions");
        const body = JSON.parse(await readRequestText(request)) as { model: string };
        requestedModels.push(body.model);
        authorizations.push(request.headers.authorization);
        if (body.model === failedModel) {
          respondJson(
            response,
            {
              error: {
                code: 403,
                status: "UNKNOWN",
                message: "Upstream request failed: Endpoint is unavailable.",
              },
            },
            403,
          );
          return;
        }
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          'data: {"choices":[{"index":0,"delta":{"content":"healthy"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        );
      })().catch((error: unknown) => {
        fixtureErrors.push(error);
        response.destroy(error instanceof Error ? error : new Error(String(error)));
      });
    });
    let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
    try {
      const baseUrl = await listenProvider(provider);
      const token = "opencode-go-gateway-proof";
      gateway = await startGatewayWithClient({
        cfg: {
          agents: {
            ownership: "explicit",
            defaults: { workspace: state.workspaceDir, skipBootstrap: true },
            entries: {
              main: {
                model: {
                  primary: `opencode-go/${failedModel}`,
                  fallbacks: [`opencode-go/${siblingModel}`],
                },
              },
              sibling: { model: { primary: `opencode-go/${siblingModel}` } },
            },
          },
          models: {
            mode: "replace",
            providers: {
              "opencode-go": {
                baseUrl,
                api: "openai-completions",
                models: [model(failedModel), model(siblingModel)],
              },
            },
          },
          plugins: {
            allow: ["opencode-go"],
            entries: { "opencode-go": { enabled: true } },
            slots: { memory: "none" },
          },
          gateway: { auth: { mode: "token", token } },
        },
        configPath: state.configPath,
        token,
        onEvent: (event) => {
          if (event.event !== "agent") {
            return;
          }
          const data = (
            event.payload as
              | { data?: { phase?: string; attempts?: Array<{ reason?: string }> } }
              | undefined
          )?.data;
          if (data?.phase === "fallback") {
            fallbackReasons.push(
              ...(data.attempts ?? []).flatMap((attempt) =>
                attempt.reason ? [attempt.reason] : [],
              ),
            );
          }
        },
      });
      await gateway.server.startupSettled;
      const run = async (sessionKey: string, idempotencyKey: string) => {
        const started = await gateway!.client.request<{ runId: string }>("chat.send", {
          sessionKey,
          message: "Reply with healthy.",
          deliver: false,
          idempotencyKey,
        });
        return await gateway!.client.request<{ status: string; terminalReply?: { text?: string } }>(
          "agent.wait",
          { runId: started.runId, timeoutMs: 60_000 },
          { timeoutMs: 65_000 },
        );
      };
      expect(await run("agent:main:outage", "outage")).toMatchObject({
        status: "ok",
        terminalReply: { text: "healthy" },
      });
      expect(requestedModels).toContain(failedModel);
      expect(requestedModels).toContain(siblingModel);
      expect(fallbackReasons).toContain("server_error");
      expect(authorizations[0]).toBe("Bearer synthetic-key");
      const store = await loadAuthProfileStoreWithoutExternalProfilesAsync();
      const health = readAuthProfileUsageStats(store, profileId);
      expect(health?.cooldownUntil).toBeUndefined();
      expect(health?.disabledUntil).toBeUndefined();
      expect(health?.failureCounts?.auth).toBeUndefined();
      const afterFallback = requestedModels.length;
      expect(await run("agent:sibling:later", "later")).toMatchObject({
        status: "ok",
        terminalReply: { text: "healthy" },
      });
      expect(requestedModels.slice(afterFallback)).toEqual([siblingModel]);
      expect(authorizations.at(-1)).toBe("Bearer synthetic-key");
      expect(fixtureErrors).toEqual([]);
    } finally {
      try {
        if (gateway) {
          await disconnectGatewayClient(gateway.client);
          await gateway.server.close();
        }
      } finally {
        await closeProvider(provider);
      }
    }
  },
);
