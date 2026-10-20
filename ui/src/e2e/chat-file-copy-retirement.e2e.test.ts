import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { chatMessage, exactButton } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "File copy retirement" });

declare global {
  interface Window {
    fileCopyProof: {
      nativeWrites: string[];
      fallbacks: string[];
      reject?: () => void;
      resolve?: () => void;
    };
  }
}

suite.define(() => {
  it.each(
    (["current", "close", "raw"] as const).flatMap((lifecycle) =>
      (["path", "contents"] as const).map((action) => ({ lifecycle, action })),
    ),
  )(
    "scopes $action copy fallback to its $lifecycle file presentation",
    async ({ lifecycle, action }) => {
      await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
        const content = "File contents";
        await page.clock.install();
        await page.addInitScript(() => {
          window.fileCopyProof = { nativeWrites: [], fallbacks: [] };
          const writeText = (text: string) =>
            new Promise<void>((resolve, reject) => {
              window.fileCopyProof.nativeWrites.push(text);
              window.fileCopyProof.resolve = resolve;
              window.fileCopyProof.reject = () => reject(new Error("Clipboard denied"));
            });
          Object.defineProperty(navigator, "clipboard", { value: { writeText } });
          document.execCommand = (command: string) => {
            if (command !== "copy") {
              throw new Error(`Unexpected clipboard command: ${command}`);
            }
            const selected = document.activeElement;
            window.fileCopyProof.fallbacks.push(
              selected instanceof HTMLTextAreaElement ? selected.value : "",
            );
            return true;
          };
        });
        await installMockGateway(page, {
          historyMessages: [chatMessage("assistant", "Review `notes.txt`.", { timestamp: 1 })],
          methodResponses: {
            "sessions.files.get": {
              root: "/workspace",
              file: {
                previewKind: "text",
                contentEncoding: "utf8",
                content,
                kind: "read",
                missing: false,
                name: "notes.txt",
                path: "notes.txt",
                workspacePath: "notes.txt",
              },
            },
          },
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        await page.locator('a.markdown-file-link[data-file-path="notes.txt"]').click();
        const panel = page.locator("openclaw-chat-detail-panel:visible");
        await panel.locator(".cm-content").waitFor({ state: "visible" });
        const copyTitle = action === "path" ? "Copy path" : "Copy file contents";
        const copyButton = exactButton(panel, copyTitle);
        const copied = exactButton(panel, "Copied!");
        await copyButton.click();
        await page.waitForFunction(() => window.fileCopyProof.nativeWrites.length === 1);
        const expected = action === "path" ? "notes.txt" : content;
        expect(await page.evaluate(() => window.fileCopyProof.nativeWrites)).toEqual([expected]);
        if (lifecycle === "close") {
          await exactButton(page, "Close tab: notes.txt").click();
          await expect.poll(() => page.locator(".sidebar-file-view:visible").count()).toBe(0);
        } else if (lifecycle === "raw") {
          await exactButton(panel, "View Raw Text").click();
          await expect.poll(() => panel.locator(".sidebar-file-view").count()).toBe(0);
        }
        // Keep transient feedback alive until its assertions settle.
        await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1_000);
        await page.evaluate(() => window.fileCopyProof.reject!());
        if (lifecycle === "current") {
          await copied.waitFor({ state: "visible" });
        }
        expect(await page.evaluate(() => window.fileCopyProof.fallbacks)).toEqual(
          lifecycle === "current" ? [expected] : [],
        );
        if (lifecycle === "current") {
          // Retire the first attempt's feedback before proving native success.
          await page.clock.fastForward(1_500);
          await copyButton.waitFor({ state: "visible" });
          await copyButton.click();
          await page.waitForFunction(() => window.fileCopyProof.nativeWrites.length === 2);
          await page.evaluate(() => window.fileCopyProof.resolve!());
          await copied.waitFor({ state: "visible" });
          const writes = await page.evaluate(() => window.fileCopyProof.nativeWrites);
          expect(writes).toEqual([expected, expected]);
          expect(await page.evaluate(() => window.fileCopyProof.fallbacks)).toEqual([expected]);
        } else {
          expect(await page.locator(".sidebar-file-view:visible button.copied").count()).toBe(0);
          expect(await page.locator(".file-view__save-notice:visible").count()).toBe(0);
        }
      });
    },
  );
});
