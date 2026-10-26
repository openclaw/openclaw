import fs from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import { writeOpenAiResponsesText } from "../../../test/helpers/openai-responses-sse.js";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../../config/config.js";
import { clearSessionStoreCacheForTest } from "../../config/sessions/store-writer-state.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { closeProvider, listenProvider } from "../gateway-provider-fixture.test-support.js";
import { disconnectGatewayClient, startGatewayWithClient } from "../test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "../test-openai-responses-model.js";

// Real Gateway/RPC, scheduler, model transport and command process owners. This
// staging proof complements the exec-notification producer regression; it does
// not claim to exercise a delayed background-exec notification through a model.
it(
  "contains isolated cron timeouts and executes command-only maintenance without inference",
  { timeout: 90_000 },
  async ({ signal }) => {
    await withOpenClawTestState(
      {
        label: "cron-containment-gateway",
        env: {
          OPENCLAW_TEST_FAST: "0",
          OPENCLAW_SKIP_CHANNELS: "1",
          OPENCLAW_SKIP_GMAIL_WATCHER: "1",
          OPENCLAW_SKIP_CRON: undefined,
          OPENCLAW_SKIP_CANVAS_HOST: "1",
          OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
          OPENCLAW_SKIP_PROVIDERS: "1",
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        },
      },
      async (state) => {
        const requests: string[] = [];
        const transportClosed = createDeferred();
        let heldResponse: ServerResponse | undefined;
        const providerServer = createServer((request, response) => {
          void (async () => {
            const chunks: Buffer[] = [];
            for await (const chunk of request) {
              chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            }
            const body = Buffer.concat(chunks).toString("utf8");
            requests.push(body);
            if (body.includes("BLOCK_CRON_MODEL")) {
              heldResponse = response;
              response.once("close", () => transportClosed.resolve());
              return;
            }
            writeOpenAiResponsesText(response, {
              text: "INTERACTIVE_OK",
              messageId: `message-${requests.length}`,
              responseId: `response-${requests.length}`,
            });
          })().catch((error: unknown) =>
            response.destroy(error instanceof Error ? error : undefined),
          );
        });
        let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
        try {
          await fs.mkdir(state.workspaceDir, { recursive: true });
          const providerUrl = await listenProvider(providerServer);
          const provider = buildMockOpenAiResponsesProvider(providerUrl);
          gateway = await startGatewayWithClient({
            configPath: state.configPath,
            token: "synthetic-cron-proof-token",
            cfg: {
              cron: { enabled: true },
              plugins: { allow: [], slots: { memory: "none" } },
              agents: {
                defaults: {
                  workspace: state.workspaceDir,
                  skipBootstrap: true,
                  model: { primary: provider.modelRef },
                  models: {
                    [provider.modelRef]: { params: { transport: "sse", openaiWsWarmup: false } },
                  },
                },
                entries: { main: {} },
              },
              models: { mode: "replace", providers: { [provider.providerId]: provider.config } },
              gateway: { auth: { mode: "token", token: "synthetic-cron-proof-token" } },
            },
          });
          const client = gateway.client;
          const priorSession = "agent:main:prior-cron-delivery-conversation";
          async function interactive(message: string) {
            const started = await client.request<{ runId?: string }>("chat.send", {
              sessionKey: priorSession,
              message,
              deliver: false,
              idempotencyKey: message,
            });
            expect(started.runId).toBeTruthy();
            const ended = await client.request<{ status?: string }>(
              "agent.wait",
              {
                runId: started.runId,
                timeoutMs: 20_000,
              },
              { timeoutMs: 25_000 },
            );
            expect(ended.status).toBe("ok");
          }
          await interactive("PRIVATE_PRIOR_CONTEXT");
          expect(requests).toHaveLength(1);
          const future = Date.now() + 24 * 60 * 60_000;
          const schedule = { kind: "every", everyMs: 24 * 60 * 60_000, anchorMs: future };
          async function add(name: string, payload: Record<string, unknown>, sessionKey?: string) {
            const raw = await client.request("cron.add", {
              name,
              agentId: "main",
              enabled: true,
              schedule,
              sessionTarget: "isolated",
              ...(sessionKey ? { sessionKey } : {}),
              wakeMode: "now",
              delivery: { mode: "none" },
              failureAlert: false,
              payload,
            });
            const job = asOptionalRecord(raw.job) ?? raw;
            if (typeof job.id !== "string") {
              throw new Error("cron.add did not publish its job identity");
            }
            return job.id;
          }
          async function run(id: string) {
            const outcome = await client.request<{ run?: Record<string, unknown> }>(
              "cron.run",
              {
                id,
                mode: "force",
                waitTimeoutMs: 20_000,
              },
              { timeoutMs: 25_000 },
            );
            expect(outcome.run).toBeDefined();
            return outcome.run!;
          }
          const modelJob = await add(
            "bounded-model-review",
            {
              kind: "agentTurn",
              message: "BLOCK_CRON_MODEL",
              toolsAllow: [],
              lightContext: true,
              timeoutSeconds: 2,
            },
            priorSession,
          );
          const timedOut = await run(modelJob);
          expect(timedOut.status).toBe("error");
          expect(timedOut.error).toContain("timed out");
          expect(heldResponse).toBeDefined();
          await withinTest(transportClosed.promise, signal);
          expect(requests).toHaveLength(2);
          expect(requests[1]).not.toContain("PRIVATE_PRIOR_CONTEXT");
          const afterModel = await client.request("cron.get", {
            id: modelJob,
          });
          expect(Number(afterModel.nextRunAtMs)).toBeGreaterThan(Date.now() + 60 * 60_000);
          const marker = path.join(state.root, "command-invocations.txt");
          const commandJob = await add("deterministic-maintenance", {
            kind: "command",
            argv: [
              process.execPath,
              "-e",
              `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'success\\n'); console.log('COMMAND_REPORT_OK')`,
            ],
            timeoutSeconds: 5,
          });
          const completed = await run(commandJob);
          expect(completed.status).toBe("ok");
          expect(completed.summary).toContain("COMMAND_REPORT_OK");
          expect(await fs.readFile(marker, "utf8")).toBe("success\n");
          expect(requests).toHaveLength(2);
          const commandTimeoutJob = await add("partial-command-timeout", {
            kind: "command",
            argv: [
              process.execPath,
              "-e",
              `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'partial\\n'); setInterval(() => {}, 1000)`,
            ],
            timeoutSeconds: 1,
          });
          expect((await run(commandTimeoutJob)).status).toBe("error");
          const afterCommand = await client.request("cron.get", {
            id: commandTimeoutJob,
          });
          expect(Number(afterCommand.nextRunAtMs)).toBeGreaterThan(Date.now() + 60 * 60_000);
          expect(await fs.readFile(marker, "utf8")).toBe("success\npartial\n");
          expect(requests).toHaveLength(2);
          await interactive("INTERACTIVE_AFTER_CRON_TIMEOUT");
          expect(requests).toHaveLength(3);
        } finally {
          heldResponse?.destroy();
          if (gateway) {
            await disconnectGatewayClient(gateway.client).catch(() => undefined);
            await gateway.server.close();
          }
          if (providerServer.listening) {
            await closeProvider(providerServer);
          }
          clearRuntimeConfigSnapshot();
          clearConfigCache();
          clearSessionStoreCacheForTest();
        }
      },
    );
  },
);
