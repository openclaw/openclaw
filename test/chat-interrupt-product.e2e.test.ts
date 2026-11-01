import { randomUUID, X509Certificate } from "node:crypto";
import { createServer } from "node:http";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import type { GatewayClient } from "../src/gateway/client.js";
import {
  startGatewayWithClient,
  disconnectGatewayClient,
} from "../src/gateway/test-helpers.e2e.js";
import { kernelGatewayTestStateOptions } from "../src/gateway/test-helpers.env.js";
import { withEnvAsync } from "../src/test-utils/env.js";
import { createOpenClawTestState } from "../src/test-utils/openclaw-test-state.js";
import {
  closeHttpServer,
  listenLoopback,
  readRequestText,
} from "./helpers/gateway-integration-fixtures.js";
import { writeOpenAiResponsesText } from "./helpers/openai-responses-sse.js";
import { createDeferred, withinTest } from "./helpers/promise.js";
import { TEST_TLS_CERT_PEM, TEST_TLS_KEY_PEM } from "./helpers/tls-fixture.js";

async function withAuthenticatedGateway(
  options: {
    name: string;
    signal: AbortSignal;
    env: Record<string, string | undefined>;
    config: OpenClawConfig;
  },
  body: (client: GatewayClient, terminals: Map<string, unknown>) => Promise<void>,
  connection: Pick<Parameters<typeof startGatewayWithClient>[0], "origin" | "edgeAuthHeaders">,
) {
  const state = await createOpenClawTestState(kernelGatewayTestStateOptions(options.name));
  let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
  const terminals = new Map<string, unknown>();
  try {
    const certPath = await state.writeText("tls/cert.pem", TEST_TLS_CERT_PEM);
    const keyPath = await state.writeText("tls/key.pem", TEST_TLS_KEY_PEM);
    const cfg: OpenClawConfig = {
      ...options.config,
      agents: {
        ...options.config.agents,
        defaults: { ...options.config.agents?.defaults, workspace: state.workspaceDir },
      },
      gateway: {
        ...options.config.gateway,
        tls: { enabled: true, autoGenerate: false, certPath, keyPath },
      },
    };
    await withEnvAsync({ ...options.env, OPENCLAW_GATEWAY_TOKEN: undefined }, async () => {
      gateway = await startGatewayWithClient({
        cfg,
        configPath: state.configPath,
        auth: cfg.gateway?.auth,
        ...connection,
        secure: true,
        clientName: "openclaw-control-ui",
        mode: "webchat",
        tlsFingerprint: new X509Certificate(TEST_TLS_CERT_PEM).fingerprint256,
        scopes: ["operator.read", "operator.write"],
        onEvent: ({ event, payload }) => {
          if (
            event === "chat" &&
            isRecord(payload) &&
            typeof payload.runId === "string" &&
            ["final", "error", "aborted"].includes(String(payload.state))
          ) {
            terminals.set(payload.runId, payload);
          }
        },
      });
      await gateway.server.startupSettled;
      await withinTest(body(gateway.client, terminals), options.signal);
    });
  } finally {
    if (gateway) {
      await disconnectGatewayClient(gateway.client);
      await gateway.server.close();
    }
    await state.cleanup();
  }
}

it.for(["rpc", "command"])(
  "interrupts original queued input using %s through an actual Gateway/runtime",
  async (control, { signal }) => {
    const activeStarted = createDeferred();
    const activeCancelled = createDeferred();
    let activeClosed = false;
    const submitted: string[] = [];
    const server = createServer((request, response) => {
      void (async () => {
        const body = JSON.parse(await readRequestText(request));
        const text = JSON.stringify(body.input ?? body.messages ?? "");
        const markers = [
          "ACTIVE_INTERRUPT_PROOF",
          "OLDER_INTERRUPT_PROOF",
          "SELECTED_INTERRUPT_PROOF",
          "LATER_INTERRUPT_PROOF",
        ];
        const marker =
          body.stream === false
            ? undefined
            : markers
                .filter((value) => text.includes(value))
                .toSorted((a, b) => text.lastIndexOf(b) - text.lastIndexOf(a))[0];
        if (!marker) {
          writeOpenAiResponsesText(response, {
            text: "Synthetic auxiliary response",
            messageId: randomUUID(),
            responseId: randomUUID(),
          });
          return;
        }
        submitted.push(marker);
        if (marker === "ACTIVE_INTERRUPT_PROOF") {
          response.writeHead(200, { "content-type": "text/event-stream" });
          const events = [
            {
              type: "response.created",
              response: { id: "held-active", status: "in_progress", output: [] },
            },
            {
              type: "response.output_item.added",
              output_index: 0,
              item: {
                type: "message",
                id: "held-message",
                role: "assistant",
                status: "in_progress",
                content: [],
              },
            },
            {
              type: "response.output_text.delta",
              item_id: "held-message",
              output_index: 0,
              content_index: 0,
              delta: "Working on the original request.",
            },
          ];
          for (const event of events) {
            response.write("data: " + JSON.stringify(event) + "\n\n");
          }
          response.on("close", () => {
            activeClosed = true;
            activeCancelled.resolve();
          });
          activeStarted.resolve();
          return;
        }
        writeOpenAiResponsesText(response, {
          text: "Completed " + marker,
          messageId: randomUUID(),
          responseId: randomUUID(),
        });
      })().catch((error: unknown) => response.writeHead(500).end(String(error)));
    });
    const url = await listenLoopback(server);
    try {
      await withAuthenticatedGateway(
        {
          name: "chat-interrupt-product",
          signal,
          env: {
            OPENCLAW_SKIP_PROVIDERS: undefined,
            OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
            OPENCLAW_AGENT_HARNESS_FALLBACK: "none",
          },
          config: {
            gateway: {
              trustedProxies: ["127.0.0.1", "::1"],
              auth: {
                mode: "trusted-proxy",
                token: undefined,
                identityScopes: { "interrupt@example.test": ["operator.admin"] },
                trustedProxy: {
                  userHeader: "x-forwarded-user",
                  requiredHeaders: ["x-forwarded-proto"],
                  allowLoopback: true,
                  deviceAutoApprove: { enabled: true, scopes: ["operator.read", "operator.write"] },
                },
              },
              controlUi: { enabled: false, allowedOrigins: ["https://control.example.test"] },
            },
            agents: {
              defaults: {
                model: { primary: "openai/gpt-4.1", fallbacks: [] },
                utilityModel: "",
                skipBootstrap: true,
                sandbox: { mode: "off" },
              },
            },
            models: {
              mode: "replace",
              providers: {
                openai: {
                  baseUrl: url + "/v1",
                  api: "openai-responses",
                  apiKey: "synthetic-interrupt-fixture-key",
                  request: { allowPrivateNetwork: true },
                  models: [
                    {
                      id: "gpt-4.1",
                      name: "Synthetic interrupt fixture",
                      reasoning: false,
                      input: ["text"],
                      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                      contextWindow: 128000,
                      maxTokens: 512,
                    },
                  ],
                },
              },
            },
            plugins: {
              allow: ["openai", "codex"],
              slots: { memory: "none" },
              entries: { openai: { enabled: true }, codex: { enabled: true } },
            },
            tools: { deny: ["*"] },
          },
        },
        async (client, terminals) => {
          const sessionKey = "agent:main:interrupt-product-" + randomUUID();
          const send = (message: string, id: string, queueMode?: string) =>
            client.request<{ runId: string }>("chat.send", {
              sessionKey,
              message,
              queueMode,
              idempotencyKey: id,
              deliver: false,
            });
          await client.request("sessions.create", {
            key: sessionKey,
            agentId: "main",
            idempotencyKey: "create-" + randomUUID(),
          });
          const catalog = await client.request("commands.list", { sessionKey });
          expect(JSON.stringify(catalog)).toContain("followupmode");
          expect(JSON.stringify(catalog)).toContain("interrupt");
          const preferenceRun = await send("/followupmode queue", "preference-" + randomUUID());
          const preferenceResult = await client.request("agent.wait", {
            runId: preferenceRun.runId,
            timeoutMs: 15000,
          });
          expect(preferenceResult).toMatchObject({ status: "ok" });
          const preferences = await client.request("users.prefs.get", {
            keys: ["chat.followUpMode"],
          });
          expect(JSON.stringify(preferences)).toContain('"chat.followUpMode":"queue"');
          const active = await send("ACTIVE_INTERRUPT_PROOF", "active-" + randomUUID());
          await Promise.race([
            activeStarted.promise,
            client
              .request(
                "agent.wait",
                { runId: active.runId, timeoutMs: 15000 },
                { timeoutMs: 20000 },
              )
              .then((result) => {
                throw new Error("Active model did not reach fixture: " + JSON.stringify(result));
              }),
          ]);
          const ids = ["older-", "selected-", "later-"].map((prefix) => prefix + randomUUID());
          for (const [index, marker] of [
            "OLDER_INTERRUPT_PROOF",
            "SELECTED_INTERRUPT_PROOF",
            "LATER_INTERRUPT_PROOF",
          ].entries()) {
            await send(marker, ids[index]!);
          }
          const history = await client.request<{ sessionId: string }>("chat.history", {
            sessionKey,
            limit: 20,
          });
          if (control === "rpc") {
            expect(
              await client.request("chat.interrupt", {
                sessionKey,
                sessionId: history.sessionId,
                runId: ids[1],
              }),
            ).toMatchObject({ status: "queued", runId: ids[1], cancellationRequested: true });
          } else {
            const modeChange = await send("/followupmode interrupt", "mode-change-" + randomUUID());
            await client.request("agent.wait", { runId: modeChange.runId, timeoutMs: 15000 });
            expect(
              JSON.stringify(
                await client.request("users.prefs.get", { keys: ["chat.followUpMode"] }),
              ),
            ).toContain('"chat.followUpMode":"interrupt"');
            expect(activeClosed).toBe(false);
            const listing = await send("/interrupt list", "listing-" + randomUUID());
            const list = await client.request("agent.wait", {
              runId: listing.runId,
              timeoutMs: 15000,
            });
            expect(list).toMatchObject({ status: "ok" });
            await expect
              .poll(() => JSON.stringify(terminals.get(listing.runId)), { timeout: 10000 })
              .toContain(ids[1]);
            expect(activeClosed).toBe(false);
            const command = await send("/interrupt " + ids[1], "control-" + randomUUID());
            const result = await client.request("agent.wait", {
              runId: command.runId,
              timeoutMs: 15000,
            });
            expect(result).toMatchObject({ status: "ok" });
            await expect
              .poll(() => JSON.stringify(terminals.get(command.runId)), { timeout: 10000 })
              .toContain("Interrupt & send requested");
          }
          await activeCancelled.promise;
          for (const runId of [active.runId, ids[1], ids[0], ids[2]]) {
            await client.request("agent.wait", { runId, timeoutMs: 30000 }, { timeoutMs: 35000 });
          }
          await expect
            .poll(() => submitted, { timeout: 30000 })
            .toEqual([
              "ACTIVE_INTERRUPT_PROOF",
              "SELECTED_INTERRUPT_PROOF",
              "OLDER_INTERRUPT_PROOF",
              "LATER_INTERRUPT_PROOF",
            ]);
          const description = await client.request<{ session: { agentRuntime?: { id: string } } }>(
            "sessions.describe",
            { key: sessionKey },
          );
          expect(description.session.agentRuntime?.id).toBe("openclaw");
          const final = await client.request("chat.history", { sessionKey, limit: 40 });
          expect(JSON.stringify(final)).toContain("Completed SELECTED_INTERRUPT_PROOF");
          expect(
            await client.request("chat.interrupt", {
              sessionKey,
              sessionId: history.sessionId,
              runId: ids[1],
            }),
          ).toMatchObject({ status: "not_queued", cancellationRequested: false });
        },
        {
          origin: "https://control.example.test",
          edgeAuthHeaders: {
            "x-forwarded-user": "interrupt@example.test",
            "x-forwarded-proto": "https",
            "x-forwarded-for": "198.51.100.40",
          },
        },
      );
    } finally {
      await closeHttpServer(server);
    }
  },
  180000,
);
