// Only inference is synthetic: attachment storage, reconnect, chat.send, and history are real.
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { reserveTestPortListener } from "../../../src/test-utils/port-claims.ts";
import { writeOpenAiResponsesText } from "../../../test/helpers/openai-responses-sse.ts";
import type { OpenClawTestInstance } from "../../../test/helpers/openclaw-test-instance.ts";
import { createDeferred } from "../../../test/helpers/promise.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import { pairControlUiPage } from "../test-helpers/control-ui-browser-pairing.ts";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { controlUiSessionUrl } from "../test-helpers/control-ui-e2e.ts";
import {
  outboxAttachment,
  outboxPageOptions,
  outboxPaneFor,
  outboxPayloadFile,
  readOutboxQueue,
  sendOutboxMessage,
  stageOutboxAttachment,
} from "./chat-outbox-payloads.test-support.ts";
import {
  connectChatGateway,
  createChatGatewayInstance,
  runGatewayCli,
} from "./chat-real-gateway.test-support.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";
const sessionKey = "agent:main:attachment-reconnect-proof";
const message = "Real Gateway: reconnect attachment";
const reply = "Attachment reconnect proof complete.";

type RpcFrame = {
  method?: string;
  params?: Record<string, unknown>;
};

async function startProvider() {
  const requests: string[] = [];
  const reservation = await reserveTestPortListener({
    offsets: [0],
    createListener: () =>
      createServer((request, response) => {
        if (request.method !== "POST" || request.url !== "/v1/responses") {
          request.resume();
          response.writeHead(404).end();
          return;
        }
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk: string) => {
          body += chunk;
        });
        request.once("end", () => {
          requests.push(body);
          writeOpenAiResponsesText(response, {
            text: reply,
            messageId: `attachment-reconnect-message-${requests.length}`,
            responseId: `attachment-reconnect-response-${requests.length}`,
          });
        });
      }),
  });
  return {
    port: reservation.claim.port,
    requests,
    close: () => {
      reservation.listener.closeAllConnections();
      return runQaGatewayFixture(reservation.releaseListener, reservation.claim.release);
    },
  };
}

let instance: OpenClawTestInstance;
let client: Awaited<ReturnType<typeof connectChatGateway>>;
let provider: Awaited<ReturnType<typeof startProvider>>;
const suite = createControlUiE2eSuite({
  name: "Attachment reconnect through a real Gateway",
  startServerBeforeBrowser: true,
  resources: {
    async run(signal) {
      client = await connectChatGateway(instance, signal);
    },
    async close() {
      await client?.stopAndWait();
    },
  },
  async startServer() {
    provider = await startProvider();
    const cleanup = () =>
      runQaGatewayFixture(
        () => instance?.cleanup(),
        () => provider.close(),
      );
    try {
      instance = await createChatGatewayInstance({
        name: "attachment-reconnect-proof",
        provider: "attachment-reconnect-fixture",
        identity: "Attachment reconnect proof",
        model: "echo",
        apiKey: "synthetic-fixture-key",
        baseUrl: `http://127.0.0.1:${provider.port}/v1`,
        models: [{ id: "echo", name: "Attachment reconnect" }],
        agents: { ownership: "explicit" },
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
  it("delivers one intact attachment after reconnect replaces the browser client", async () => {
    await client.request("sessions.create", {
      key: sessionKey,
      agentId: "main",
      label: "Attachment reconnect proof",
    });
    await suite.withPage(
      { ...createControlUiE2eContextOptions(), ...outboxPageOptions },
      async ({ page }) => {
        await page.addInitScript(() => {
          const request = LockManager.prototype.request.bind(navigator.locks) as (
            ...values: unknown[]
          ) => Promise<unknown>;
          LockManager.prototype.request = function (this: LockManager, ...args: unknown[]) {
            const state = window as unknown as {
              delayOutboxLock?: boolean;
              outboxLockEntered?: boolean;
              releaseOutboxLock?: () => void;
            };
            if (!state.delayOutboxLock) {
              return request(...args);
            }
            state.delayOutboxLock = false;
            state.outboxLockEntered = true;
            return new Promise<void>((resolve) => {
              state.releaseOutboxLock = resolve;
            }).then(() => request(...args));
          } as typeof LockManager.prototype.request;
        });
        await pairControlUiPage(page, (args) => runGatewayCli(instance, args));

        const reconnectGate = createDeferred();
        onTestFinished(() => reconnectGate.resolve());
        const sends: RpcFrame[] = [];
        let connections = 0;
        const websocketOrigin = new URL(suite.server.baseUrl);
        websocketOrigin.protocol = "ws:";
        await page.routeWebSocket(`${websocketOrigin.origin}/**`, async (socket) => {
          connections += 1;
          if (connections > 1) {
            await reconnectGate.promise;
          }
          const server = socket.connectToServer();
          socket.onMessage((payload) => {
            const frame = JSON.parse(payload.toString()) as RpcFrame;
            if (frame.method === "chat.send") {
              sends.push(frame);
            }
            server.send(payload);
          });
          server.onMessage((payload) => socket.send(payload));
        });

        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        await waitForControlUiGatewayReady(page);
        await stageOutboxAttachment(page, message);
        await page.evaluate(() => {
          (window as unknown as { delayOutboxLock?: boolean }).delayOutboxLock = true;
        });

        await sendOutboxMessage(page);
        await page.waitForFunction(
          () => (window as unknown as { outboxLockEntered?: boolean }).outboxLockEntered === true,
        );

        await evaluateControlUiContext(page, (context) => context.gateway.connect());
        await expect.poll(() => connections).toBe(2);
        await page.evaluate(() => {
          const release = (window as unknown as { releaseOutboxLock?: () => void })
            .releaseOutboxLock;
          if (!release) {
            throw new Error("Outbox storage barrier was not installed");
          }
          release();
        });
        await expect.poll(async () => (await readOutboxQueue(page)).length).toBe(1);
        reconnectGate.resolve();

        await waitForControlUiGatewayReady(page);
        await expect.poll(() => sends.length, { timeout: 15_000 }).toBe(1);
        expect(sends[0]?.params).toEqual(
          expect.objectContaining({
            sessionKey,
            message,
            attachments: [outboxAttachment],
          }),
        );
        await expect.poll(() => provider.requests.length, { timeout: 15_000 }).toBe(1);
        expect(provider.requests[0]).toContain(message);
        expect(provider.requests[0]).toContain("Exact synthetic outbox bytes");
        await outboxPaneFor(page)
          .locator(".chat-group.assistant")
          .getByText(reply, { exact: true })
          .waitFor();
        await expect
          .poll(() => outboxPaneFor(page).locator(".chat-attachment-thumb").count())
          .toBe(0);

        let historyText = "";
        await expect
          .poll(async () => {
            historyText = JSON.stringify(await client.request("chat.history", { sessionKey }));
            return historyText.split(message).length - 1;
          })
          .toBe(1);
        expect(historyText).toContain(outboxPayloadFile.name);
        await page.waitForTimeout(1_000);
        expect(sends).toHaveLength(1);
        expect(provider.requests).toHaveLength(1);

        const proof = {
          schemaVersion: 1,
          gateway: "isolated real Gateway",
          provider: "scripted loopback transport; no external provider",
          attachment: {
            fileName: outboxPayloadFile.name,
            byteLength: outboxPayloadFile.buffer.length,
            sha256: createHash("sha256").update(outboxPayloadFile.buffer).digest("hex"),
          },
          chatSendFrames: sends.length,
          providerRequests: provider.requests.length,
          persistedUserMessages: historyText.split(message).length - 1,
          complete: true,
        };
        await writeFile(
          path.join(suite.artifactDir, "attachment-reconnect.public.json"),
          JSON.stringify(proof, null, 2) + "\n",
        );
        await page.screenshot({
          path: path.join(suite.artifactDir, "attachment-reconnect.png"),
          fullPage: true,
        });
        console.log("ATTACHMENT_RECONNECT_REAL_GATEWAY_PROOF", JSON.stringify(proof));
      },
    );
  }, 120_000);
});
