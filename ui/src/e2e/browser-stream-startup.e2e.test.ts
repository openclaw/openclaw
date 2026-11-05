import { once } from "node:events";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { createSolidPngBuffer } from "../../../test/helpers/image-fixtures.ts";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
  pauseVirtualClock,
} from "../test-helpers/control-ui-e2e.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const resource = { targetId: "raw-startup", url: "https://startup.example/page" };
const pageInfo = { ...resource, title: "Startup page" };
const fallbackPng = createSolidPngBuffer(1, 1, { r: 0, g: 0, b: 0 });
type Viewport = { cssWidth: number; cssHeight: number };
const READY = JSON.stringify({ type: "ready", ...pageInfo });
const suite = createControlUiE2eSuite({
  name: "Control UI browser stream startup",
  startServerBeforeBrowser: true,
});

async function startStreamFixture(holdUpgrade: boolean, sendReady: boolean) {
  const sockets: WebSocket[] = [];
  const connections = new Set<Socket>();
  const upgrades: Array<() => void> = [];
  const server = createServer((_request, response) => response.writeHead(404).end());
  const streams = new WebSocketServer({ noServer: true });
  server.on("connection", (socket) => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
  });
  server.on("upgrade", (request, socket, head) => {
    const upgrade = () =>
      streams.handleUpgrade(request, socket, head, (stream) => {
        sockets.push(stream);
        if (sendReady) {
          stream.send(READY);
        }
      });
    if (holdUpgrade) {
      upgrades.push(upgrade);
    } else {
      upgrade();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  expect.assert(address !== null && typeof address !== "string");
  return {
    url: `ws://127.0.0.1:${address.port}/screencast`,
    sockets,
    upgrades,
    async close() {
      sockets.forEach((stream) => stream.terminate());
      connections.forEach((socket) => socket.destroy());
      await new Promise<void>((resolve) => {
        streams.close(() => resolve());
      });
      await promisify(server.close.bind(server))();
    },
  };
}

function frame(jpeg: string, viewport: Viewport): Buffer {
  const header = Buffer.from(JSON.stringify({ url: resource.url, ...viewport }));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(header.length);
  return Buffer.concat([length, header, Buffer.from(jpeg, "base64")]);
}

suite.define(() => {
  it.each(["mint", "upgrade", "ready", "frame", "timeout"] as const)(
    "owns slow %s startup through the actual auxiliary WebSocket",
    async (phase) => {
      const timeout = phase === "timeout";
      const ready = phase === "frame" || timeout;
      const fixture = await startStreamFixture(phase === "upgrade", ready);
      try {
        await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
          await page.route("**/__openclaw__/assistant-media**", (route) =>
            route.fulfill({ contentType: "image/png", body: fallbackPng }),
          );
          const minted = { token: "synthetic-startup", wsPath: fixture.url, ...resource };
          const browserResponses = (viewport: Viewport) => ({
            cases: Object.entries({
              "/tabs": { running: true, tabs: [{ tabId: "tab-startup", ...pageInfo }] },
              "/screencast": minted,
              "/screenshot": { path: "/synthetic-fallback.png", ...resource },
              "/act": { result: { ...viewport, title: pageInfo.title, url: resource.url } },
            }).map(([path, response]) => ({ match: { path }, response })),
          });
          const gateway = await installMockGateway(page, {
            featureMethods: [...defaultControlUiFeatureMethods, "browser.request"],
            operatorScopes: ["operator.admin", "operator.read", "operator.write"],
            webSocketPassthroughPrefixes: [fixture.url],
            historyMessages: [{ role: "assistant", content: "Open the browser." }],
            methodResponses: {
              "browser.request": browserResponses({ cssWidth: 80, cssHeight: 60 }),
            },
          });
          const requestCount = async (path: string) =>
            (await gateway.getRequests("browser.request", { path })).length;
          await page.clock.install();
          await page.goto(`${suite.server.baseUrl}chat`);
          await page.getByText("Open the browser.", { exact: true }).waitFor();
          const jpeg = await page.evaluate(() => {
            const canvas = document.createElement("canvas");
            canvas.width = 80;
            canvas.height = 60;
            return canvas.toDataURL("image/jpeg").split(",")[1]!;
          });
          if (phase === "mint") {
            await gateway.deferNext("browser.request", { path: "/screencast" });
          }
          await openChatSidePanelType(page, "Browser");
          await gateway.waitForRequest("browser.request", { match: { path: "/screencast" } });
          await pauseVirtualClock(page);
          await page.clock.runFor(1);
          const viewport = await page.locator("section.bp .bp-viewport").evaluate((element) => ({
            cssWidth: element.clientWidth,
            cssHeight: element.clientHeight,
          }));
          await gateway.setMethodResponse("browser.request", browserResponses(viewport));
          if (phase === "upgrade") {
            await expect.poll(() => fixture.upgrades.length).toBe(1);
          } else if (phase !== "mint") {
            await expect.poll(() => fixture.sockets.length).toBe(1);
          }
          await page.clock.runFor(2000);
          expect(await requestCount("/screenshot")).toBe(0);
          expect(await requestCount("/screencast")).toBe(1);
          const image = page.locator("section.bp .bp-shot");
          if (timeout) {
            await page.clock.runFor(30_000);
            await expect.poll(() => fixture.sockets[0]?.readyState).toBe(WebSocket.CLOSED);
            await image.waitFor();
            expect(await image.getAttribute("src")).toMatch(/^data:/);
            expect(await requestCount("/screenshot")).toBe(1);
            await page.clock.runFor(10_000);
            await expect.poll(() => fixture.sockets.length).toBe(2);
          } else {
            if (phase === "mint") {
              await gateway.resolveDeferred("browser.request", minted);
            }
            if (phase === "upgrade") {
              fixture.upgrades[0]!();
            }
            await expect.poll(() => fixture.sockets.length).toBe(1);
            if (phase !== "frame") {
              fixture.sockets[0]!.send(READY);
            }
          }
          fixture.sockets[timeout ? 1 : 0]!.send(frame(jpeg, viewport));
          await expect
            .poll(() =>
              image.evaluate((element: HTMLImageElement) => ({
                blob: element.src.startsWith("blob:"),
                complete: element.complete,
                width: element.naturalWidth,
              })),
            )
            .toEqual({ blob: true, complete: true, width: 80 });
          const src = await image.getAttribute("src");
          await page.clock.runFor(120_000);
          expect(await image.getAttribute("src")).toBe(src);
          expect(await requestCount("/screenshot")).toBe(timeout ? 1 : 0);
          expect(await requestCount("/screencast")).toBe(timeout ? 2 : 1);
          expect(await gateway.getRequests("connect")).toHaveLength(1);
        });
      } finally {
        await fixture.close();
      }
    },
  );
});
