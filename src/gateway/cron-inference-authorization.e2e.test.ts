import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { json } from "node:stream/consumers";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "../../test/helpers/openai-responses-sse.js";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { removeAuthProfilesAcrossOwnerStores } from "../agents/auth-profiles/profiles.js";
import { persistAuthProfileBatch } from "../agents/auth-profiles/upsert-with-lock.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";
import { KERNEL_TEST_ENV } from "./test-helpers.env.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

it(
  "enforces saved account authority at concurrent cron provider dispatch",
  { timeout: 180_000 },
  async ({ signal }) => {
    await withOpenClawTestState(
      {
        label: "cron-provider-authority",
        env: {
          ...KERNEL_TEST_ENV,
          VITEST: process.env.VITEST,
          OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          OPENAI_API_KEY: undefined,
        },
      },
      async (state) => {
        state.envVars.OPENCLAW_BUNDLED_PLUGINS_DIR = state.path("no-plugins");
        state.applyEnv();
        const held: ServerResponse[] = [];
        let entered = createDeferred();
        let followups = 0;
        let expectedKey = "";
        const failures: unknown[] = [];
        const finishes = new Map<
          string,
          ReturnType<typeof createDeferred<Record<string, unknown>>>
        >();
        const providerServer = await reserveTestPortListener({
          offsets: [0],
          createListener: () =>
            createServer((req, res) => {
              void (async () => {
                expect(req.method).toBe("POST");
                expect(req.url).toBe("/v1/responses");
                expect(req.headers.authorization).toBe(`Bearer ${expectedKey}`);
                const body: unknown = await json(req);
                if (!isRecord(body) || !Array.isArray(body.input)) {
                  throw new Error("Expected Responses input");
                }
                if (
                  body.input.some((item) => isRecord(item) && item.type === "function_call_output")
                ) {
                  followups++;
                  writeOpenAiResponsesText(res, {
                    text: "authorized continuation",
                    messageId: randomUUID(),
                    responseId: randomUUID(),
                  });
                } else {
                  held.push(res);
                  if (held.length === 2) {
                    entered.resolve();
                  }
                }
              })().catch((error: unknown) => {
                failures.push(error);
                res.writeHead(500).end();
                entered.reject(error);
              });
            }),
        });
        const provider = buildMockOpenAiResponsesProvider(
          `http://127.0.0.1:${providerServer.claim.port}/v1`,
          "cron-authority",
        );
        const profileId = `${provider.providerId}:saved`;
        const { apiKey: _configuredKey, ...providerConfig } = provider.config;
        const token = "synthetic-cron-gateway-token";
        const cfg: OpenClawConfig = {
          agents: {
            defaults: {
              workspace: state.workspaceDir,
              skipBootstrap: true,
              model: provider.modelRef,
              models: {
                [provider.modelRef]: {
                  agentRuntime: { id: "openclaw" },
                  params: { transport: "sse", openaiWsWarmup: false },
                },
              },
            },
          },
          gateway: { auth: { mode: "token", token } },
          models: { mode: "replace", providers: { [provider.providerId]: providerConfig } },
          auth: { profiles: { [profileId]: { provider: provider.providerId, mode: "api_key" } } },
          plugins: { slots: { memory: "none" } },
          tools: { allow: ["read"] },
          cron: { enabled: false },
        };
        const seed = async (key: string) =>
          persistAuthProfileBatch({
            profiles: [
              { profileId, credential: { type: "api_key", provider: provider.providerId, key } },
            ],
          });
        expectedKey = "synthetic-original-key";
        await seed(expectedKey);
        const proofPath = state.path("proof.txt");
        await writeFile(proofPath, "Synthetic authorized read.");
        let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
        await runQaGatewayFixture(
          async () => {
            gateway = await startGatewayWithClient({
              cfg,
              configPath: state.configPath,
              token,
              scopes: ["operator.admin"],
              onEvent(event) {
                if (
                  event.event === "cron" &&
                  isRecord(event.payload) &&
                  event.payload.action === "finished" &&
                  typeof event.payload.jobId === "string"
                ) {
                  finishes.get(event.payload.jobId)?.resolve(event.payload);
                }
              },
            });
            await gateway.server.startupSettled;
            for (const scenario of ["unchanged", "replacement", "revocation"] as const) {
              held.length = 0;
              entered = createDeferred();
              followups = 0;
              expectedKey = `synthetic-${scenario}-key`;
              await seed(expectedKey);
              const jobs: string[] = [];
              for (const index of [0, 1]) {
                const job = await gateway.client.request<{ id: string }>("cron.add", {
                  name: `${scenario}-${index}`,
                  agentId: "main",
                  enabled: true,
                  schedule: { kind: "every", everyMs: 86_400_000 },
                  sessionTarget: "isolated",
                  wakeMode: "now",
                  delivery: { mode: "none" },
                  payload: {
                    kind: "agentTurn",
                    message: `Read ${proofPath}, then reply.`,
                    model: `${provider.modelRef}@${profileId}`,
                    lightContext: true,
                    toolsAllow: ["read"],
                  },
                });
                jobs.push(job.id);
                finishes.set(job.id, createDeferred<Record<string, unknown>>());
              }
              const terminalEvents = jobs.map((id) => finishes.get(id)!.promise);
              const completed = Promise.all(terminalEvents);
              await Promise.all(
                jobs.map((id) => gateway!.client.request("cron.run", { id, mode: "force" })),
              );
              await withinTest(
                Promise.race([
                  entered.promise,
                  Promise.race(terminalEvents).then((result) => {
                    throw new Error(
                      `Runs finished before concurrent provider dispatch: ${JSON.stringify(result)}`,
                    );
                  }),
                ]),
                signal,
              );
              // Both runs retain authority while their first provider responses are held.
              // A native write must stop the tool continuation before another HTTP request.
              if (scenario === "replacement") {
                await seed("synthetic-replacement-key");
              }
              if (scenario === "revocation") {
                expect(await removeAuthProfilesAcrossOwnerStores({ profileIds: [profileId] })).toBe(
                  true,
                );
              }
              for (const response of held) {
                const item = {
                  id: randomUUID(),
                  type: "function_call",
                  call_id: randomUUID(),
                  name: "read",
                  arguments: JSON.stringify({ path: proofPath }),
                  status: "completed",
                };
                writeOpenAiResponsesSse(response, [
                  {
                    type: "response.output_item.added",
                    output_index: 0,
                    item: { ...item, arguments: "" },
                  },
                  {
                    type: "response.function_call_arguments.delta",
                    item_id: item.id,
                    output_index: 0,
                    delta: item.arguments,
                  },
                  { type: "response.output_item.done", output_index: 0, item },
                  {
                    type: "response.completed",
                    response: {
                      id: randomUUID(),
                      status: "completed",
                      output: [item],
                      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
                    },
                  },
                ]);
              }
              const terminals = await withinTest(completed, signal);
              expect(failures).toEqual([]);
              expect(held).toHaveLength(2);
              expect(followups).toBe(scenario === "unchanged" ? 2 : 0);
              for (const terminal of terminals) {
                expect(terminal.status, JSON.stringify(terminal)).toBe(
                  scenario === "unchanged" ? "ok" : "error",
                );
                if (scenario !== "unchanged") {
                  expect(terminal.error).toContain("authorization was disconnected or replaced");
                }
              }
              console.log(
                "PROVIDER_AUTH_PROOF",
                JSON.stringify({
                  scenario,
                  initialRequests: held.length,
                  followupRequests: followups,
                  statuses: terminals.map((t) => t.status),
                  errors: terminals.map((t) => t.error ?? null),
                }),
              );
            }
          },
          () => {
            for (const response of held) {
              if (!response.writableEnded) {
                response.end();
              }
            }
          },
          () => gateway && disconnectGatewayClient(gateway.client),
          () => gateway?.server.close({ reason: "cron authorization proof complete" }),
          async () => {
            providerServer.listener.closeAllConnections();
            await providerServer.releaseListener();
          },
          () => providerServer.claim.release(),
        );
      },
    );
  },
);
