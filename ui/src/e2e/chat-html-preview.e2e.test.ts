// Uses the real isolated sandbox listener with deterministic Gateway file data.
import type { Server } from "node:http";
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
  name: "HTML file tab sandbox",
  startServerBeforeBrowser: true,
});
const source = `<!doctype html>
<html><head><style>body{font:16px system-ui;padding:20px}h1{color:rgb(12, 34, 56)}</style></head>
<body><h1>Local HTML page</h1><button id="count">Count</button><output id="value">0</output>
<input aria-label="Local note"><script>
let count=0;document.querySelector('#count').onclick=()=>document.querySelector('#value').textContent=String(++count);
</script></body></html>`;
const editedSource = source.replace("Local HTML page", "Unsaved HTML draft");

async function listen(server: Server): Promise<number> {
  return await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Sandbox listener unavailable"));
      } else {
        resolve(address.port);
      }
    });
  });
}

suite.define(() => {
  for (const mode of ["scripts", "strict"] as const) {
    it(`renders HTML with ${mode} and retains Source in the same file tab`, async (test) => {
      let sandbox: Server | undefined;
      await suite.runScenario(test, {
        run: async () => {
          sandbox = createSandboxHostHttpServer();
          const sandboxPort = await listen(sandbox);
          const sandboxUrl = buildSandboxHostPath({ blockDescendantFrames: true });
          await suite.withPage(
            {
              viewport: { width: 1440, height: 1000 },
              serviceWorkers: "block",
              permissions: ["local-network-access"],
            },
            async ({ page }) => {
              const mediaUrl =
                "/__openclaw__/assistant-media?source=attachment.htm&mediaTicket=html-preview";
              await page.route("**/__openclaw__/assistant-media?**", (route) =>
                route.fulfill({
                  contentType: "text/html; charset=utf-8",
                  body: source,
                  headers: { "Content-Disposition": 'attachment; filename="attachment.htm"' },
                }),
              );
              const view = (html: string) => ({
                html,
                sandboxUrl,
                sandboxPort,
                sandboxOrigin: `http://127.0.0.1:${sandboxPort}`,
              });
              const gateway = await installMockGateway(page, {
                workspace: "/workspace",
                featureMethods: [
                  ...defaultControlUiFeatureMethods,
                  "sessions.files.set",
                  "canvas.document.preview",
                ],
                historyMessages: [
                  {
                    role: "assistant",
                    timestamp: Date.now(),
                    content: [
                      { type: "text", text: "Open [page](page.html) or [line two](page.html:2)." },
                      {
                        type: "attachment",
                        attachment: {
                          kind: "document",
                          label: "attachment.htm",
                          mimeType: "text/html",
                          url: mediaUrl,
                        },
                      },
                    ],
                  },
                ],
                methodResponses: {
                  "sessions.files.get": {
                    root: "/workspace",
                    sessionKey: "agent:main:main",
                    file: {
                      name: "page.html",
                      path: "page.html",
                      workspacePath: "page.html",
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
                    cases: [
                      { match: { html: source }, response: view(source) },
                      { match: { html: editedSource }, response: view(editedSource) },
                    ],
                  },
                },
              });
              // Exercise the production app CSP, not a srcdoc demo that accidentally
              // permits scripts only because a dev server omitted the app policy.
              await page.route(`${suite.server.baseUrl}chat`, async (route) => {
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
              if (mode === "strict") {
                await page.route(`**${CONTROL_UI_BOOTSTRAP_CONFIG_PATH}`, async (route) => {
                  await route.fulfill({
                    json: { ...createControlUiMockBootstrapConfig(), embedSandbox: "strict" },
                  });
                });
              }
              await page.goto(`${suite.server.baseUrl}chat`);
              await gateway.waitForRequest("chat.startup");
              await page
                .locator('a.markdown-file-link[data-file-path="page.html"]')
                .filter({ hasText: /^page$/ })
                .click();
              const panel = page.locator("openclaw-chat-detail-panel:visible");
              const outer = panel.locator(".chat-html-preview__frame");
              await outer.waitFor();
              const document = outer.contentFrame().frameLocator("iframe");
              await document.getByRole("heading", { name: "Local HTML page" }).waitFor();
              await panel
                .locator("openclaw-chat-html-preview [role=status]")
                .waitFor({ state: "hidden" });
              expect(await outer.contentFrame().locator("iframe").getAttribute("sandbox")).toBe(
                mode === "strict" ? "" : "allow-scripts allow-forms",
              );
              expect(
                await document.locator("h1").evaluate((heading) => getComputedStyle(heading).color),
              ).toBe("rgb(12, 34, 56)");
              await document.getByRole("button", { name: "Count", exact: true }).click();
              expect(await document.locator("output").textContent()).toBe(
                mode === "strict" ? "0" : "1",
              );
              expect(await panel.locator(".cm-editor").count()).toBe(0);
              const tab = page
                .locator(".side-panel__header wa-tab")
                .filter({ hasText: "page.html" });
              expect(await tab.count()).toBe(1);
              const originalFrame = await outer.elementHandle();
              if (mode === "scripts") {
                const isolation = await document.locator("body").evaluate(() => {
                  let topDenied = false;
                  try {
                    void window.top?.document;
                  } catch {
                    topDenied = true;
                  }
                  return { topDenied, api: typeof Reflect.get(window, "openclaw") };
                });
                expect(isolation).toEqual({ topDenied: true, api: "undefined" });
              }
              await document.getByRole("textbox", { name: "Local note" }).fill("Retain this page");
              await panel.getByRole("button", { name: "Source", exact: true }).click();
              await panel.locator(".cm-editor").waitFor();
              const editor = await panel.locator(".cm-editor").elementHandle();
              await panel.getByRole("button", { name: "Preview", exact: true }).click();
              expect(await originalFrame!.evaluate((frame) => frame.isConnected)).toBe(true);
              expect(await document.getByRole("textbox", { name: "Local note" }).inputValue()).toBe(
                "Retain this page",
              );
              await page
                .getByRole("button", { name: "Open attachment.htm in the side panel", exact: true })
                .click();
              await outer.waitFor();
              const attachmentDocument = outer.contentFrame().frameLocator("iframe");
              await attachmentDocument.getByRole("heading", { name: "Local HTML page" }).waitFor();
              const attachmentFrame = await outer.elementHandle();
              await panel.getByRole("button", { name: "Source", exact: true }).click();
              expect(await panel.locator("pre:visible").textContent()).toBe(source);
              expect(await panel.locator("a[download]").getAttribute("href")).toBe(mediaUrl);
              await tab.click();
              expect(await originalFrame!.evaluate((frame) => frame.isConnected)).toBe(true);
              expect(await attachmentFrame!.evaluate((frame) => frame.isConnected)).toBe(true);
              expect(await document.getByRole("textbox", { name: "Local note" }).inputValue()).toBe(
                "Retain this page",
              );
              await panel.getByRole("button", { name: "Edit file", exact: true }).click();
              await panel.locator('.cm-content[contenteditable="true"]').fill(editedSource);
              await panel.getByRole("button", { name: "Preview", exact: true }).click();
              await document.getByRole("heading", { name: "Unsaved HTML draft" }).waitFor();
              expect(await gateway.getRequests("sessions.files.set")).toEqual([]);
              await panel.getByRole("button", { name: "Source", exact: true }).click();
              expect(await editor!.evaluate((element) => element.isConnected)).toBe(true);
              expect(await panel.locator(".cm-content").textContent()).toContain(
                "Unsaved HTML draft",
              );
              expect(
                await panel.getByRole("button", { name: "Save", exact: true }).isEnabled(),
              ).toBe(true);
              await panel.getByRole("button", { name: "Preview", exact: true }).click();
              await page.locator("a.markdown-file-link").filter({ hasText: "line two" }).click();
              await panel.locator(".cm-editor:visible").waitFor();
              expect(
                await panel.locator(".file-view__line--target").getAttribute("data-line"),
              ).toBe("2");
              expect(await panel.locator(".cm-content").textContent()).toContain(
                "Unsaved HTML draft",
              );
              expect(await tab.count()).toBe(1);
              expect(await gateway.getRequests("canvas.document.view")).toEqual([]);
              expect(await gateway.getRequests("wake")).toEqual([]);
              expect(await gateway.getRequests("chat.send")).toEqual([]);
            },
          );
        },
        close: async () => {
          if (sandbox) {
            sandbox.closeAllConnections();
            await new Promise<void>((resolve, reject) => {
              sandbox!.close((error) => (error ? reject(error) : resolve()));
            });
          }
        },
      });
    });
  }
});
