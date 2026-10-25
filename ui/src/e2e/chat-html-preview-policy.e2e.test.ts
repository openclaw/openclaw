import { createServer } from "node:http";
import { expect, it } from "vitest";
import { buildSandboxHostPath } from "../../../src/agents/sandbox-host.js";
import { CONTROL_UI_BOOTSTRAP_CONFIG_PATH } from "../../../src/gateway/control-ui-bootstrap-contract.js";
import { createSandboxHostHttpServer } from "../../../src/gateway/mcp-app-sandbox-http.js";
import {
  closeHttpServer,
  listenLoopback,
} from "../../../test/helpers/gateway-integration-fixtures.ts";
import { createDeferred } from "../../../test/helpers/promise.ts";
import type { ChatHtmlPreviewElement } from "../pages/chat/components/chat-html-preview-element.tsx";
import {
  createControlUiMockBootstrapConfig,
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { chatMessage } from "./chat-flow.test-support.ts";
import { fulfillWithControlUiCsp } from "./control-ui-csp.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "HTML preview resource boundary",
  startServerBeforeBrowser: true,
});

suite.define(() => {
  it("rejects descendant requests before network I/O in strict, scripts, and mode transitions", async (test) => {
    const received: string[] = [];
    const forbidden = createDeferred<never>();
    // Observe the rejection even if fixture startup fails before the first race.
    void forbidden.promise.catch(() => {});
    const receiver = createServer((request, response) => {
      received.push(request.url ?? "");
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end('<!doctype html><link rel="icon" href="data:,"><p>Controlled receiver</p>');
      if (request.url?.startsWith("/forbidden")) {
        forbidden.reject(new Error("Forbidden descendant reached the network receiver"));
      }
    });
    const sandbox = createSandboxHostHttpServer();
    await suite.runScenario(test, {
      run: async () => {
        const receiverOrigin = await listenLoopback(receiver);
        const sandboxOrigin = await listenLoopback(sandbox);
        const source = `<!doctype html><h1>Forbidden descendant</h1><iframe src="${receiverOrigin}/forbidden"></iframe>`;
        await suite.withPage(
          { serviceWorkers: "allow", permissions: ["local-network-access"] },
          async ({ context, page }) => {
            const control = await context.newPage();
            await control.goto(`${receiverOrigin}/control`);
            await control.close();
            expect(received).toEqual(["/control"]);
            const gateway = await installMockGateway(page, {
              workspace: "/workspace",
              featureMethods: [...defaultControlUiFeatureMethods, "canvas.document.preview"],
              historyMessages: [chatMessage("assistant", "Open [blocked](blocked.html).")],
              methodResponses: {
                "sessions.files.get": {
                  sessionKey: "agent:main:main",
                  file: {
                    name: "blocked.html",
                    path: "blocked.html",
                    content: source,
                    contentEncoding: "utf8",
                    kind: "read",
                    missing: false,
                    previewKind: "text",
                    mimeType: "text/html",
                  },
                },
                "canvas.document.preview": {
                  html: source,
                  sandboxUrl: buildSandboxHostPath({ blockDescendantFrames: true }),
                  sandboxPort: Number(new URL(sandboxOrigin).port),
                  sandboxOrigin,
                },
              },
            });
            await page.route("**" + CONTROL_UI_BOOTSTRAP_CONFIG_PATH, (route) =>
              route.fulfill({
                json: { ...createControlUiMockBootstrapConfig(), embedSandbox: "strict" },
              }),
            );
            await page.route(suite.server.baseUrl + "chat", (route) =>
              fulfillWithControlUiCsp(route, "Content-Security-Policy"),
            );
            await page.goto(suite.server.baseUrl + "chat");
            await gateway.waitForRequest("chat.startup");
            const preview = page.locator("openclaw-chat-html-preview");
            for (const [index, mode] of (["strict", "scripts", "strict"] as const).entries()) {
              const rejection = page.waitForEvent("pageerror", {
                predicate: (error) =>
                  error.message.includes("sandbox descendant browsing contexts are disabled"),
              });
              if (index === 0) {
                await page.locator('a.markdown-file-link[data-file-path="blocked.html"]').click();
              } else {
                await preview.evaluate((element: ChatHtmlPreviewElement, nextMode) => {
                  element.embedSandboxMode = nextMode;
                }, mode);
              }
              await Promise.race([rejection, forbidden.promise]);
              expect(received).toEqual(["/control"]);
              const outer = preview.locator("iframe");
              const inner = outer.contentFrame().locator("iframe");
              expect(await outer.getAttribute("srcdoc")).toBeNull();
              expect(await inner.getAttribute("srcdoc")).toBeNull();
            }
            expect(await gateway.getRequests("canvas.document.preview")).toHaveLength(1);
            expect(await gateway.getRequests("canvas.document.view")).toEqual([]);
          },
        );
      },
      close: async () => {
        await Promise.all([closeHttpServer(receiver), closeHttpServer(sandbox)]);
      },
    });
  });
});
