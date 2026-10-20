import fs from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import type { NativeGatewaysSnapshot } from "../app/native-gateways.runtime.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { chatMessage } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI chat file default app",
  startServerBeforeBrowser: true,
});
const localGateway: NativeGatewaysSnapshot = {
  currentId: "local",
  gateways: [
    {
      id: "local",
      name: "Local Gateway",
      kind: "local",
      isPrimary: true,
      canPromote: false,
      health: "ok",
    },
  ],
};

async function installMacApp(page: Page, handlesFiles: boolean, outcome = "opened") {
  await page.addInitScript(
    ({ snapshot, files, reply }) => {
      const posts: unknown[] = [];
      const handler = { postMessage: () => {} };
      Object.assign(window, {
        __OPENCLAW_NATIVE_GATEWAYS__: snapshot,
        filePosts: posts,
        webkit: {
          messageHandlers: {
            openclawGateways: handler,
            ...(files
              ? {
                  openclawFiles: {
                    postMessage: async (message: unknown) => {
                      posts.push(message);
                      return reply;
                    },
                  },
                }
              : {}),
          },
        },
      });
    },
    { snapshot: localGateway, files: handlesFiles, reply: outcome },
  );
}

async function openMarkdownEditorMenu(page: Page) {
  await installMockGateway(page, {
    historyMessages: [chatMessage("assistant", "Updated `notes.md`.", { timestamp: 1 })],
    methodResponses: {
      "sessions.files.get": {
        root: "/workspace",
        file: {
          kind: "read",
          missing: false,
          name: "notes.md",
          path: "notes.md",
          workspacePath: "notes.md",
          previewKind: "text",
          contentEncoding: "utf8",
          content: "# Notes\n\nDraft for Typora.\n",
          hash: "notes-hash",
        },
      },
    },
  });
  await page.goto(`${suite.server.baseUrl}chat`);
  const link = page.locator('a.markdown-file-link[data-file-path="notes.md"]');
  await link.waitFor({ state: "visible" });
  await link.click();
  const fileView = page.locator(".sidebar-file-view");
  await fileView.waitFor({ state: "visible" });
  await fileView.getByRole("button", { name: "Open in editor" }).click();
  const items = page.locator(".sidebar-file-view__editor-item");
  await items.first().waitFor({ state: "visible" });
  return { fileView, items };
}

suite.define(() => {
  it.each([
    { handlesFiles: false, labels: ["Cursor", "VS Code", "Windsurf", "Zed"] },
    { handlesFiles: true, labels: ["Cursor", "VS Code", "Windsurf", "Zed", "Default App"] },
  ])(
    "offers the default app when the Mac app handles files ($handlesFiles)",
    async ({ handlesFiles, labels }) => {
      await suite.withPage({ viewport: { height: 900, width: 1280 } }, async ({ page }) => {
        await installMacApp(page, handlesFiles);
        const { fileView, items } = await openMarkdownEditorMenu(page);
        await expect
          .poll(async () => (await items.allTextContents()).map((label) => label.trim()))
          .toEqual(labels);
        const frame = await takeControlUiScreenshotFrame(
          page,
          page.locator("body"),
          [fileView, items.last()],
          {
            animations: "disabled",
          },
        );
        await fs.writeFile(
          path.join(suite.artifactDir, `editor-menu-${handlesFiles ? "after" : "before"}.png`),
          frame.png,
        );
        if (!handlesFiles) {
          return;
        }
        await items.last().click();
        await expect
          .poll(() => page.evaluate(() => Reflect.get(window, "filePosts") as unknown[]))
          .toEqual([{ type: "open-default-app", path: "/workspace/notes.md" }]);
      });
    },
  );

  it("explains a refused default-app open and points to an editor", async () => {
    await suite.withPage({ viewport: { height: 900, width: 1280 } }, async ({ page }) => {
      await installMacApp(page, true, "unsupported-type");
      const { items } = await openMarkdownEditorMenu(page);
      await items.last().click();
      const toast = page.locator(".app-toast__message");
      await toast.waitFor({ state: "visible" });
      expect(await toast.textContent()).toContain("Choose an editor instead.");
      const frame = await takeControlUiScreenshotFrame(page, page.locator("body"), [toast], {
        animations: "disabled",
      });
      await fs.writeFile(path.join(suite.artifactDir, "default-app-refused.png"), frame.png);
    });
  });
});
