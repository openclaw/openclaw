import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { reserveTestPortListener } from "../../../src/test-utils/port-claims.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";
import { createDeferred, withinTest } from "../../../test/helpers/promise.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { controlUiSessionUrl } from "../test-helpers/control-ui-e2e.ts";
import { installTalkBrowserFixtures } from "./browser-talk-start-stop.fixtures.ts";
import { assertServedUi, chatControls, pairFixture } from "./chat-lifecycle.test-support.ts";
import { callGateway } from "./chat-real-gateway.test-support.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const sessionKey = "agent:main:talk-end-detach";
const detachedAnswer = "DETACHED_TALK_ANSWER_206321";
const cancelledAnswer = "CANCELLED_TALK_ANSWER_206321";

type ModelTurn = {
  index: number;
  release: (text: string) => void;
  aborted: Promise<void>;
  isAborted: () => boolean;
};

type RealtimeConnection = {
  ready: Promise<void>;
  closed: Promise<void>;
  emitConsult: (callId: string, question: string) => void;
};

function writeStreamedOpenAiText(
  response: ServerResponse,
  params: { text: string; messageId: string; responseId: string },
) {
  const message = {
    type: "message",
    id: params.messageId,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: params.text, annotations: [] }],
  };
  const events = [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...message, status: "in_progress", content: [] },
    },
    {
      type: "response.output_text.delta",
      item_id: message.id,
      output_index: 0,
      content_index: 0,
      delta: params.text,
    },
    {
      type: "response.output_text.done",
      item_id: message.id,
      output_index: 0,
      content_index: 0,
      text: params.text,
    },
    { type: "response.output_item.done", output_index: 0, item: message },
    {
      type: "response.completed",
      response: {
        id: params.responseId,
        status: "completed",
        output: [message],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ];
  response.end(
    `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`,
  );
}

const toolOnlyMarker = "TOOL_ONLY_CONSULT_206321";

function writeToolCallOnly(response: ServerResponse) {
  const item = {
    type: "function_call",
    id: "fc_tool_only",
    call_id: "call_tool_only",
    name: "session_status",
    arguments: "{}",
    status: "completed",
  };
  const events = [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress", arguments: "" },
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: "talk_resp_tool_only",
        status: "completed",
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ];
  response.end(
    `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`,
  );
}

/** Only the model and voice provider endpoints are scripted; Gateway, Talk relay, chat persistence, and Control UI are real. */
async function startTalkFixtureServer() {
  const turns: ModelTurn[] = [];
  const turnWaiters: Array<(turn: ModelTurn) => void> = [];
  const connections: RealtimeConnection[] = [];
  const connectionWaiters: Array<(connection: RealtimeConnection) => void> = [];
  let turnIndex = 0;

  let wss: WebSocketServer | undefined;
  const reserved = await reserveTestPortListener({
    offsets: [0],
    createListener: () => {
      const server = createServer((request, response) => {
        void (async () => {
          if (request.method !== "POST" || request.url !== "/v1/responses") {
            request.resume();
            response.writeHead(404).end();
            return;
          }
          const chunks: Buffer[] = [];
          request.on("data", (chunk: Buffer) => chunks.push(chunk));
          await once(request, "end");
          const requestBody = Buffer.concat(chunks).toString("utf8");
          response.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-store",
            connection: "keep-alive",
          });
          response.flushHeaders();
          // A tool-only first step streams no text, like a run that is still working
          // with tools when the call ends. Only the follow-up request becomes a held turn.
          if (
            requestBody.includes(toolOnlyMarker) &&
            !requestBody.includes("function_call_output")
          ) {
            writeToolCallOnly(response);
            return;
          }

          const index = ++turnIndex;
          const releaseDeferred = createDeferred<string>();
          const abortedDeferred = createDeferred<void>();
          let aborted = false;
          const markAborted = () => {
            if (!response.writableEnded) {
              aborted = true;
              abortedDeferred.resolve();
            }
          };
          request.on("close", markAborted);
          response.on("close", markAborted);

          const turn: ModelTurn = {
            index,
            release: (text: string) => releaseDeferred.resolve(text),
            aborted: abortedDeferred.promise,
            isAborted: () => aborted,
          };
          turns.push(turn);
          turnWaiters.shift()?.(turn);

          const text = await Promise.race([
            releaseDeferred.promise,
            abortedDeferred.promise.then(() => null),
          ]);
          if (text !== null && !aborted && !response.writableEnded) {
            writeStreamedOpenAiText(response, {
              text,
              messageId: `talk_msg_${index}`,
              responseId: `talk_resp_${index}`,
            });
          }
        })();
      });

      wss = new WebSocketServer({ server, path: "/realtime" });
      wss.on("connection", (ws: WebSocket) => {
        const readyDeferred = createDeferred<void>();
        const closedDeferred = createDeferred<void>();
        ws.on("message", (raw) => {
          const event = JSON.parse(Buffer.from(raw as Buffer).toString("utf8")) as {
            type?: string;
          };
          if (event.type === "session.update") {
            ws.send(JSON.stringify({ type: "session.updated", session: {} }));
            readyDeferred.resolve();
          }
        });
        ws.on("close", () => closedDeferred.resolve());

        const connection: RealtimeConnection = {
          ready: readyDeferred.promise,
          closed: closedDeferred.promise,
          emitConsult: (callId: string, question: string) => {
            ws.send(
              JSON.stringify({
                type: "conversation.item.input_audio_transcription.completed",
                item_id: `user_${callId}`,
                transcript: question,
              }),
            );
            ws.send(
              JSON.stringify({
                type: "response.done",
                response: {
                  id: `resp_${callId}`,
                  status: "completed",
                  output: [
                    {
                      type: "function_call",
                      id: `fc_${callId}`,
                      call_id: callId,
                      status: "completed",
                      name: "openclaw_agent_consult",
                      arguments: JSON.stringify({ question }),
                    },
                  ],
                },
              }),
            );
          },
        };
        connections.push(connection);
        connectionWaiters.shift()?.(connection);
      });

      return server;
    },
  });

  return {
    port: reserved.claim.port,
    waitForTurn(index: number, signal: AbortSignal): Promise<ModelTurn> {
      const existing = turns[index];
      if (existing) {
        return Promise.resolve(existing);
      }
      const deferred = createDeferred<ModelTurn>();
      turnWaiters.push((turn) => deferred.resolve(turn));
      return withinTest(deferred.promise, signal);
    },
    waitForConnection(index: number, signal: AbortSignal): Promise<RealtimeConnection> {
      const existing = connections[index];
      if (existing) {
        return Promise.resolve(existing);
      }
      const deferred = createDeferred<RealtimeConnection>();
      connectionWaiters.push((connection) => deferred.resolve(connection));
      return withinTest(deferred.promise, signal);
    },
    async stop() {
      await runQaGatewayFixture(
        async () => {
          wss?.clients.forEach((client) => client.terminate());
          await new Promise<void>((resolve) => {
            if (wss) {
              wss.close(() => resolve());
            } else {
              resolve();
            }
          });
          reserved.listener.closeAllConnections();
          await reserved.releaseListener();
        },
        () => reserved.claim.release(),
      );
    },
  };
}

let instance: OpenClawTestInstance;
let fixture: Awaited<ReturnType<typeof startTalkFixtureServer>>;

const suite = createControlUiE2eSuite({
  name: "Control UI Talk End Talk detaches while Stop response cancels through a real Gateway",
  startServerBeforeBrowser: true,
  browserLaunchOptions: {
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  },
  async startServer() {
    await fs.access("dist/control-ui/index.html");
    fixture = await startTalkFixtureServer();
    const cleanup = () =>
      runQaGatewayFixture(
        () => instance?.cleanup(),
        () => fixture.stop(),
      );
    try {
      instance = await createOpenClawTestInstance({
        name: "talk-end-detach",
        env: { OPENCLAW_TEST_MINIMAL_GATEWAY: undefined, VITEST: undefined },
        config: {
          update: { checkOnStart: false },
          gateway: { controlUi: { enabled: true } },
          cron: { enabled: false },
          browser: { enabled: false },
          agents: {
            ownership: "explicit",
            defaults: {
              model: "talk-fixture/echo",
              modelPolicy: { allow: ["talk-fixture/*"] },
            },
            entries: { main: { identity: { name: "Talk fixture" } } },
          },
          models: {
            catalogRefresh: { enabled: false },
            providers: {
              "talk-fixture": {
                api: "openai-responses",
                apiKey: "synthetic-talk-fixture-key",
                baseUrl: `http://127.0.0.1:${fixture.port}/v1`,
                request: { allowPrivateNetwork: true },
                models: [{ id: "echo", name: "Echo" }],
              },
            },
          },
          plugins: { allow: ["openai"] },
          talk: {
            realtime: {
              mode: "realtime",
              provider: "openai",
              transport: "gateway-relay",
              brain: "agent-consult",
              providers: {
                openai: {
                  apiKey: "synthetic-realtime-key",
                  baseUrl: `ws://127.0.0.1:${fixture.port}/realtime`,
                  model: "gpt-realtime",
                },
              },
            },
          },
        },
      });
      await instance.startGateway();
      return { baseUrl: `http://127.0.0.1:${instance.port}/`, close: cleanup };
    } catch (error) {
      return runQaGatewayFixture(async () => {
        throw error;
      }, cleanup);
    }
  },
});

suite.define(() => {
  it(
    "preserves an accepted Talk run after End Talk and cancels a second run on Stop response",
    (test) =>
      suite.runScenario(test, {
        retainedState: () => instance.stateDir,
        run: (signal) =>
          suite.withPage(
            createControlUiE2eContextOptions({ permissions: ["microphone"] }),
            async ({ page }) => {
              await callGateway(instance, "sessions.create", {
                key: sessionKey,
                agentId: "main",
                label: "Talk detach acceptance",
              });
              await pairFixture(page, instance);
              await installTalkBrowserFixtures(page);
              await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
              await waitForControlUiGatewayReady(page);
              const { pane, composer, stop } = chatControls(page);
              await composer.waitFor();
              await assertServedUi(page, suite.server.baseUrl);

              const startVoice = pane.getByRole("button", {
                name: /^(?:Start voice input|Tap to talk)$/,
              });
              const stopVoice = pane.getByRole("button", { name: "Stop voice input" });

              // 1. Accept a consult during Talk, click End Talk, then reload and verify one answer.
              await startVoice.click();
              const firstRelay = await fixture.waitForConnection(0, signal);
              await withinTest(firstRelay.ready, signal);
              await expect
                .poll(() =>
                  pane.locator('.agent-chat__voice-activity[data-status="listening"]').count(),
                )
                .toBe(1);

              firstRelay.emitConsult("call_detach_1", "Check the detached report.");
              const firstTurn = await fixture.waitForTurn(0, signal);
              await expect.poll(() => stop.isVisible()).toBe(true);
              await expect.poll(() => stopVoice.isVisible()).toBe(true);

              await stopVoice.click();
              await withinTest(firstRelay.closed, signal);
              await expect.poll(() => stopVoice.count()).toBe(0);
              expect(firstTurn.isAborted()).toBe(false);
              await expect.poll(() => stop.isVisible()).toBe(true);

              const bubbleCount = (text: string) =>
                pane.locator(".chat-bubble").filter({ hasText: text }).count();
              const persistedOccurrences = async (needle: string) => {
                const raw = await callGateway(instance, "chat.history", { sessionKey });
                return raw.split(needle).length - 1;
              };

              firstTurn.release(detachedAnswer);
              await expect.poll(() => bubbleCount(detachedAnswer)).toBe(1);
              await stop.waitFor({ state: "hidden" });

              await page.reload();
              await waitForControlUiGatewayReady(page);
              await expect.poll(() => bubbleCount(detachedAnswer)).toBe(1);
              expect(await persistedOccurrences(detachedAnswer)).toBe(1);

              // 2. Accept a second consult during Talk, click Stop response, and verify cancellation.
              await startVoice.click();
              const secondRelay = await fixture.waitForConnection(1, signal);
              await withinTest(secondRelay.ready, signal);
              await expect
                .poll(() =>
                  pane.locator('.agent-chat__voice-activity[data-status="listening"]').count(),
                )
                .toBe(1);

              secondRelay.emitConsult("call_abort_2", "Start a run that I will cancel.");
              const secondTurn = await fixture.waitForTurn(1, signal);
              await expect.poll(() => stop.isVisible()).toBe(true);

              await stop.click();
              await withinTest(secondTurn.aborted, signal);
              expect(secondTurn.isAborted()).toBe(true);
              secondTurn.release(cancelledAnswer);
              await stop.waitFor({ state: "hidden" });

              await stopVoice.click();
              await withinTest(secondRelay.closed, signal);

              await page.reload();
              await waitForControlUiGatewayReady(page);
              await expect.poll(() => bubbleCount(detachedAnswer)).toBe(1);
              expect(await bubbleCount(cancelledAnswer)).toBe(0);
              expect(await persistedOccurrences(detachedAnswer)).toBe(1);
              expect(await persistedOccurrences(cancelledAnswer)).toBe(0);
            },
          ),
      }),
    180_000,
  );

  it(
    "shows Stop response beside End Talk while a Talk run is in progress at phone and desktop widths",
    (test) =>
      suite.runScenario(test, {
        retainedState: () => instance.stateDir,
        run: (signal) =>
          suite.withPage(
            createControlUiE2eContextOptions({ permissions: ["microphone"] }),
            async ({ page }) => {
              const widthKey = "agent:main:talk-stop-widths";
              await callGateway(instance, "sessions.create", {
                key: widthKey,
                agentId: "main",
                label: "Talk stop widths",
              });
              await pairFixture(page, instance);
              await installTalkBrowserFixtures(page);
              const shotDir = process.env.TALK_STOP_SHOT_DIR;
              const widths = [
                { width: 390, height: 844 },
                { width: 1440, height: 900 },
              ];
              let connectionIndex = 2;
              for (const [index, size] of widths.entries()) {
                await page.setViewportSize(size);
                await page.goto(controlUiSessionUrl(suite.server.baseUrl, widthKey));
                await waitForControlUiGatewayReady(page);
                const { pane, composer, stop } = chatControls(page);
                await composer.waitFor();
                const startVoice = pane.getByRole("button", {
                  name: /^(?:Start voice input|Tap to talk)$/,
                });
                const stopVoice = pane.getByRole("button", { name: "Stop voice input" });
                await startVoice.click();
                const relay = await fixture.waitForConnection(connectionIndex, signal);
                await withinTest(relay.ready, signal);
                relay.emitConsult(
                  `call_widths_${index}`,
                  `Run something I can stop. ${toolOnlyMarker}`,
                );
                const turn = await fixture.waitForTurn(2 + index, signal);
                await expect.poll(() => stopVoice.isVisible()).toBe(true);
                await expect.poll(() => stop.isVisible()).toBe(true);
                if (shotDir) {
                  await page.screenshot({
                    path: `${shotDir}/composer-talk-run-${size.width}.png`,
                  });
                }

                // End Talk drops the call only; Stop response and a way back into Talk remain.
                await stopVoice.click();
                await withinTest(relay.closed, signal);
                await expect.poll(() => stopVoice.count()).toBe(0);
                expect(turn.isAborted()).toBe(false);
                await expect.poll(() => stop.isVisible()).toBe(true);
                await expect.poll(() => startVoice.first().isEnabled()).toBe(true);
                if (shotDir) {
                  await page.screenshot({
                    path: `${shotDir}/composer-after-end-talk-${size.width}.png`,
                  });
                }

                // Rejoining Talk keeps the same run going in the same chat.
                await startVoice.first().click();
                const rejoined = await fixture.waitForConnection(connectionIndex + 1, signal);
                await withinTest(rejoined.ready, signal);
                await expect.poll(() => stopVoice.isVisible()).toBe(true);
                expect(turn.isAborted()).toBe(false);
                await expect.poll(() => stop.isVisible()).toBe(true);
                await stopVoice.click();
                await withinTest(rejoined.closed, signal);
                connectionIndex += 2;

                await stop.click();
                await withinTest(turn.aborted, signal);
                expect(turn.isAborted()).toBe(true);
                turn.release(cancelledAnswer);
                await stop.waitFor({ state: "hidden" });
              }
            },
          ),
      }),
    180_000,
  );
});
