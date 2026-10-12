// Real process replacement and a local provider prove the durable recovery boundary.
import { once } from "node:events";
import { access, readFile, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { asRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_CAPS,
  GATEWAY_CLIENT_IDS,
} from "../packages/gateway-protocol/src/client-info.js";
import type { BoardSnapshot } from "../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../src/config/config.js";
import type { GatewayClient } from "../src/gateway/client.js";
import type { SessionsListResult } from "../src/gateway/session-utils.types.js";
import { buildMockOpenAiResponsesProvider } from "../src/gateway/test-openai-responses-model.js";
import { loadOrCreateDeviceIdentity } from "../src/infra/device-identity.js";
import { openNodeSqliteDatabase } from "../src/infra/node-sqlite.js";
import { extractAssistantPhaseText } from "../src/shared/chat-message-content.js";
import { reserveTestPortListener } from "../src/test-utils/port-claims.js";
import { acquireGatewayTestClient } from "./helpers/gateway-client.js";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "./helpers/openai-responses-sse.js";
import { createOpenClawTestInstance } from "./helpers/openclaw-test-instance.js";
import { createDeferred, withinTest } from "./helpers/promise.js";
import { runQaGatewayFixture } from "./helpers/qa-gateway-cleanup.js";

const SESSION_KEY = "agent:main:widget-restart-regression";
const WIDGET_NAME = "restart-chart";
const FINAL_MARKER = "WIDGET-RESTART-COMPLETE";
const FINAL_HTML = "<h1>Recovered chart</h1><p>Recovery completed.</p>";

function writeToolCall(response: ServerResponse, name: string, args: unknown, ordinal: number) {
  const item = {
    type: "function_call",
    id: `fc_widget_${ordinal}`,
    call_id: `call_widget_${ordinal}`,
    name,
    arguments: JSON.stringify(args),
  };
  writeOpenAiResponsesSse(response, [
    { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
    {
      type: "response.function_call_arguments.delta",
      output_index: 0,
      item_id: item.id,
      delta: item.arguments,
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: `resp_widget_${ordinal}`,
        status: "completed",
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ]);
}

async function startWidgetProvider(signal: AbortSignal) {
  const recovered = createDeferred();
  const releaseRecovery = createDeferred();
  const failed = createDeferred<never>();
  void failed.promise.catch(() => {});
  const calls: Array<{ recovering: boolean; tools: string[]; input: unknown }> = [];
  let recovering = false;
  let initialCalls = 0;
  let recoveryCalls = 0;
  const reservation = await reserveTestPortListener({
    offsets: [0],
    signal,
    createListener: () =>
      createServer((request, response) => {
        void (async () => {
          const chunks: Buffer[] = [];
          for await (const chunk of request) {
            chunks.push(Buffer.from(chunk));
          }
          const body = asRecord(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          const tools = Array.isArray(body.tools)
            ? body.tools.flatMap((tool) =>
                isRecord(tool) && typeof tool.name === "string" ? [tool.name] : [],
              )
            : [];
          if (tools.length === 0) {
            if (body.stream === false) {
              response.writeHead(200, { "content-type": "application/json" });
              response.end(
                JSON.stringify({
                  id: "resp_title",
                  object: "response",
                  status: "completed",
                  output: [
                    {
                      type: "message",
                      id: "msg_title",
                      role: "assistant",
                      status: "completed",
                      content: [
                        {
                          type: "output_text",
                          text: "Synthetic widget recovery session",
                          annotations: [],
                        },
                      ],
                    },
                  ],
                  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
                }),
              );
              return;
            }
            writeOpenAiResponsesText(response, {
              text: "Synthetic widget recovery session",
              messageId: "msg_title",
              responseId: "resp_title",
            });
            return;
          }
          expect(request.url).toBe("/v1/responses");
          calls.push({ recovering, tools, input: body.input });
          expect(tools.some((name) => name === "show_widget" || name === "dispatch_action")).toBe(
            true,
          );
          const widgetName = tools.includes("show_widget") ? "show_widget" : "dispatch_action";
          const widgetArgs = (args: unknown) =>
            widgetName === "dispatch_action" ? { id: "show_widget", args } : args;
          if (!recovering) {
            initialCalls += 1;
            if (initialCalls === 1) {
              writeToolCall(
                response,
                widgetName,
                widgetArgs({
                  title: "Restart chart",
                  name: WIDGET_NAME,
                  pin: true,
                  widget_code: "<p>Waiting for restart checkpoint</p>",
                }),
                calls.length,
              );
            } else if (initialCalls === 2) {
              writeToolCall(
                response,
                "exec",
                {
                  command:
                    "touch checkpoint-ready; while [ ! -f checkpoint-resume ]; do sleep 0.1; done",
                  yieldMs: 10000,
                  timeoutSeconds: 120,
                },
                calls.length,
              );
            }
            // A subsequent model request remains pending until its owned Gateway dies.
            return;
          }
          recoveryCalls += 1;
          if (recoveryCalls === 1) {
            recovered.resolve();
            await withinTest(releaseRecovery.promise, signal);
            writeToolCall(
              response,
              widgetName,
              widgetArgs({
                title: "Restart chart",
                name: WIDGET_NAME,
                pin: true,
                widget_code: FINAL_HTML,
              }),
              calls.length,
            );
            return;
          }
          expect(recoveryCalls).toBe(2);
          writeOpenAiResponsesText(response, {
            text: FINAL_MARKER,
            messageId: "msg_recovered_final",
            responseId: "resp_recovered_final",
          });
        })().catch((error: unknown) => {
          failed.reject(error);
          response.destroy(error instanceof Error ? error : undefined);
        });
      }),
  });
  return {
    baseUrl: `http://127.0.0.1:${reservation.claim.port}/v1`,
    calls,
    failed: failed.promise,
    recovered: recovered.promise,
    beginRecovery: () => {
      recovering = true;
    },
    release: () => releaseRecovery.resolve(),
    close: () =>
      runQaGatewayFixture(
        async () => {
          releaseRecovery.resolve();
          reservation.listener.closeAllConnections();
        },
        reservation.releaseListener,
        reservation.claim.release,
      ),
  };
}

it.skipIf(process.platform === "win32")(
  "persists terminal completion after a widget turn recovers without an inline client",
  { timeout: 180_000 },
  async ({ signal }) => {
    const provider = await startWidgetProvider(signal);
    await runQaGatewayFixture(
      async () => {
        const model = buildMockOpenAiResponsesProvider(provider.baseUrl);
        const instance = await createOpenClawTestInstance({
          name: "gateway-widget-restart",
          signal,
          env: {
            OPENAI_API_KEY: undefined,
            OPENAI_BASE_URL: undefined,
            OPENAI_API_BASE: undefined,
            OPENCLAW_SKIP_PROVIDERS: undefined,
            OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
            OPENCLAW_SKIP_CANVAS_HOST: "0",
          },
          startTimeoutMs: 120_000,
          stopTimeoutMs: 10_000,
        });
        let client: GatewayClient | undefined;
        const terminalPublished = createDeferred<Record<string, unknown>>();
        const persisted = () => {
          const db = openNodeSqliteDatabase(
            path.join(instance.state.agentDir(), "openclaw-agent.sqlite"),
            { readOnly: true },
          );
          try {
            const row = db
              .prepare("SELECT entry_json FROM session_nodes WHERE session_key = ?")
              .get(SESSION_KEY);
            return typeof row?.entry_json === "string"
              ? asRecord(JSON.parse(row.entry_json))
              : undefined;
          } finally {
            db.close();
          }
        };
        await runQaGatewayFixture(
          async () => {
            try {
              const config: OpenClawConfig = {
                logging: { file: instance.state.path("gateway.log") },
                update: { checkOnStart: false },
                browser: { enabled: false },
                discovery: { mdns: { mode: "off" } },
                models: {
                  mode: "replace",
                  providers: {
                    [model.providerId]: { ...model.config, request: { allowPrivateNetwork: true } },
                  },
                },
                plugins: { enabled: false },
                agents: {
                  defaults: {
                    workspace: instance.state.workspaceDir,
                    model: { primary: model.modelRef },
                    modelPolicy: { allow: [model.modelRef] },
                    models: {
                      [model.modelRef]: {
                        agentRuntime: { id: "openclaw" },
                        params: { transport: "sse", openaiWsWarmup: false },
                      },
                    },
                    heartbeat: { every: "0m" },
                    skipBootstrap: true,
                    skills: [],
                    timeoutSeconds: 120,
                  },
                  entries: { main: {} },
                },
                tools: {
                  allow: ["exec", "process", "dashboard", "show_widget"],
                  exec: { mode: "full", host: "gateway" },
                  codeMode: { enabled: false },
                },
                gateway: {
                  mode: "local",
                  bind: "loopback",
                  port: instance.port,
                  auth: { mode: "token", token: instance.gatewayToken },
                  controlUi: { enabled: true },
                },
              };
              await instance.state.writeConfig(config);
              await instance.startGateway();
              const { buildId } = asRecord(
                JSON.parse(await readFile("dist/build-info.json", "utf8")),
              );
              expect(typeof buildId).toBe("string");
              const deviceIdentity = loadOrCreateDeviceIdentity({
                path: instance.state.path("proof-device.sqlite"),
              });
              // A TEST observer must not replace the original Control UI token's issuer binding.
              const observerDeviceIdentity = loadOrCreateDeviceIdentity({
                path: instance.state.path("proof-observer-device.sqlite"),
              });
              const connect = (controlUi: boolean) =>
                acquireGatewayTestClient(
                  {
                    url: instance.url,
                    token: instance.gatewayToken,
                    deviceIdentity: controlUi ? deviceIdentity : observerDeviceIdentity,
                    origin: controlUi ? `http://127.0.0.1:${instance.port}` : undefined,
                    clientName: controlUi ? GATEWAY_CLIENT_IDS.CONTROL_UI : GATEWAY_CLIENT_IDS.TEST,
                    clientBuildId: controlUi && typeof buildId === "string" ? buildId : undefined,
                    mode: controlUi ? "webchat" : "test",
                    scopes: ["operator.admin", "operator.read", "operator.write"],
                    caps: controlUi
                      ? [GATEWAY_CLIENT_CAPS.INLINE_WIDGETS, GATEWAY_CLIENT_CAPS.TOOL_EVENTS]
                      : [],
                    onEvent: ({ event, payload }) => {
                      if (
                        event === "sessions.changed" &&
                        isRecord(payload) &&
                        payload.sessionKey === SESSION_KEY &&
                        (payload.phase === "end" || payload.phase === "error")
                      ) {
                        terminalPublished.resolve(payload);
                      }
                    },
                  },
                  {
                    timeoutMs: 30_000,
                    timeoutMessage: "widget recovery connect timeout",
                    closeMessage: "widget recovery connect closed",
                    signal,
                  },
                );
              client = await connect(true);
              await client.request("sessions.create", {
                key: SESSION_KEY,
                agentId: "main",
                label: "Widget recovery regression",
                model: model.modelRef,
                permissionMode: "full",
                cwd: instance.state.workspaceDir,
              });
              await client.request("chat.send", {
                sessionKey: SESSION_KEY,
                message:
                  "Create the pinned restart chart, wait at the exec checkpoint, then update the chart and finish after Gateway recovery.",
                idempotencyKey: "widget-restart-original-turn",
              });
              await withinTest(
                Promise.race([
                  vi.waitFor(
                    () => access(path.join(instance.state.workspaceDir, "checkpoint-ready")),
                    {
                      timeout: 60_000,
                      interval: 25,
                    },
                  ),
                  provider.failed,
                ]),
                signal,
              );
              const initialBoard = await client.request<BoardSnapshot>("board.get", {
                sessionKey: SESSION_KEY,
              });
              expect(initialBoard.widgets).toEqual([
                expect.objectContaining({ name: WIDGET_NAME, contentKind: "html" }),
              ]);
              const initial = await client.request<SessionsListResult>("sessions.list", {
                agentId: "main",
              });
              expect(initial.sessions.find((row) => row.key === SESSION_KEY)).toMatchObject({
                status: "running",
                hasActiveRun: true,
              });
              const original = instance.child;
              if (!original?.pid) {
                throw new Error("Owned Gateway process unavailable");
              }
              await client.stopAndWait();
              client = undefined;
              const closed = once(original, "close");
              process.kill(-original.pid, "SIGKILL");
              await withinTest(closed, signal);
              await writeFile(
                path.join(instance.state.workspaceDir, "checkpoint-resume"),
                "resume\n",
              );
              provider.beginRecovery();
              await instance.startGateway();
              expect(instance.child?.pid).not.toBe(original.pid);
              client = await connect(false);
              await withinTest(
                Promise.race([provider.recovered, provider.failed]),
                AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
              );
              await client.request("sessions.subscribe", { agentId: "main" });
              const recoveryRunId = persisted()?.lifecycleRunId;
              expect(typeof recoveryRunId).toBe("string");
              const settled = client.request("agent.wait", {
                runId: recoveryRunId,
                timeoutMs: 60_000,
              });
              void settled.catch(() => {});
              provider.release();
              expect(
                await withinTest(Promise.race([settled, provider.failed]), signal),
              ).toMatchObject({
                status: "ok",
                endedAt: expect.any(Number),
              });
              // The terminal publication follows the owning SQLite write, unlike model EOF.
              const published = await withinTest(
                Promise.race([terminalPublished.promise, provider.failed]),
                signal,
              );
              const durable = persisted();
              const rows = await client.request<SessionsListResult>("sessions.list", {
                agentId: "main",
              });
              expect({
                durable,
                published,
                projected: rows.sessions.find((row) => row.key === SESSION_KEY),
              }).toMatchObject({
                durable: { status: "done", abortedLastRun: false, endedAt: expect.any(Number) },
                published: { phase: "end", runId: recoveryRunId },
                projected: { status: "done", hasActiveRun: false },
              });
              expect(durable?.mainRestartRecovery).toBeUndefined();
              const board = await client.request<BoardSnapshot>("board.get", {
                sessionKey: SESSION_KEY,
              });
              expect(board.widgets).toEqual([
                expect.objectContaining({ name: WIDGET_NAME, contentKind: "html" }),
              ]);
              expect(board.widgets[0]!.revision).toBeGreaterThan(initialBoard.widgets[0]!.revision);
              const history = await client.request<{
                messages: Array<{ role: string; content?: unknown }>;
              }>("chat.history", { sessionKey: SESSION_KEY });
              expect(
                history.messages.filter(
                  (message) =>
                    message.role === "assistant" &&
                    extractAssistantPhaseText(message)?.trim() === FINAL_MARKER,
                ),
              ).toHaveLength(1);
              expect(instance.logs()).toContain("startup-orphaned main session(s)");
              console.info(
                JSON.stringify({
                  proof: "widget-restart",
                  runtime: process.versions.bun ?? process.version,
                  durableStatus: durable?.status,
                  projectedStatus: rows.sessions.find((row) => row.key === SESSION_KEY)?.status,
                  hasActiveRun: rows.sessions.find((row) => row.key === SESSION_KEY)?.hasActiveRun,
                  widgetRevision: board.widgets[0]!.revision,
                  providerCalls: provider.calls.map(({ recovering, tools }) => ({
                    recovering,
                    tools,
                  })),
                }),
              );
            } catch (cause) {
              let entry: unknown;
              try {
                const full = persisted();
                entry = Object.fromEntries(
                  [
                    "status",
                    "abortedLastRun",
                    "startedAt",
                    "endedAt",
                    "activeWriterRunId",
                    "lifecycleRunId",
                    "lastRunId",
                    "restartRecoveryRuns",
                    "mainRestartRecovery",
                    "restartRecoveryDeliveryRunId",
                    "restartRecoveryDeliverySourceRunId",
                    "restartRecoverySourceIngress",
                  ].map((key) => [key, full?.[key]]),
                );
              } catch {
                entry = "unavailable";
              }
              const diagnostics = JSON.stringify({
                calls: provider.calls.map(({ recovering, tools }) => ({ recovering, tools })),
                entry,
                logs: instance.logs(),
              });
              throw new Error(
                diagnostics
                  .replaceAll(instance.gatewayToken, "[fixture token]")
                  .replaceAll(instance.hookToken, "[fixture token]"),
                { cause },
              );
            }
          },
          async () => {
            provider.release();
            await client?.stopAndWait();
          },
          () => instance.cleanup(),
        );
      },
      () => provider.close(),
    );
  },
);
