import { once } from "node:events";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
  pauseVirtualClock,
} from "../test-helpers/control-ui-e2e.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const PAGE_URL = "https://startup.example/page";
const READY = JSON.stringify({
  type: "ready",
  targetId: "raw-startup",
  title: "Startup page",
  url: PAGE_URL,
});
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
      for (const stream of sockets) {
        stream.terminate();
      }
      for (const socket of connections) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => {
        streams.close(() => resolve());
      });
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function frame(jpeg: string, viewport: { cssWidth: number; cssHeight: number }): Buffer {
  const header = Buffer.from(JSON.stringify({ url: PAGE_URL, ...viewport }));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(header.length);
  return Buffer.concat([length, header, Buffer.from(jpeg, "base64")]);
}

suite.define(() => {
  it.each(["mint", "upgrade", "ready", "frame", "timeout"] as const)(
    "owns slow %s startup through the actual auxiliary WebSocket",
    async (phase) => {
      const fixture = await startStreamFixture(
        phase === "upgrade",
        phase === "frame" || phase === "timeout",
      );
      try {
        await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
          await page.route("**/__openclaw__/assistant-media**", (route) =>
            route.fulfill({
              contentType: "image/png",
              body: Buffer.from(
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
                "base64",
              ),
            }),
          );
          const minted = {
            token: "synthetic-startup",
            wsPath: fixture.url,
            targetId: "raw-startup",
            url: PAGE_URL,
          };
          const browserResponses = (viewport: { cssWidth: number; cssHeight: number }) => ({
            cases: [
              {
                match: { path: "/tabs" },
                response: {
                  running: true,
                  tabs: [
                    {
                      tabId: "tab-startup",
                      targetId: "raw-startup",
                      title: "Startup page",
                      url: PAGE_URL,
                    },
                  ],
                },
              },
              { match: { path: "/screencast" }, response: minted },
              {
                match: { path: "/screenshot" },
                response: {
                  path: "/synthetic-fallback.png",
                  targetId: "raw-startup",
                  url: PAGE_URL,
                },
              },
              {
                match: { path: "/act" },
                response: {
                  result: { ...viewport, title: "Startup page", url: PAGE_URL },
                },
              },
            ],
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
          await page.clock.install();
          await page.goto(`${suite.server.baseUrl}chat`);
          await page.getByText("Open the browser.", { exact: true }).waitFor();
          const jpeg = await page.evaluate(() => {
            const canvas = document.createElement("canvas");
            canvas.width = 80;
            canvas.height = 60;
            const context = canvas.getContext("2d");
            if (!context) {
              throw new Error("Canvas context unavailable");
            }
            context.fillStyle = "#2070b0";
            context.fillRect(0, 0, 80, 60);
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
          expect(
            await gateway.getRequests("browser.request", { path: "/screenshot" }),
          ).toHaveLength(0);
          expect(
            await gateway.getRequests("browser.request", { path: "/screencast" }),
          ).toHaveLength(1);
          const image = page.locator("section.bp .bp-shot");
          if (phase === "timeout") {
            await page.clock.runFor(30_000);
            await expect.poll(() => fixture.sockets[0]?.readyState).toBe(WebSocket.CLOSED);
            await image.waitFor();
            expect(await image.getAttribute("src")).toMatch(/^data:/);
            expect(
              await gateway.getRequests("browser.request", { path: "/screenshot" }),
            ).toHaveLength(1);
            await page.clock.runFor(10_000);
            await expect.poll(() => fixture.sockets.length).toBe(2);
            fixture.sockets[1]!.send(frame(jpeg, viewport));
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
            fixture.sockets[0]!.send(frame(jpeg, viewport));
          }
          await expect
            .poll(() =>
              image.evaluate((element) => {
                const rendered = element as HTMLImageElement;
                return (
                  rendered.src.startsWith("blob:") &&
                  rendered.complete &&
                  rendered.naturalWidth === 80
                );
              }),
            )
            .toBe(true);
          const src = await image.getAttribute("src");
          await page.clock.runFor(120_000);
          expect(await image.getAttribute("src")).toBe(src);
          expect(
            await gateway.getRequests("browser.request", { path: "/screenshot" }),
          ).toHaveLength(phase === "timeout" ? 1 : 0);
          expect(
            await gateway.getRequests("browser.request", { path: "/screencast" }),
          ).toHaveLength(phase === "timeout" ? 2 : 1);
          expect(await gateway.getRequests("connect")).toHaveLength(1);
        });
      } finally {
        await fixture.close();
      }
    },
  );
});
