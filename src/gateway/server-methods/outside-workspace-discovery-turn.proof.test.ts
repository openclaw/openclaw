import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { expect, it, type TestContext } from "vitest";
import type { ModelsListResult } from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import { runQaGatewayTestFixture } from "../../../test/helpers/qa-gateway-test-lifetime.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { disconnectGatewayClient, startGatewayWithClient } from "../test-helpers.e2e.js";
import { waitForCatalogPublication } from "./models-auth-catalog.test-support.js";

const PROVIDER = "proof-discovery";
const STATIC_PROVIDER = "proof-static";
const DISCOVERED_ID = "discovered-only";
const STATIC_ID = "static-marker";
const REPLY = "DISCOVERY_TURN_ANSWER";

function responsesStream(text: string): string {
  const message = {
    type: "message",
    id: "proof-discovery-reply",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  return [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...message, status: "in_progress", content: [] },
    },
    { type: "response.output_item.done", output_index: 0, item: message },
    {
      type: "response.completed",
      response: {
        status: "completed",
        usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 },
      },
    },
  ]
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .concat("data: [DONE]\n\n")
    .join("");
}

it(
  "answers a picker-listed discovery model from an outside-folder Gateway session",
  { timeout: 120_000 },
  (context: TestContext) => {
    let state: Awaited<ReturnType<typeof createOpenClawTestState>> | undefined;
    let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
    const providerRequests: string[] = [];
    const endpoint = createServer((request, response) => {
      providerRequests.push(`${request.method ?? "GET"} ${request.url ?? "/"}`);
      if (request.method === "GET") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify([DISCOVERED_ID]));
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(responsesStream(REPLY));
    });
    return runQaGatewayTestFixture(
      context,
      async ({ signal }) => {
        state = await createOpenClawTestState({
          label: "outside-discovery-turn",
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
        const outside = path.join(path.dirname(state.workspaceDir), "outside-folder");
        await fs.mkdir(outside, { recursive: true });
        endpoint.listen(0, "127.0.0.1");
        await once(endpoint, "listening");
        const address = endpoint.address();
        if (!address || typeof address === "string") {
          throw new Error("proof provider did not bind a loopback port");
        }
        const baseUrl = `http://127.0.0.1:${address.port}/v1`;
        await state.writeJson("catalog-plugin/openclaw.plugin.json", {
          id: PROVIDER,
          providers: [PROVIDER],
          configSchema: { type: "object", additionalProperties: false },
        });
        const pluginPath = await state.writeText(
          "catalog-plugin/index.cjs",
          `module.exports = {
            id: ${JSON.stringify(PROVIDER)},
            register(api) {
              api.registerProvider({
                id: ${JSON.stringify(PROVIDER)},
                label: "Proof discovery",
                auth: [],
                catalog: {
                  order: "profile",
                  async run(ctx) {
                    if (!ctx.resolveProviderAuth(${JSON.stringify(PROVIDER)}).discoveryApiKey) return null;
                    const response = await fetch(${JSON.stringify(`${baseUrl}/catalog`)});
                    const rows = await response.json();
                    return { providers: { ${JSON.stringify(PROVIDER)}: {
                      baseUrl: ${JSON.stringify(baseUrl)},
                      api: "openai-responses",
                      models: rows.map((id) => ({
                        id, name: id, api: "openai-responses", reasoning: false, input: ["text"],
                        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                        contextWindow: 8192, maxTokens: 1024,
                      })),
                    } } };
                  },
                },
              });
            },
          };`,
        );
        const token = "outside-discovery-token";
        const discoveredRef = `${PROVIDER}/${DISCOVERED_ID}`;
        const staticRef = `${STATIC_PROVIDER}/${STATIC_ID}`;
        const transport = { params: { transport: "sse", openaiWsWarmup: false } };
        const markerModel = {
          id: STATIC_ID,
          name: "Static marker",
          api: "openai-responses" as const,
          reasoning: false,
          input: ["text" as const],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8192,
          maxTokens: 1024,
        };
        const cfg = {
          agents: {
            defaults: {
              workspace: state.workspaceDir,
              skipBootstrap: true,
              model: { primary: staticRef },
              models: {
                [staticRef]: transport,
                [discoveredRef]: transport,
              },
            },
            entries: { main: { workspace: state.workspaceDir } },
          },
          models: {
            catalogRefresh: { enabled: false },
            providers: {
              [STATIC_PROVIDER]: {
                baseUrl,
                api: "openai-responses" as const,
                apiKey: "proof",
                models: [markerModel],
              },
            },
          },
          plugins: {
            enabled: true,
            allow: [PROVIDER],
            entries: { [PROVIDER]: { enabled: true } },
            load: { paths: [pluginPath] },
            slots: { memory: "none" },
          },
          gateway: { mode: "local" as const, auth: { mode: "token" as const, token } },
        };
        await state.writeConfig(cfg);
        await state.writeAuthProfiles({
          version: 1,
          profiles: {
            [`${PROVIDER}:default`]: {
              type: "api_key",
              provider: PROVIDER,
              key: "proof-account-key",
            },
          },
        });
        const replies: string[] = [];
        gateway = await startGatewayWithClient({
          cfg,
          configPath: state.configPath,
          token,
          scopes: ["operator.admin"],
          onEvent: (event) => {
            const payload = JSON.stringify(event.payload ?? {});
            if (event.event === "chat" && payload.includes(REPLY)) {
              replies.push(payload);
            }
          },
        });
        await gateway.server.startupSettled;
        signal.throwIfAborted();
        const readModels = (refresh = false) =>
          gateway!.client.request<ModelsListResult>(
            "models.list",
            { agentId: "main", refresh },
            { signal },
          );
        const listed = await waitForCatalogPublication({
          signal,
          start: () => readModels(true),
          read: () => readModels(false),
          ready: (result) =>
            result.models.some((row) => row.provider === PROVIDER && row.id === DISCOVERED_ID) &&
            !result.pendingProviders?.includes(PROVIDER),
        });
        expect(listed.models).toContainEqual(
          expect.objectContaining({ provider: PROVIDER, id: DISCOVERED_ID }),
        );
        const published = await gateway.client.request<{
          config: { models: { providers: Record<string, { models: Array<{ id: string }> }> } };
        }>("config.get", {}, { signal });
        expect(published.config.models.providers[PROVIDER]).toBeUndefined();
        expect(
          published.config.models.providers[STATIC_PROVIDER]?.models.map((row) => row.id),
        ).toEqual([STATIC_ID]);

        const turn = async (label: string, cwd: string) => {
          const created = await gateway!.client.request<{
            key?: string;
            entry?: { spawnedCwd?: string };
          }>("sessions.create", {
            agentId: "main",
            key: `agent:main:${label}`,
            cwd,
            model: discoveredRef,
            idempotencyKey: `${label}-create`,
          });
          expect(created.entry?.spawnedCwd, `${label} cwd`).toBe(cwd);
          const started = await gateway!.client.request<{ runId?: string; status?: string }>(
            "chat.send",
            {
              sessionKey: created.key,
              message: `Answer with ${REPLY}`,
              deliver: false,
              idempotencyKey: `${label}-send`,
            },
          );
          expect(started.status, `${label} start`).toBe("started");
          const finished = await gateway!.client.request<{ status?: string }>(
            "agent.wait",
            { runId: started.runId, timeoutMs: 60_000 },
            { timeoutMs: 70_000 },
          );
          expect(finished.status, `${label} wait ${JSON.stringify(finished)}`).toBe("ok");
          console.info(
            `${label} Gateway turn answered ${discoveredRef} cwd=${created.entry?.spawnedCwd} reply=${REPLY}`,
          );
          return { cwd: created.entry?.spawnedCwd, status: finished.status };
        };

        const outsideTurn = await turn("outside-folder", outside);
        const workspaceTurn = await turn("workspace-session", state.workspaceDir);
        expect(replies.length).toBeGreaterThanOrEqual(2);
        console.info(
          `DISCOVERY_TURN_VERDICT ${JSON.stringify({
            model: discoveredRef,
            pickerListed: true,
            staticConfigModels: [STATIC_ID],
            outsideCwd: outsideTurn.cwd,
            workspaceCwd: workspaceTurn.cwd,
            reply: REPLY,
            endpoint: "127.0.0.1",
            providerRequests,
          })}`,
        );
      },
      async () => {
        if (gateway) {
          await disconnectGatewayClient(gateway.client);
        }
      },
      async () => {
        await gateway?.server.close({ reason: "outside discovery proof complete" });
      },
      async () => {
        endpoint.closeAllConnections();
        if (endpoint.listening) {
          await new Promise<void>((resolve, reject) => {
            endpoint.close((error) => (error ? reject(error) : resolve()));
          });
        }
      },
      async () => {
        await state?.cleanup();
      },
    );
  },
);
