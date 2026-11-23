import { createServer } from "node:http";
import { expect, it } from "vitest";
import { isIncognitoSessionKey } from "../../../packages/session-url-contract/src/session-key.js";
import { reserveTestPortListener } from "../../../src/test-utils/port-claims.js";
import { writeOpenAiResponsesText } from "../../../test/helpers/openai-responses-sse.ts";
import type { OpenClawTestInstance } from "../../../test/helpers/openclaw-test-instance.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { observeBackgroundWorkRpc } from "./background-work.real-gateway.test-support.ts";
import { assertServedUi, chatControls, pairFixture } from "./chat-lifecycle.test-support.ts";
import { createChatGatewayInstance } from "./chat-real-gateway.test-support.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

// Incognito transcripts stay in the Gateway process, so every leaf-fenced browser send
// must classify its expected leaf without a database worker.
let instance: OpenClawTestInstance;
let modelTurns = 0;
const suite = createControlUiE2eSuite({
  name: "Incognito chat sends through a real Gateway",
  startServerBeforeBrowser: true,
  async startServer() {
    const provider = await reserveTestPortListener({
      offsets: [0],
      createListener: () =>
        createServer((request, response) => {
          let body = "";
          request.on("data", (chunk) => {
            body += chunk.toString();
          });
          request.once("end", () => {
            if (request.method !== "POST" || request.url !== "/v1/responses") {
              response.writeHead(404).end();
              return;
            }
            // Background titles must neither count as turns nor satisfy reply assertions.
            if (body.includes("Generate a concise session title")) {
              writeOpenAiResponsesText(response, {
                text: "Private conversation",
                messageId: "incognito-title-message",
                responseId: "incognito-title-response",
              });
              return;
            }
            modelTurns += 1;
            writeOpenAiResponsesText(response, {
              text: `Private reply ${modelTurns}.`,
              messageId: `incognito-message-${modelTurns}`,
              responseId: `incognito-response-${modelTurns}`,
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
        name: "incognito-chat",
        provider: "incognito-fixture",
        identity: "Incognito fixture",
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
  it(
    "starts and continues an Incognito chat from the browser",
    (test) =>
      suite.runScenario(test, {
        retainedState: () => instance.stateDir,
        run: (signal) =>
          suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
            const wire = observeBackgroundWorkRpc(page, signal);
            await pairFixture(page, instance);
            await page.goto(`${suite.server.baseUrl}new`);
            await waitForControlUiGatewayReady(page);
            await assertServedUi(page, suite.server.baseUrl);
            await page.getByRole("switch", { name: "Incognito", exact: true }).click();
            await page.locator(".new-session-page__message").fill("First private message");
            await page.getByRole("button", { name: "Start session", exact: true }).click();

            const { pane, composer, send } = chatControls(page);
            // Live and persisted reply copies can overlap until the run settles.
            const reply = (text: string) =>
              pane
                .locator(".chat-bubble")
                .getByText(text, { exact: true })
                .last()
                .waitFor({ timeout: 60_000 });
            // New Session admits the first message through startup with an empty-root leaf.
            const startup = await wire.waitFor((rpc) => rpc.request.method === "chat.startup");
            expect(startup.response.ok).toBe(true);
            await reply("Private reply 1.");

            await composer.fill("Second private message");
            await send.click();
            await reply("Private reply 2.");
            const second = await wire.waitFor((rpc) => rpc.request.method === "chat.send");
            const sessionKey = (second.request.params as { sessionKey: string }).sessionKey;
            expect(isIncognitoSessionKey(sessionKey)).toBe(true);

            await composer.fill("Third private message");
            await send.click();
            await reply("Private reply 3.");
            await expect
              .poll(() => wire.completed.filter((rpc) => rpc.request.method === "chat.send").length)
              .toBe(2);

            const sends = wire.completed.filter((rpc) => rpc.request.method === "chat.send");
            expect(sends.map((rpc) => rpc.response.ok)).toEqual([true, true]);
            for (const rpc of sends) {
              expect(rpc.request.params).toMatchObject({
                sessionKey,
                expectedLeafEntryId: expect.any(String),
              });
            }
            expect(await pane.getByText("Not sent", { exact: true }).count()).toBe(0);
            expect(modelTurns).toBe(3);
          }),
      }),
    240_000,
  );
});
