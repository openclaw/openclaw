// Real-browser proof for opening workspace files from chat links and the workspace browser.
import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
const artifactDir = path.resolve(process.cwd(), ".artifacts/control-ui-e2e/chat-file-links");

let browser: Browser;
let server: ControlUiE2eServer;

describeControlUiE2e("Control UI chat file links", () => {
  beforeAll(async () => {
    fs.mkdirSync(artifactDir, { recursive: true });
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("opens the selected file from chat and the workspace root", async () => {
    const context = await browser.newContext({
      recordVideo: { dir: artifactDir, size: { height: 900, width: 1280 } },
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    try {
      const gateway = await installMockGateway(page, {
        historyMessages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "Review `src/sample.ts:2`." }],
            timestamp: 1,
          },
        ],
        methodResponses: {
          "sessions.files.get": {
            cases: [
              {
                match: { path: "src/sample.ts" },
                response: {
                  root: "/workspace",
                  file: {
                    content: "const first = 1;\nconst second = 2;\n",
                    kind: "read",
                    missing: false,
                    name: "sample.ts",
                    path: "src/sample.ts",
                  },
                },
              },
              {
                match: { path: "/workspace/src/sample.ts" },
                response: {
                  root: "/workspace",
                  file: {
                    content: "const first = 1;\nconst second = 2;\n",
                    kind: "read",
                    missing: false,
                    name: "sample.ts",
                    path: "src/sample.ts",
                  },
                },
              },
            ],
          },
          "sessions.files.list": {
            root: "/workspace",
            sessionKey: "main",
            files: [],
            browser: {
              entries: [
                {
                  kind: "file",
                  name: "sample.ts",
                  path: "src/sample.ts",
                  size: 42,
                },
              ],
              path: "",
            },
          },
        },
      });

      await page.goto(`${server.baseUrl}chat`);
      const chatLink = page.locator('a.markdown-file-link[data-file-path="src/sample.ts"]');
      await chatLink.waitFor({ state: "visible" });
      await page.screenshot({ path: path.join(artifactDir, "01-chat-file-link.png") });
      await chatLink.click();

      const fileView = page.locator(".sidebar-file-view");
      await fileView.waitFor({ state: "visible" });
      expect(await fileView.locator(".file-view__line--target").getAttribute("data-line")).toBe(
        "2",
      );
      expect((await gateway.getRequests("sessions.files.get"))[0]?.params).toMatchObject({
        path: "src/sample.ts",
      });
      await page.screenshot({ path: path.join(artifactDir, "02-chat-file-preview.png") });

      await page.getByRole("button", { name: "Expand session workspace" }).click();
      const browserRow = page
        .locator(".chat-workspace-rail__browser .chat-workspace-rail__file")
        .filter({ hasText: "sample.ts" });
      await browserRow.locator(".chat-workspace-rail__file-open").click();
      await expect
        .poll(async () => (await gateway.getRequests("sessions.files.get"))[1]?.params)
        .toMatchObject({ path: "/workspace/src/sample.ts" });
      await page.screenshot({ path: path.join(artifactDir, "03-workspace-file-preview.png") });
    } finally {
      await context.close();
    }
  });
});
