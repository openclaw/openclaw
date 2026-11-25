// File admission, resource delivery, browser policy and grant retirement are native paths.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { appendTranscriptMessage } from "../../../src/config/sessions/session-accessor.ts";
import { ensureGatewayOwnerProfile } from "../../../src/state/user-profiles.ts";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import type { ChatHtmlPreviewElement } from "../pages/chat/components/chat-html-preview-element.tsx";
import { finishElementAnimations } from "../test-helpers/animations.ts";
import { pairControlUiPage } from "../test-helpers/control-ui-browser-pairing.ts";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { readControlUiE2eDownload } from "../test-helpers/control-ui-e2e-download.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { clickBoardWidgetControl } from "../test-helpers/control-ui-e2e-widget.ts";
import { controlUiSessionUrl } from "../test-helpers/control-ui-e2e.ts";
import { selectFileAction } from "./chat-file-actions.test-support.ts";
import { connectChatGateway, runGatewayCli } from "./chat-real-gateway.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { readUiBundle } from "./device-gateway.test-support.ts";

const sessionKey = "agent:main:html-csp-proof";
const policy =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
const html = [
  '<!doctype html><html><head><meta charset="utf-8">',
  `<meta http-equiv="Content-Security-Policy" content="${policy}">`,
  '<title>Inspection preview</title><link rel="stylesheet" href="styles.css">',
  "<style>#inline-style{color:rgb(200, 0, 0)}</style>",
  '<script>document.documentElement.dataset.inlineRan="yes";</script>',
  '<script defer src="data.js"></script><script defer src="app.js"></script>',
  '</head><body><h1>Inspection preview</h1><p id="inline-style">Original bytes: café 雪 🦀</p>',
  '<p>Records: <output id="count">0</output></p><p id="order">Waiting for scripts</p>',
  '<p id="storage">Storage unchecked</p><p id="network">Network unchecked</p>',
  '<button id="add" disabled>Add inspection</button><button id="export" disabled>Export JSON</button>',
  '<label>Exported inspections<textarea id="exported" readonly></textarea></label>',
  "</body></html>",
].join("");
const unsupportedHtml = html.replace(
  '<script defer src="app.js">',
  '<script type="module" src="app.js">',
);
const assets = {
  "styles.css":
    "body{font:16px system-ui;padding:24px;color:rgb(12,34,56)}h1{font-size:28px}button{margin:8px 8px 16px 0}label,textarea{display:block}textarea{width:95%;height:120px}",
  "data.js": 'window.inspections = ["Roof", "Boiler", "Windows"]; window.previewOrder = ["data"];',
  "app.js": `window.previewOrder.push("app");
const count = document.querySelector("#count");
const add = document.querySelector("#add");
const exportButton = document.querySelector("#export");
count.textContent = String(window.inspections.length);
document.querySelector("#order").textContent = window.previewOrder.join(" → ") + "; DOM ready";
try { void localStorage.length; document.querySelector("#storage").textContent = "Storage allowed"; }
catch { document.querySelector("#storage").textContent = "Storage denied"; }
document.addEventListener("securitypolicyviolation", (event) => {
  if (event.effectiveDirective === "connect-src") document.querySelector("#network").textContent = "Network denied by connect-src";
});
fetch("https://preview-blocked.invalid/").catch(() => {});
add.disabled = exportButton.disabled = false;
add.onclick = () => { window.inspections.push("Garden"); count.textContent = String(window.inspections.length); };
exportButton.onclick = () => document.querySelector("#exported").value = JSON.stringify(window.inspections);`,
};
const viewport = { width: 1440, height: 1000 };
let instance: OpenClawTestInstance;
let client: Awaited<ReturnType<typeof connectChatGateway>>;
let workspace: string;
const suite = createControlUiE2eSuite({
  name: "HTML CSP files through a real Gateway",
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
    instance = await createOpenClawTestInstance({
      name: "html-csp-proof",
      entrypoint: ["dist/index.js"],
      env: {
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        OPENCLAW_SKIP_CANVAS_HOST: "0",
        VITEST: undefined,
      },
      config: {
        update: { checkOnStart: false },
        gateway: { controlUi: { enabled: true, embedSandbox: "scripts" } },
        cron: { enabled: false },
        browser: { enabled: false },
        agents: {
          ownership: "explicit",
          defaults: { workspace: "${OPENCLAW_WORKSPACE_DIR}", model: "html-fixture/unused" },
          entries: { main: { identity: { name: "Inspection assistant" } } },
        },
        models: {
          catalogRefresh: { enabled: false },
          providers: {
            "html-fixture": {
              api: "openai-responses",
              apiKey: "synthetic-unused-key",
              baseUrl: "http://127.0.0.1:9/v1",
              models: [{ id: "unused", name: "Unused fixture model" }],
            },
          },
        },
        plugins: { allow: ["openai"] },
      },
    });
    try {
      workspace = instance.state.path("preview-workspace");
      instance.env.OPENCLAW_WORKSPACE_DIR = workspace;
      await mkdir(workspace, { recursive: true });
      for (const [name, content] of Object.entries({
        "index.html": html,
        "unsupported.html": unsupportedHtml,
        ...assets,
      })) {
        await writeFile(path.join(workspace, name), content);
      }
      await writeFile(
        instance.state.path("outside.js"),
        'window.outsideWorkspace = "must remain private";',
      );
      await writeFile(path.join(workspace, "import.css"), String.raw`@\69mport "styles.css";`);
      ensureGatewayOwnerProfile("Inspection operator", { env: instance.env });
      await instance.startGateway();
      return { baseUrl: `http://127.0.0.1:${instance.port}/`, close: () => instance.cleanup() };
    } catch (error) {
      return runQaGatewayFixture(
        async () => {
          throw error;
        },
        () => instance.cleanup(),
      );
    }
  },
});

function browserRpc<T>(page: Page, method: string, params: Record<string, unknown>): Promise<T> {
  return evaluateControlUiContext(
    page,
    async (app, request) => {
      const gateway = app.gateway.snapshot.client;
      if (!gateway) {
        throw new Error("Preview browser is disconnected");
      }
      return gateway.request<T>(request.method, request.params);
    },
    { method, params },
  );
}

async function assertSourceAndDownload(
  page: Page,
  panel: Locator,
  content: string,
  filename: string,
) {
  await selectFileAction(panel, "Source");
  await expect.poll(() => panel.locator(".cm-content:visible").textContent()).toBe(content);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    panel
      .getByRole("button", { name: "Download file", exact: true })
      .filter({ visible: true })
      .click(),
  ]);
  expect(await readControlUiE2eDownload(download)).toEqual(Buffer.from(content));
  expect(download.suggestedFilename()).toBe(filename);
  await selectFileAction(panel, "Preview");
}

type PreviewGrant = { previewId: string; sandboxPath: string };
suite.define(() => {
  it("loads allowed relative assets without relaxing authored policy or retaining revoked readers", async () => {
    const session = await client.request<{ sessionId: string }>("sessions.create", {
      key: sessionKey,
      agentId: "main",
      cwd: workspace,
      permissionMode: "read-only",
      label: "Inspection preview",
    });
    await appendTranscriptMessage(
      { agentId: "main", sessionKey, sessionId: session.sessionId, env: instance.env },
      {
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "Open [inspection preview](index.html) or [unsupported module](unsupported.html).",
            },
          ],
          timestamp: Date.now(),
        },
      },
    );
    // Pair before recording so the single-use handoff never appears in proof media.
    const setup = await suite.newBrowserContext({
      viewport,
      permissions: ["local-network-access"],
    });
    const setupPage = await setup.newPage();
    await pairControlUiPage(setupPage, (args) => runGatewayCli(instance, args));
    const storageState = await setup.storageState();
    await suite.closeBrowserContext(setup);
    const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR ? suite.artifactDir : undefined;
    await suite.withPage(
      {
        viewport,
        storageState,
        locale: "en-US",
        colorScheme: "light",
        serviceWorkers: "block",
        permissions: ["local-network-access"],
        ...(artifactDir ? { recordVideo: { dir: artifactDir, size: viewport } } : {}),
      },
      async ({ page }) => {
        let deviceId = "";
        const requests = new Map<string, Record<string, unknown>>();
        const grants: Array<PreviewGrant & { source: Record<string, unknown> }> = [];
        page.on("websocket", (socket) => {
          socket.on("framesent", ({ payload }) => {
            const frame: unknown = JSON.parse(payload.toString());
            if (!isRecord(frame) || frame.type !== "req" || !isRecord(frame.params)) {
              return;
            }
            if (
              frame.method === "connect" &&
              isRecord(frame.params.device) &&
              typeof frame.params.device.id === "string"
            ) {
              deviceId = frame.params.device.id;
            }
            if (frame.method === "sessions.files.preview" && typeof frame.id === "string") {
              requests.set(frame.id, frame.params);
            }
          });
          socket.on("framereceived", ({ payload }) => {
            const frame: unknown = JSON.parse(payload.toString());
            if (!isRecord(frame) || typeof frame.id !== "string") {
              return;
            }
            const params = requests.get(frame.id);
            if (!params) {
              return;
            }
            requests.delete(frame.id);
            const result = frame.payload;
            if (
              isRecord(result) &&
              typeof result.previewId === "string" &&
              typeof result.sandboxPath === "string"
            ) {
              const source = { ...params };
              delete source.html;
              delete source.allowScripts;
              grants.push({ previewId: result.previewId, sandboxPath: result.sandboxPath, source });
            }
          });
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        await waitForControlUiGatewayReady(page);
        await page.locator('a.markdown-file-link[data-file-path="index.html"]').click();
        const panel = page.locator("openclaw-chat-detail-panel:visible");
        const outer = panel.locator(".chat-html-preview__frame");
        const document = outer.contentFrame().frameLocator("iframe");
        const heading = document.getByRole("heading", { name: "Inspection preview", exact: true });
        await heading.waitFor();
        await panel
          .locator("openclaw-chat-html-preview [role=status]")
          .waitFor({ state: "hidden" });
        await page
          .locator('[data-region="side"]')
          .filter({ has: panel })
          .evaluate(finishElementAnimations);
        const capture = async (name: string) => {
          if (!artifactDir) {
            return;
          }
          const frame = await takeControlUiScreenshotFrame(page, panel, [outer], {
            animations: "disabled",
          });
          await writeFile(path.join(artifactDir, name), frame.png);
        };
        // The same scenario captures the honest uninitialized base before its decisive assertion.
        await capture("preview-initial.png");
        await expect.poll(() => document.locator("#count").textContent()).toBe("3");
        expect(await document.locator("#order").textContent()).toBe("data → app; DOM ready");
        expect(await document.locator("#storage").textContent()).toBe("Storage denied");
        await expect
          .poll(() => document.locator("#network").textContent())
          .toBe("Network denied by connect-src");
        expect(await document.locator("html").getAttribute("data-inline-ran")).toBeNull();
        expect(
          await document
            .locator("#inline-style")
            .evaluate((element) => getComputedStyle(element).color),
        ).toBe("rgb(12, 34, 56)");
        expect(
          await document
            .locator('meta[http-equiv="Content-Security-Policy"]')
            .getAttribute("content"),
        ).toBe(policy);
        expect(await outer.contentFrame().locator("iframe").getAttribute("sandbox")).toBe(
          "allow-scripts allow-forms",
        );
        expect(
          await document.locator("body").evaluate(() => {
            let topDenied = false;
            try {
              void window.top?.document;
            } catch {
              topDenied = true;
            }
            return { topDenied, api: typeof Reflect.get(window, "openclaw") };
          }),
        ).toEqual({ topDenied: true, api: "undefined" });
        await clickBoardWidgetControl(
          page,
          document.getByRole("button", { name: "Add inspection", exact: true }),
        );
        await clickBoardWidgetControl(
          page,
          document.getByRole("button", { name: "Export JSON", exact: true }),
        );
        expect(
          await document.getByRole("textbox", { name: "Exported inspections" }).inputValue(),
        ).toBe('["Roof","Boiler","Windows","Garden"]');
        await capture("preview-interaction.png");
        const shellUrl = await outer.getAttribute("src");
        expect(shellUrl).toBeTruthy();
        const assetUrl = new URL("app.js", shellUrl!).href;
        for (const [name, content] of Object.entries(assets)) {
          const response = await page.request.get(new URL(name, shellUrl!).href);
          expect(response.status()).toBe(200);
          expect(await response.body()).toEqual(Buffer.from(content));
          expect(response.headers()["cache-control"]).toBe("private, no-store");
          expect(response.headers()["access-control-allow-origin"]).toBeUndefined();
        }
        for (const unknown of ["unadmitted.js", "app.js?ungranted=1"]) {
          expect((await page.request.get(new URL(unknown, shellUrl!).href)).status()).toBe(404);
        }
        expect(grants).toHaveLength(1);
        const grant = grants[0]!;
        const importHtml = html.replace('href="styles.css"', 'href="import.css"');
        const refused = await browserRpc<{ status: string; html: string; previewId?: string }>(
          page,
          "sessions.files.preview",
          { ...grant.source, html: importHtml },
        );
        expect(refused.status).toBe("unsupported");
        expect(refused.html).toBe(importHtml);
        expect(refused.previewId).toBeUndefined();
        const foreign = await client.request<PreviewGrant>("sessions.files.preview", {
          ...grant.source,
          html,
        });
        expect(
          await client.request("sessions.files.preview.release", {
            ...grant.source,
            previewId: grant.previewId,
          }),
        ).toEqual({ released: false });
        const mixed = new URL(assetUrl);
        mixed.pathname = mixed.pathname.replace(
          grant.previewId,
          `${grant.previewId.split("/")[0]}/${foreign.previewId.split("/")[1]}`,
        );
        expect((await page.request.get(mixed.href)).status()).toBe(404);
        expect(
          await client.request("sessions.files.preview.release", {
            ...grant.source,
            previewId: foreign.previewId,
          }),
        ).toEqual({ released: true });
        const extra = await browserRpc<PreviewGrant>(page, "sessions.files.preview", {
          ...grant.source,
          html,
        });
        const extraAsset = new URL("app.js", new URL(extra.sandboxPath, shellUrl!)).href;
        expect((await page.request.get(extraAsset)).status()).toBe(200);
        expect(
          await browserRpc(page, "sessions.files.preview.release", {
            ...grant.source,
            previewId: extra.previewId,
          }),
        ).toEqual({ released: true });
        expect((await page.request.get(extraAsset)).status()).toBe(404);
        const contained = await browserRpc<PreviewGrant & { omitted: number }>(
          page,
          "sessions.files.preview",
          {
            ...grant.source,
            html: html.replace('src="app.js"', 'src="../outside.js"'),
          },
        );
        expect(contained.omitted).toBe(1);
        expect(
          (
            await page.request.get(
              new URL("../outside.js", new URL(contained.sandboxPath, shellUrl!)).href,
            )
          ).status(),
        ).toBe(404);
        expect(
          await browserRpc(page, "sessions.files.preview.release", {
            ...grant.source,
            previewId: contained.previewId,
          }),
        ).toEqual({ released: true });
        await assertSourceAndDownload(page, panel, html, "index.html");
        await page.locator('a.markdown-file-link[data-file-path="unsupported.html"]').click();
        await panel
          .getByRole("status")
          .filter({ hasText: "Use Source or Download for the original file." })
          .waitFor();
        await assertSourceAndDownload(page, panel, unsupportedHtml, "unsupported.html");
        await page
          .locator(".side-panel__header .tabstrip-tab")
          .filter({ hasText: "index.html" })
          .click();
        await heading.waitFor();
        // Exercise the native element's existing mode input while retaining its real Gateway owner.
        const preview = panel.locator("openclaw-chat-html-preview");
        const beforeStrictAsset = new URL("app.js", (await outer.getAttribute("src"))!).href;
        expect((await page.request.get(beforeStrictAsset)).status()).toBe(200);
        await preview.evaluate((element: ChatHtmlPreviewElement) => {
          element.embedSandboxMode = "strict";
        });
        await expect
          .poll(() => outer.contentFrame().locator("iframe").getAttribute("sandbox"))
          .toBe("");
        await heading.waitFor();
        await panel
          .locator("openclaw-chat-html-preview [role=status]")
          .waitFor({ state: "hidden" });
        expect(await document.locator("#count").textContent()).toBe("0");
        expect(
          await document.getByRole("button", { name: "Add inspection", exact: true }).isDisabled(),
        ).toBe(true);
        expect(
          await document.locator("h1").evaluate((element) => getComputedStyle(element).color),
        ).toBe("rgb(12, 34, 56)");
        expect((await page.request.get(beforeStrictAsset)).status()).toBe(404);
        await preview.evaluate((element: ChatHtmlPreviewElement) => {
          element.embedSandboxMode = "scripts";
        });
        await expect.poll(() => document.locator("#count").textContent()).toBe("3");
        const currentAsset = new URL("app.js", (await outer.getAttribute("src"))!).href;
        expect((await page.request.get(currentAsset)).status()).toBe(200);
        if (artifactDir) {
          await writeFile(
            path.join(artifactDir, "runtime.json"),
            JSON.stringify({ bundle: await readUiBundle(page), policy }),
          );
        }
        expect(deviceId).not.toBe("");
        await client.request("device.token.revoke", { deviceId, role: "operator" });
        expect((await page.request.get(currentAsset)).status()).toBe(404);
        for (const [name, content] of Object.entries({
          "index.html": html,
          "unsupported.html": unsupportedHtml,
          ...assets,
        })) {
          expect(await readFile(path.join(workspace, name))).toEqual(Buffer.from(content));
        }
      },
      async ({ page, context }) => {
        const video = page.video();
        await suite.closeBrowserContext(context);
        if (artifactDir) {
          await video?.saveAs(path.join(artifactDir, "preview-interaction.webm"));
        }
      },
    );
  });
});
