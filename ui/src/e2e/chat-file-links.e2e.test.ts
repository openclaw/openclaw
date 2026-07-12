// Real-browser proof for opening workspace files from chat links and the workspace browser.
import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
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
            content: [{ type: "text", text: "Review `README.md:2`." }],
            timestamp: 1,
          },
        ],
        methodResponses: {
          "sessions.files.get": {
            cases: [
              {
                match: { path: "README.md" },
                response: {
                  root: "/workspace",
                  file: {
                    content: "# Project\n\nNested workspace notes.\n",
                    kind: "read",
                    missing: false,
                    name: "README.md",
                    path: "README.md",
                    workspacePath: "packages/app/README.md",
                  },
                },
              },
              {
                match: { path: "/workspace/packages/app/README.md" },
                response: {
                  root: "/workspace",
                  file: {
                    content: "# Project\n\nNested workspace notes.\n",
                    kind: "read",
                    missing: false,
                    name: "README.md",
                    path: "packages/app/README.md",
                    workspacePath: "packages/app/README.md",
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
                  name: "README.md",
                  path: "packages/app/README.md",
                  size: 42,
                },
              ],
              path: "",
            },
          },
        },
      });

      await page.goto(`${server.baseUrl}chat`);
      const chatLink = page.locator('a.markdown-file-link[data-file-path="README.md"]');
      await chatLink.waitFor({ state: "visible" });
      await page.screenshot({ path: path.join(artifactDir, "01-chat-file-link.png") });
      await chatLink.click();

      const fileView = page.locator(".sidebar-file-view");
      await fileView.waitFor({ state: "visible" });
      expect(await fileView.locator(".file-view__line--target").getAttribute("data-line")).toBe(
        "2",
      );
      expect((await gateway.getRequests("sessions.files.get"))[0]?.params).toMatchObject({
        path: "README.md",
      });
      await page.screenshot({ path: path.join(artifactDir, "02-chat-file-preview.png") });

      await fileView.getByRole("button", { name: "Show in Files" }).click();
      await expect
        .poll(async () => (await gateway.getRequests("sessions.files.list"))[0]?.params)
        .toMatchObject({ path: "packages/app" });
      const browserRow = page
        .locator(".chat-workspace-rail__browser .chat-workspace-rail__file")
        .filter({ hasText: "README.md" });
      await browserRow.locator(".chat-workspace-rail__file-open").click();
      await expect
        .poll(async () => (await gateway.getRequests("sessions.files.get"))[1]?.params)
        .toMatchObject({ path: "/workspace/packages/app/README.md" });
      await page.screenshot({ path: path.join(artifactDir, "03-workspace-file-preview.png") });
    } finally {
      await context.close();
    }
  });

  it("previews text and browser-safe images while falling back for BMP", async () => {
    const png = fs.readFileSync(path.resolve(process.cwd(), "ui/public/apple-touch-icon.png"));
    expect(png.byteLength).toBeLessThan(256 * 1024);
    const pngBase64 = png.toString("base64");
    const responses = {
      "/workspace/notes.txt": {
        root: "/workspace",
        sessionKey: "main",
        file: {
          content: "Exact-head workspace preview proof.\n",
          contentEncoding: "utf8",
          hash: "a".repeat(64),
          kind: "read",
          mimeType: "text/plain",
          missing: false,
          name: "notes.txt",
          path: "notes.txt",
          previewKind: "text",
          size: 36,
          workspacePath: "notes.txt",
        },
      },
      "/workspace/openclaw-5920-bytes.png": {
        root: "/workspace",
        sessionKey: "main",
        file: {
          content: pngBase64,
          contentEncoding: "base64",
          kind: "read",
          mimeType: "image/png",
          missing: false,
          name: "openclaw-5920-bytes.png",
          path: "openclaw-5920-bytes.png",
          previewKind: "image",
          size: png.byteLength,
          workspacePath: "openclaw-5920-bytes.png",
        },
      },
      "/workspace/unsupported-binary.bmp": {
        root: "/workspace",
        sessionKey: "main",
        file: {
          kind: "read",
          mimeType: "image/bmp",
          missing: false,
          name: "unsupported-binary.bmp",
          path: "unsupported-binary.bmp",
          previewKind: "unsupported",
          size: 4096,
          workspacePath: "unsupported-binary.bmp",
        },
      },
    } satisfies Record<string, Record<string, unknown>>;
    const context = await browser.newContext({
      recordVideo: { dir: artifactDir, size: { height: 900, width: 1280 } },
      viewport: { height: 900, width: 1280 },
    });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(15_000);
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "sessions.files.get": {
            cases: Object.entries(responses).map(([requestPath, response]) => ({
              match: { path: requestPath },
              response,
            })),
          },
          "sessions.files.list": {
            browser: {
              entries: Object.keys(responses).map((requestPath) => {
                const filePath = requestPath.slice("/workspace/".length);
                return { kind: "file", name: filePath, path: filePath };
              }),
              path: "",
            },
            files: [],
            root: "/workspace",
            sessionKey: "main",
          },
        },
      });
      const openPreview = async (filePath: string) => {
        const fileRow = page
          .locator(".chat-workspace-rail__browser .chat-workspace-rail__file")
          .filter({ hasText: filePath });
        await fileRow.locator(".chat-workspace-rail__file-open").click();
      };
      const closePreview = async () => {
        await page.locator(".sidebar-panel .sidebar-header button").click();
        await page.locator(".sidebar-panel").waitFor({ state: "hidden" });
      };

      await page.goto(`${server.baseUrl}chat`);
      await page.locator(".chat-workspace-toggle").click();
      await page.getByRole("button", { name: "Collapse session workspace" }).waitFor();

      await openPreview("notes.txt");
      await page.locator(".sidebar-file-view").waitFor({ state: "visible" });
      expect(await page.locator(".cm-content").textContent()).toContain(
        "Exact-head workspace preview proof.",
      );
      await page.screenshot({ path: path.join(artifactDir, "04-text-preview.png") });
      await closePreview();

      await openPreview("openclaw-5920-bytes.png");
      const image = page.locator('.chat-tool-card__preview[data-kind="image"] img');
      await image.waitFor({ state: "visible" });
      expect(await image.getAttribute("src")).toBe(`data:image/png;base64,${pngBase64}`);
      await page.screenshot({ path: path.join(artifactDir, "05-png-preview.png") });
      await closePreview();

      await openPreview("unsupported-binary.bmp");
      const fallback = page.locator(".sidebar-markdown-shell");
      await fallback.waitFor({ state: "visible" });
      const fallbackText = await fallback.textContent();
      expect(fallbackText).toContain("This file is not previewable inline.");
      expect(fallbackText).toContain("image/bmp");
      await page.screenshot({ path: path.join(artifactDir, "06-bmp-fallback.png") });

      expect(
        (await gateway.getRequests("sessions.files.get")).map((request) => request.params),
      ).toEqual([
        { agentId: "main", path: "/workspace/notes.txt", sessionKey: "main" },
        {
          agentId: "main",
          path: "/workspace/openclaw-5920-bytes.png",
          sessionKey: "main",
        },
        {
          agentId: "main",
          path: "/workspace/unsupported-binary.bmp",
          sessionKey: "main",
        },
      ]);
    } finally {
      await context.close();
    }
  });
});
