import { createServer } from "node:http";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import type {
  GatewayFrame,
  RequestFrame,
  ResponseFrame,
} from "../../../packages/gateway-protocol/src/schema/frames.js";
import { reserveTestPortListener } from "../../../src/test-utils/port-claims.js";
import { writeOpenAiResponsesText } from "../../../test/helpers/openai-responses-sse.ts";
import type { OpenClawTestInstance } from "../../../test/helpers/openclaw-test-instance.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { openChatDetails } from "./chat-details.test-support.ts";
import { assertServedUi, chatControls, pairFixture } from "./chat-lifecycle.test-support.ts";
import { createChatGatewayInstance } from "./chat-real-gateway.test-support.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

let instance: OpenClawTestInstance;
const suite = createControlUiE2eSuite({
  name: "A brand-new chat through a real Gateway",
  startServerBeforeBrowser: true,
  async startServer() {
    const provider = await reserveTestPortListener({
      offsets: [0],
      createListener: () =>
        createServer((request, response) => {
          request.resume();
          request.once("end", () => {
            if (request.method !== "POST" || request.url !== "/v1/responses") {
              response.writeHead(404).end();
              return;
            }
            writeOpenAiResponsesText(response, {
              text: "First reply.",
              messageId: "new-chat-message",
              responseId: "new-chat-response",
            });
          });
        }),
    });
    const cleanup = () =>
      runQaGatewayFixture(
        () => instance?.cleanup(),
        async () => {
          provider.listener.closeAllConnections();
          await provider.releaseListener();
        },
        () => provider.claim.release(),
      );
    try {
      instance = await createChatGatewayInstance({
        name: "new-chat-readers",
        provider: "new-chat-fixture",
        identity: "New chat fixture",
        model: "echo",
        apiKey: "synthetic-unused-key",
        baseUrl: `http://127.0.0.1:${provider.claim.port}/v1`,
        models: [{ id: "echo", name: "Echo" }],
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
  it("opens the main chat before its first turn without session read failures", (test) =>
    suite.runScenario(test, {
      retainedState: () => instance.stateDir,
      run: () =>
        // The service worker serves a reload's shell before the Gateway answers, as for users.
        suite.withPage(
          {
            ...createControlUiE2eContextOptions(),
            serviceWorkers: "allow",
            viewport: { width: 1100, height: 900 },
          },
          async ({ page }) => {
            const pending = new Map<string, RequestFrame>();
            const responses: { method: string; response: ResponseFrame }[] = [];
            // Holds history answers while set, like a slow Gateway, so Details mounts before
            // the chat learns whether its session exists.
            let historyHold: Promise<void> | undefined;
            await page.routeWebSocket(`ws://127.0.0.1:${instance.port}/**`, (socket) => {
              const server = socket.connectToServer();
              socket.onMessage((message) => {
                const frame: GatewayFrame = JSON.parse(String(message));
                if (frame.type === "req") {
                  pending.set(frame.id, frame);
                }
                server.send(message);
              });
              server.onMessage(async (message) => {
                const frame: GatewayFrame = JSON.parse(String(message));
                const request = frame.type === "res" ? pending.get(frame.id) : undefined;
                if (frame.type === "res" && request) {
                  responses.push({ method: request.method, response: frame });
                  if (historyHold && request.method === "sessions.messages.subscribe") {
                    await historyHold;
                  }
                }
                socket.send(message);
              });
            });
            const succeeded = (method: string) =>
              responses.some((rpc) => rpc.method === method && rpc.response.ok);
            await pairFixture(page, instance);
            await page.goto(new URL("chat/main", suite.server.baseUrl).href);
            await waitForControlUiGatewayReady(page);
            await assertServedUi(page, suite.server.baseUrl);
            const { pane, composer, send } = chatControls(page);
            const historyAnswers = () =>
              responses.filter((rpc) => rpc.method === "sessions.messages.subscribe").length;
            await expect.poll(historyAnswers).toBeGreaterThan(0);
            await page.locator('aside.sidebar[data-snapshot-saved="true"]').waitFor();
            // A full page load of the unstarted chat, from its saved shell, while history is slow.
            const answered = historyAnswers();
            const release = Promise.withResolvers<void>();
            historyHold = release.promise;
            await page.reload();
            await waitForControlUiGatewayReady(page);
            await expect.poll(historyAnswers).toBeGreaterThan(answered);
            // Automatic Details can wait for the transcript we are holding. Open it explicitly,
            // then dock it so its readers stay mounted through the first send.
            const details = await openChatDetails(pane);
            await details.locator("openclaw-chat-details-session").waitFor({ state: "attached" });
            await page.setViewportSize({ width: 1600, height: 900 });
            historyHold = undefined;
            release.resolve();
            await composer.fill("Hello for the first time");
            expect([...pending.values()].map((req) => req.method)).not.toContain(
              "sessions.processes.list",
            );
            await send.click();
            await pane
              .locator(".chat-bubble")
              .getByText("First reply.", { exact: true })
              .last()
              .waitFor({ timeout: 60_000 });
            // A just-started Gateway may still be warming its Talk providers; that read retries.
            const failures = () =>
              responses
                .filter(
                  (rpc) =>
                    !rpc.response.ok &&
                    asOptionalRecord(rpc.response.error?.details)?.reason !==
                      "talk-catalog-warming",
                )
                .map((rpc) => ({ method: rpc.method, error: rpc.response.error }));
            expect(failures()).toEqual([]);
            // Row-scoped readers start once the first turn has created the session row.
            await expect
              .poll(
                () =>
                  succeeded("sessions.processes.list") &&
                  succeeded("mcp.app.discover") &&
                  succeeded("sessions.diff"),
              )
              .toBe(true);
            expect(failures()).toEqual([]);
          },
        ),
    }));
});
