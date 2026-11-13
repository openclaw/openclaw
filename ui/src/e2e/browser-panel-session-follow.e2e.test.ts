import { once } from "node:events";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { expectRequestCountStable } from "./chat-flow.test-support.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI browser panel session follow",
  startServerBeforeBrowser: true,
});

const pages = {
  a: { targetId: "raw-a", title: "Page A", url: "https://a.example/" },
  b: { targetId: "raw-b", title: "Page B", url: "https://b.example/" },
};
const browserTab = (page: (typeof pages)[keyof typeof pages]) => ({
  target: "host",
  profile: "managed",
  targetId: page.targetId,
  url: page.url,
});

async function startStreams() {
  const sockets: WebSocket[] = [];
  const server = createServer((_request, response) => response.writeHead(404).end());
  const streams = new WebSocketServer({ server });
  streams.on("connection", (socket) => sockets.push(socket));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  expect.assert(address !== null && typeof address !== "string");
  return {
    url: `ws://127.0.0.1:${address.port}/screencast`,
    sockets,
    async close() {
      sockets.forEach((socket) => socket.terminate());
      await new Promise<void>((resolve) => {
        streams.close(() => resolve());
      });
      await promisify(server.close.bind(server))();
    },
  };
}

function frame(jpeg: string, url: string): Buffer {
  const header = Buffer.from(JSON.stringify({ url, cssWidth: 80, cssHeight: 60 }));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(header.length);
  return Buffer.concat([length, header, Buffer.from(jpeg, "base64")]);
}

suite.define(() => {
  it.each([
    ["the same tab", pages.a],
    ["another tab", pages.b],
  ])("follows a new agent result for %s", async (_case, next) => {
    const streams = await startStreams();
    try {
      await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
        const gateway = await installMockGateway(page, {
          featureMethods: [...defaultControlUiFeatureMethods, "browser.request"],
          operatorScopes: ["operator.admin", "operator.read", "operator.write"],
          webSocketPassthroughPrefixes: [streams.url],
          historyMessages: [
            { role: "user", content: "Open page A", timestamp: 1_000 },
            {
              role: "toolResult",
              toolName: "browser",
              toolCallId: "open-a",
              timestamp: 2_000,
              content: "Opened",
              isError: false,
              details: { browserTab: browserTab(pages.a) },
            },
            { role: "assistant", content: "Page A is open.", timestamp: 3_000 },
          ],
          methodResponses: {
            "browser.request": {
              cases: Object.entries({
                "/tabs": {
                  running: true,
                  tabs: [
                    { tabId: "t1", ...pages.a },
                    { tabId: "t2", ...pages.b },
                  ],
                },
                "/screencast": { token: "synthetic", wsPath: streams.url, ...pages.a },
                "/screenshot": { path: "/synthetic.png", ...pages.a },
                "/act": { result: { cssWidth: 80, cssHeight: 60, ...pages.a } },
              }).map(([path, response]) => ({ match: { path }, response })),
            },
          },
        });
        const screencasts = async () =>
          (await gateway.getRequests("browser.request", { path: "/screencast" })).map(
            (request) => asNullableRecord(asNullableRecord(request.params)?.body)?.targetId,
          );
        await page.goto(`${suite.server.baseUrl}chat`);
        await page.getByText("Page A is open.", { exact: true }).waitFor();
        const jpeg = await page.evaluate(() => {
          const canvas = document.createElement("canvas");
          canvas.width = 80;
          canvas.height = 60;
          return canvas.toDataURL("image/jpeg").split(",")[1]!;
        });
        await openChatSidePanelType(page, "Browser");
        await expect.poll(() => streams.sockets.length).toBe(1);
        streams.sockets[0]!.send(frame(jpeg, pages.a.url));
        const shot = page.locator("section.bp .bp-shot");
        await expect.poll(() => shot.getAttribute("src")).toMatch(/^blob:/);
        expect(await screencasts()).toEqual(["t1"]);

        await page.locator(".agent-chat__input textarea").fill("Keep going");
        await page.getByRole("button", { name: "Send message" }).click();
        const send = await gateway.waitForRequest("chat.send");
        const runId = asNullableRecord(send.params)?.idempotencyKey;
        expect.assert(typeof runId === "string");
        const cards = page.locator("openclaw-browser-tab-card");
        const cardsBefore = await cards.count();
        let seq = 0;
        for (const data of [
          { phase: "start", toolCallId: "act-1", name: "browser", args: {} },
          {
            phase: "result",
            toolCallId: "act-1",
            name: "browser",
            result: {
              content: [{ type: "text", text: "Clicked" }],
              details: { browserTab: browserTab(next) },
            },
          },
        ]) {
          await gateway.emitGatewayEvent("agent", {
            runId,
            seq: ++seq,
            stream: "tool",
            ts: Date.now(),
            sessionKey: "main",
            data,
          });
        }
        // The result's card shows the chat has the new revision the panel follows.
        await expect.poll(() => cards.count()).toBe(cardsBefore + 1);

        if (next === pages.a) {
          await expectRequestCountStable(gateway, "browser.request", 1, 1_000, {
            path: "/screencast",
          });
          expect(streams.sockets).toHaveLength(1);
          expect(streams.sockets[0]!.readyState).toBe(WebSocket.OPEN);
          expect(await shot.getAttribute("src")).toMatch(/^blob:/);
          expect(await page.locator("section.bp .bp-stage").count()).toBe(1);
          expect(await page.locator("section.bp .empty-state").count()).toBe(0);
          return;
        }
        await expect.poll(screencasts).toEqual(["t1", "t2"]);
        await expect.poll(() => streams.sockets[0]!.readyState).toBe(WebSocket.CLOSED);
        await expect.poll(() => streams.sockets.length).toBe(2);
        streams.sockets[1]!.send(frame(jpeg, pages.b.url));
        await expect
          .poll(() => page.locator("section.bp .bp-shot").getAttribute("src"))
          .toMatch(/^blob:/);
      });
    } finally {
      await streams.close();
    }
  });
});
