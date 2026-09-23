import { writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { expect, it } from "vitest";
import { buildSandboxHostPath } from "../../../src/agents/sandbox-host.js";
import { CONTROL_UI_BOOTSTRAP_CONFIG_PATH } from "../../../src/gateway/control-ui-bootstrap-contract.js";
import {
  buildControlUiCspHeader,
  computeInlineScriptHashes,
} from "../../../src/gateway/control-ui-csp.js";
import { createSandboxHostHttpServer } from "../../../src/gateway/mcp-app-sandbox-http.js";
import {
  createControlUiMockBootstrapConfig,
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "HTML preview resource boundary",
  startServerBeforeBrowser: true,
});
async function listen(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Missing listener address");
  }
  return address.port;
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

suite.define(() => {
  it("rejects descendant requests before network I/O in strict, scripts, and mode transitions", async (test) => {
    const received: string[] = [];
    const rejectedModes: string[] = [];
    const diagnostics: string[] = [];
    let rejectNetwork!: (error: Error) => void;
    const forbiddenRequest = new Promise<never>((_resolve, reject) => {
      rejectNetwork = reject;
    });
    // Observe the rejection even if fixture startup fails before the first race.
    void forbiddenRequest.catch(() => {});
    const receiver = createServer((request, response) => {
      const target = request.url ?? "";
      received.push(target);
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end('<!doctype html><link rel="icon" href="data:,"><p>Controlled receiver</p>');
      if (target.startsWith("/forbidden")) {
        rejectNetwork(new Error("Forbidden descendant reached the network receiver"));
      }
    });
    const sandbox = createSandboxHostHttpServer();
    await suite.runScenario(test, {
      run: async () => {
        const receiverPort = await listen(receiver);
        const sandboxPort = await listen(sandbox);
        const sandboxUrl = buildSandboxHostPath({ blockDescendantFrames: true });
        const source =
          '<!doctype html><h1>Forbidden descendant</h1><iframe src="http://127.0.0.1:' +
          receiverPort +
          '/forbidden"></iframe>';
        await suite.withPage(
          { serviceWorkers: "allow", permissions: ["local-network-access"] },
          async ({ context, page }) => {
            const control = await context.newPage();
            await control.goto("http://127.0.0.1:" + receiverPort + "/control");
            await control.close();
            expect(received).toEqual(["/control"]);
            page.on("pageerror", (error) => diagnostics.push(error.message));
            const gateway = await installMockGateway(page, {
              workspace: "/workspace",
              featureMethods: [...defaultControlUiFeatureMethods, "canvas.document.preview"],
              historyMessages: [
                {
                  role: "assistant",
                  content: [{ type: "text", text: "Open [blocked](blocked.html)." }],
                },
              ],
              methodResponses: {
                "sessions.files.get": {
                  root: "/workspace",
                  sessionKey: "agent:main:main",
                  file: {
                    name: "blocked.html",
                    path: "blocked.html",
                    workspacePath: "blocked.html",
                    content: source,
                    contentEncoding: "utf8",
                    hash: "a".repeat(64),
                    kind: "read",
                    missing: false,
                    previewKind: "text",
                    mimeType: "text/html",
                    size: Buffer.byteLength(source),
                  },
                },
                "canvas.document.preview": {
                  html: source,
                  sandboxUrl,
                  sandboxPort,
                  sandboxOrigin: "http://127.0.0.1:" + sandboxPort,
                },
              },
            });
            await page.route("**" + CONTROL_UI_BOOTSTRAP_CONFIG_PATH, (route) =>
              route.fulfill({
                json: { ...createControlUiMockBootstrapConfig(), embedSandbox: "strict" },
              }),
            );
            await page.route(suite.server.baseUrl + "chat", async (route) => {
              const response = await route.fetch();
              const body = await response.text();
              await route.fulfill({
                response,
                body,
                headers: {
                  ...response.headers(),
                  "Content-Security-Policy": buildControlUiCspHeader({
                    inlineScriptHashes: computeInlineScriptHashes(body),
                  }),
                },
              });
            });
            await page.goto(suite.server.baseUrl + "chat");
            await gateway.waitForRequest("chat.startup");
            const preview = page.locator("openclaw-chat-html-preview");
            for (const mode of ["strict", "scripts", "strict"] as const) {
              const rejection = page.waitForEvent("pageerror", {
                predicate: (error) =>
                  error.message.includes("sandbox descendant browsing contexts are disabled"),
              });
              if (rejectedModes.length === 0) {
                await page.locator('a.markdown-file-link[data-file-path="blocked.html"]').click();
              } else {
                await preview.evaluate((_element, nextMode) => {
                  const current = document.querySelector("openclaw-chat-html-preview");
                  if (!current) {
                    throw new Error("Preview disappeared");
                  }
                  current.embedSandboxMode = nextMode;
                }, mode);
              }
              await Promise.race([rejection, forbiddenRequest]);
              rejectedModes.push(mode);
              expect(received).toEqual(["/control"]);
              const outer = preview.locator("iframe");
              expect(await outer.getAttribute("srcdoc")).toBeNull();
              const inner = outer.contentFrame().locator("iframe");
              expect(await inner.getAttribute("srcdoc")).toBeNull();
            }
            expect(await gateway.getRequests("canvas.document.preview")).toHaveLength(1);
            expect(await gateway.getRequests("canvas.document.view")).toEqual([]);
          },
        );
      },
      close: async () => {
        await writeFile(
          path.join(suite.artifactDir, "resource-boundary.json"),
          JSON.stringify({ received, rejectedModes, diagnostics }, null, 2),
        );
        await Promise.all([close(receiver), close(sandbox)]);
      },
    });
  });
});
