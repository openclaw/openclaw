// Real process replacement and a local provider prove the durable recovery boundary.
import { once } from "node:events";
import { access, readFile, writeFile } from "node:fs/promises";
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
import { extractAssistantPhaseText } from "../src/shared/chat-message-content.js";
import { reserveTestPortListener } from "../src/test-utils/port-claims.js";
import {
  readRestartSession,
  restartEnv,
  restartProviderServer,
  restartToolNames,
  restartModelConfig,
  writeRestartTitle,
  writeRestartToolCall,
} from "./gateway-restart.test-support.js";
import { acquireGatewayTestClient } from "./helpers/gateway-client.js";
import { writeOpenAiResponsesText } from "./helpers/openai-responses-sse.js";
import { createOpenClawTestInstance } from "./helpers/openclaw-test-instance.js";
import { createDeferred, withinTest } from "./helpers/promise.js";
import { runQaGatewayFixture } from "./helpers/qa-gateway-cleanup.js";

const SESSION_KEY = "agent:main:widget-restart-regression";
const WIDGET_NAME = "restart-chart";
const FINAL_MARKER = "WIDGET-RESTART-COMPLETE";
const PROGRESS_MARKER = "Widget recovery is still working.";
const FINAL_HTML = "<h1>Recovered chart</h1><p>Recovery completed.</p>";

async function startWidgetProvider(signal: AbortSignal) {
  const recovered = createDeferred();
  const releaseRecovery = createDeferred();
  const progressPersisted = createDeferred();
  const progressResumed = createDeferred();
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
      restartProviderServer(failed, async (request, response, body) => {
        const tools = restartToolNames(body);
        if (tools.length === 0) {
          if (body.stream === false) {
            writeRestartTitle(response, "Synthetic widget recovery session");
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
        const tool = (name: string, args: unknown) =>
          writeRestartToolCall(response, "widget", name, args, calls.length);
        const widget = (widget_code: string) =>
          tool(
            widgetName,
            widgetArgs({ title: "Restart chart", name: WIDGET_NAME, pin: true, widget_code }),
          );
        if (!recovering) {
          initialCalls += 1;
          if (initialCalls === 1) {
            widget("<p>Waiting for restart checkpoint</p>");
          } else if (initialCalls === 2) {
            tool("exec", {
              command:
                "touch checkpoint-ready; while [ ! -f checkpoint-resume ]; do sleep 0.1; done",
              yieldMs: 10000,
              timeoutSeconds: 120,
            });
          }
          // A subsequent model request remains pending until its owned Gateway dies.
          return;
        }
        recoveryCalls += 1;
        if (recoveryCalls === 1) {
          recovered.resolve();
          const name = tools.includes("message") ? "message" : "dispatch_action";
          const args = { action: "send", message: PROGRESS_MARKER, final: false };
          tool(name, name === "message" ? args : { id: "message", args });
          return;
        }
        if (recoveryCalls === 2) {
          // The next real provider request proves that the progress tool settled.
          progressPersisted.resolve();
          return;
        }
        if (recoveryCalls === 3) {
          progressResumed.resolve();
          await withinTest(releaseRecovery.promise, signal);
          widget(FINAL_HTML);
          return;
        }
        expect(recoveryCalls).toBe(4);
        writeOpenAiResponsesText(response, {
          text: FINAL_MARKER,
          messageId: "msg_recovered_final",
          responseId: "resp_recovered_final",
        });
      }),
  });
  return {
    baseUrl: `http://127.0.0.1:${reservation.claim.port}/v1`,
    calls,
    failed: failed.promise,
    recovered: recovered.promise,
    progressPersisted: progressPersisted.promise,
    progressResumed: progressResumed.promise,
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
  "preserves recovered progress through a second cold restart without an inline client",
  { timeout: 180_000 },
  async ({ signal }) => {
    const provider = await startWidgetProvider(signal);
    const wait = <T>(promise: Promise<T>, waitSignal = signal) =>
      withinTest(Promise.race([promise, provider.failed]), waitSignal);
    await runQaGatewayFixture(
      async () => {
        const model = buildMockOpenAiResponsesProvider(provider.baseUrl);
        const instance = await createOpenClawTestInstance({
          name: "gateway-widget-restart",
          signal,
          env: {
            ...restartEnv,
            OPENCLAW_SKIP_CANVAS_HOST: "0",
            // The synthetic provider is fixture-owned loopback, never an external service.
            NO_PROXY: "127.0.0.1,localhost",
            no_proxy: "127.0.0.1,localhost",
          },
          startTimeoutMs: 120_000,
          stopTimeoutMs: 10_000,
        });
        let client: GatewayClient | undefined;
        const terminalPublished = createDeferred<Record<string, unknown>>();
        const persisted = () => readRestartSession(instance.state.agentDir(), SESSION_KEY);
        await runQaGatewayFixture(
          async () => {
            const config: OpenClawConfig = {
              logging: { file: instance.state.path("gateway.log") },
              update: { checkOnStart: false },
              browser: { enabled: false },
              discovery: { mdns: { mode: "off" } },
              ...restartModelConfig(model, instance.state.workspaceDir),
              plugins: { enabled: false },
              tools: {
                allow: ["exec", "process", "dashboard", "show_widget", "message"],
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
            original.kill("SIGKILL");
            await withinTest(closed, signal);
            await writeFile(
              path.join(instance.state.workspaceDir, "checkpoint-resume"),
              "resume\n",
            );
            provider.beginRecovery();
            await instance.startGateway();
            expect(instance.child?.pid).not.toBe(original.pid);
            client = await connect(false);
            await wait(provider.recovered, AbortSignal.any([signal, AbortSignal.timeout(30_000)]));
            await wait(provider.progressPersisted);
            const progressHistory = await client.request("chat.history", {
              sessionKey: SESSION_KEY,
            });
            expect(JSON.stringify(progressHistory)).toContain(PROGRESS_MARKER);
            const recoveringProcess = instance.child;
            if (!recoveringProcess?.pid) {
              throw new Error("Owned recovery Gateway process unavailable");
            }
            await client.stopAndWait();
            client = undefined;
            const recoveryClosed = once(recoveringProcess, "close");
            expect(recoveringProcess.kill("SIGKILL")).toBe(true);
            await withinTest(recoveryClosed, signal);
            await instance.startGateway();
            expect(instance.child?.pid).not.toBe(recoveringProcess.pid);
            client = await connect(false);
            await client.request("sessions.subscribe", { agentId: "main" });
            // Socket readiness precedes admission of the new recovery lifecycle.
            await wait(provider.progressResumed);
            const recoveryRunId = persisted()?.lifecycleRunId;
            expect(typeof recoveryRunId).toBe("string");
            const settled = client.request("agent.wait", {
              runId: recoveryRunId,
              timeoutMs: 60_000,
            });
            void settled.catch(() => {});
            provider.release();
            expect(await wait(settled)).toMatchObject({
              status: "ok",
              endedAt: expect.any(Number),
            });
            // The terminal publication follows the owning SQLite write, unlike model EOF.
            const published = await wait(terminalPublished.promise);
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
            for (const marker of [FINAL_MARKER, PROGRESS_MARKER]) {
              expect(
                history.messages.filter(
                  (message) =>
                    message.role === "assistant" &&
                    extractAssistantPhaseText(message)?.trim() === marker,
                ),
              ).toHaveLength(1);
            }
            expect(instance.logs()).not.toContain("Session transcript keyed user is outside");
            expect(instance.logs()).toContain("startup-orphaned main session(s)");
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
