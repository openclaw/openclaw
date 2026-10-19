import type { Server } from "node:http";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { buildSandboxHostPath } from "../../../src/agents/sandbox-host.js";
import { CONTROL_UI_BOOTSTRAP_CONFIG_PATH } from "../../../src/gateway/control-ui-bootstrap-contract.js";
import {
  buildControlUiCspHeader,
  computeInlineScriptHashes,
} from "../../../src/gateway/control-ui-csp.js";
import { createSandboxHostHttpServer } from "../../../src/gateway/mcp-app-sandbox-http.js";
import {
  closeHttpServer,
  listenLoopback,
} from "../../../test/helpers/gateway-integration-fixtures.ts";
import {
  createControlUiMockBootstrapConfig,
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { exactButton, newChatPage } from "./chat-flow.test-support.ts";
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
</script><nav><a href="#discrepancies">Jump to discrepancies</a>
<a href=" \t\n#discrepancies">Whitespace section</a>
<a href="#雪">Unicode section</a><a href="#%E9%9B%AA">Encoded section</a>
<a href="#legacy">Named anchor</a><a href="#">Back to top</a></nav>
<section style="margin-top:1800px;padding-bottom:1200px"><h2 id="discrepancies">Discrepancies</h2>
<h2 id="雪">Snow</h2><a name="legacy">Legacy section</a></section></body></html>`;
const editedSource = source.replace("Local HTML page", "Unsaved HTML draft");
// Self-contained reports with embedded data exceed the generic text-preview budget.
const attachmentSource = `${source}<!--${"x".repeat(1_700_000)}-->`;

async function withSandbox(
  test: Parameters<typeof suite.runScenario>[0],
  run: (page: Page, port: number) => Promise<void>,
) {
  let sandbox: Server | undefined;
  await suite.runScenario(test, {
    run: async () => {
      sandbox = createSandboxHostHttpServer();
      const port = Number(new URL(await listenLoopback(sandbox)).port);
      const page = await newChatPage(suite, {
        serviceWorkers: "block",
        permissions: ["local-network-access"],
      });
      await run(page, port);
    },
    close: async () => {
      if (sandbox) {
        await closeHttpServer(sandbox);
      }
    },
  });
}

function preview(html: string, sandboxPort: number) {
  return {
    html,
    sandboxUrl: buildSandboxHostPath({ blockDescendantFrames: true }),
    sandboxPort,
    sandboxOrigin: `http://127.0.0.1:${sandboxPort}`,
  };
}

function installFileGateway(
  page: Page,
  content: string,
  options: Parameters<typeof installMockGateway>[1],
) {
  return installMockGateway(page, {
    workspace: "/workspace",
    historyMessages: [{ role: "assistant", content: "Open [page](page.html)." }],
    ...options,
    featureMethods: [
      ...defaultControlUiFeatureMethods,
      "canvas.document.preview",
      ...(options.featureMethods ?? []),
    ],
    methodResponses: {
      "sessions.files.get": {
        root: "/workspace",
        sessionKey: "agent:main:main",
        file: {
          name: "page.html",
          path: "page.html",
          content,
          contentEncoding: "utf8",
          hash: "a".repeat(64),
          kind: "read",
          missing: false,
          previewKind: "text",
          mimeType: "text/html",
        },
      },
      ...options.methodResponses,
    },
  });
}

async function openHtmlFile(page: Page, gateway: Awaited<ReturnType<typeof installMockGateway>>) {
  await page.goto(`${suite.server.baseUrl}chat`);
  await gateway.waitForRequest("chat.startup");
  await page
    .locator('a.markdown-file-link[data-file-path="page.html"]')
    .filter({ hasText: /^page$/ })
    .click();
  const panel = page.locator("openclaw-chat-detail-panel:visible");
  const outer = panel.locator(".chat-html-preview__frame");
  await outer.waitFor();
  await panel.locator("openclaw-chat-html-preview [role=status]").waitFor({ state: "hidden" });
  return { panel, outer, document: outer.contentFrame().frameLocator("iframe") };
}

suite.define(() => {
  it("keeps deferred classic and module file scripts in document order in the sandbox", async (test) => {
    const scripts = {
      "blocking.js":
        'document.documentElement.dataset.blockingSawApp = String(Boolean(document.querySelector("#app")));',
      "setup.js": 'window.previewState = "ready";',
      "render.js":
        'var previewApp = document.querySelector("#app"); function previewSuffix() { return this === window ? " in order" : " strict"; } previewApp.textContent = window.previewState + " " + String(Boolean(document.querySelector("#app")));',
      "after.js": "previewApp.textContent += (0, window.previewSuffix)();",
    };
    const html =
      '<!doctype html><html><head><script src="blocking.js"></script><script type="module" src="setup.js"></script><script defer src="render.js"></script><script defer src="after.js"></script></head><body><div id="app">waiting</div></body></html>';
    await withSandbox(test, async (page, sandboxPort) => {
      const gateway = await installFileGateway(page, html, {
        featureMethods: ["sessions.files.assets"],
        methodResponses: {
          "canvas.document.preview": preview(html, sandboxPort),
          "sessions.files.assets": {
            assets: Object.entries(scripts).map(([ref, code]) => ({
              ref,
              mimeType: "text/javascript",
              content: Buffer.from(code).toString("base64"),
            })),
          },
        },
      });
      const { document } = await openHtmlFile(page, gateway);
      expect(await gateway.getRequests("sessions.files.assets")).toMatchObject([
        { params: { path: "page.html", refs: Object.keys(scripts) } },
      ]);
      expect(await document.locator("html").getAttribute("data-blocking-saw-app")).toBe("false");
      expect(await document.locator("#app").textContent()).toBe("ready true in order");
    });
  });

  it.each(["scripts", "strict"] as const)(
    "renders HTML with %s and retains Source in the same file tab",
    async (mode, test) => {
      await withSandbox(test, async (page, sandboxPort) => {
        await page.setViewportSize({ width: 1440, height: 1000 });
        const mediaUrl =
          "/__openclaw__/assistant-media?source=attachment.htm&mediaTicket=html-preview";
        await page.route("**/__openclaw__/assistant-media?**", (route) =>
          route.fulfill({
            contentType: "text/html; charset=utf-8",
            body: attachmentSource,
            headers: { "Content-Disposition": 'attachment; filename="attachment.htm"' },
          }),
        );
        const gateway = await installFileGateway(page, source, {
          featureMethods: ["sessions.files.set"],
          historyMessages: [
            {
              role: "assistant",
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
            "canvas.document.preview": {
              cases: [source, editedSource, attachmentSource].map((html) => ({
                match: { html },
                response: preview(html, sandboxPort),
              })),
            },
          },
        });
        // The dev server omits the production CSP; enforce it for this sandbox proof.
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
        const { panel, outer, document } = await openHtmlFile(page, gateway);
        const button = (name: string) => exactButton(panel, name);
        await document.getByRole("heading", { name: "Local HTML page" }).waitFor();
        expect(await outer.contentFrame().locator("iframe").getAttribute("sandbox")).toBe(
          mode === "strict" ? "" : "allow-scripts allow-forms",
        );
        expect(
          await document.locator("h1").evaluate((heading) => getComputedStyle(heading).color),
        ).toBe("rgb(12, 34, 56)");
        await document.getByRole("button", { name: "Count", exact: true }).click();
        expect(await document.locator("output").textContent()).toBe(mode === "strict" ? "0" : "1");
        const tab = page
          .locator(".side-panel__header .tabstrip-tab")
          .filter({ hasText: "page.html" });
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
        const note = document.getByRole("textbox", { name: "Local note" });
        const expectNote = async () => expect(await note.inputValue()).toBe("Retain this page");
        await note.fill("Retain this page");
        const heading = document.getByRole("heading", { name: "Local HTML page" });
        const originalHeading = await heading.elementHandle();
        const expectHeading = async () => {
          expect(
            await heading.evaluate((element, original) => element === original, originalHeading),
          ).toBe(true);
        };
        for (const [name, selector] of [
          ["Jump to discrepancies", "#discrepancies"],
          ["Whitespace section", "#discrepancies"],
          ["Unicode section", "#雪"],
          ["Encoded section", "#雪"],
          ["Named anchor", '[name="legacy"]'],
        ]) {
          await document.getByRole("link", { name, exact: true }).click();
          await expect
            .poll(() =>
              document.locator(selector!).evaluate((target) => {
                const bounds = target.getBoundingClientRect();
                return window.scrollY > 0 && bounds.top >= -1 && bounds.top < window.innerHeight;
              }),
            )
            .toBe(true);
          // Navigation must retain the document after the target has actually scrolled.
          await expectHeading();
          await expectNote();
        }
        await document.getByRole("link", { name: "Back to top", exact: true }).click();
        await expect.poll(() => heading.evaluate(() => window.scrollY)).toBe(0);
        await expectHeading();
        expect(await gateway.getRequests("canvas.document.preview")).toHaveLength(1);
        await page
          .getByRole("button", { name: "Open attachment.htm in the side panel", exact: true })
          .click();
        await outer.waitFor();
        const attachmentDocument = outer.contentFrame().frameLocator("iframe");
        await attachmentDocument.getByRole("heading", { name: "Local HTML page" }).waitFor();
        await panel
          .locator("openclaw-chat-html-preview [role=status]")
          .waitFor({ state: "hidden" });
        for (const height of [1000, 480]) {
          await page.setViewportSize({ width: 1440, height });
          await expect
            .poll(async () => {
              const frame = await outer.boundingBox();
              const available = await panel.locator(".sidebar-content").evaluate((element) => {
                const bounds = element.getBoundingClientRect();
                return bounds.bottom - Number.parseFloat(getComputedStyle(element).paddingBottom);
              });
              return Math.abs(frame!.y + frame!.height - available);
            })
            .toBeLessThanOrEqual(1);
          const frame = await outer.boundingBox();
          const viewport = await attachmentDocument.locator("body").evaluate(() => ({
            width: window.innerWidth,
            height: window.innerHeight,
          }));
          expect(viewport.width).toBeCloseTo(frame!.width, 0);
          expect(viewport.height).toBeCloseTo(frame!.height, 0);
        }
        await page.setViewportSize({ width: 1440, height: 1000 });
        await button("Source").click();
        expect(await panel.locator("pre:visible").textContent()).toBe(attachmentSource);
        expect(await panel.locator("a[download]").getAttribute("href")).toBe(mediaUrl);
        await tab.click();
        await expectNote();
        await button("Edit file").click();
        await panel.locator('.cm-content[contenteditable="true"]').fill(editedSource);
        await button("Preview").click();
        await document.getByRole("heading", { name: "Unsaved HTML draft" }).waitFor();
        expect(await gateway.getRequests("sessions.files.set")).toEqual([]);
        await page.locator("a.markdown-file-link").filter({ hasText: "line two" }).click();
        await panel.locator(".cm-editor:visible").waitFor();
        expect(await panel.locator(".file-view__line--target").getAttribute("data-line")).toBe("2");
        expect(await panel.locator(".cm-content").textContent()).toContain("Unsaved HTML draft");
        expect(await tab.count()).toBe(1);
        expect(await gateway.getRequests("canvas.document.view")).toEqual([]);
        expect(await gateway.getRequests("wake")).toEqual([]);
        expect(await gateway.getRequests("chat.send")).toEqual([]);
      });
    },
  );
});
