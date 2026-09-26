import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
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
        await page.addInitScript(() => {
          window.fileCopyProof = { nativeWrites: [], fallbacks: [] };
          Object.defineProperty(navigator, "clipboard", {
            configurable: true,
            value: {
              writeText: (text: string) => {
                window.fileCopyProof.nativeWrites.push(text);
                return new Promise<void>((resolve, reject) => {
                  window.fileCopyProof.resolve = resolve;
                  window.fileCopyProof.reject = () =>
                    reject(new Error("Synthetic clipboard rejection"));
                });
              },
            },
          });
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
          historyMessages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "Review `notes.txt`." }],
              timestamp: 1,
            },
          ],
          methodResponses: {
            "sessions.files.get": {
              root: "/workspace",
              file: {
                content: "Synthetic file copy content",
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
        await panel
          .getByRole("button", {
            name: action === "path" ? "Copy path" : "Copy file contents",
            exact: true,
          })
          .click();
        await page.waitForFunction(() => window.fileCopyProof.nativeWrites.length === 1);
        const expected = action === "path" ? "notes.txt" : "Synthetic file copy content";
        expect(await page.evaluate(() => window.fileCopyProof.nativeWrites)).toEqual([expected]);
        await page.screenshot({ path: path.join(suite.artifactDir, "copy-pending.png") });
        if (lifecycle === "close") {
          await page.getByRole("button", { name: "Close tab: notes.txt", exact: true }).click();
          await expect.poll(() => page.locator(".sidebar-file-view:visible").count()).toBe(0);
        } else if (lifecycle === "raw") {
          await panel.getByRole("button", { name: "View Raw Text", exact: true }).click();
          await expect.poll(() => panel.locator(".sidebar-file-view").count()).toBe(0);
        }
        await page.evaluate(async () => {
          window.fileCopyProof.reject!();
          await new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          });
        });
        const evidence = await page.evaluate(() => ({
          nativeWrites: window.fileCopyProof.nativeWrites,
          fallbacks: window.fileCopyProof.fallbacks,
        }));
        await writeFile(
          path.join(suite.artifactDir, "clipboard-result.json"),
          JSON.stringify({ lifecycle, action, ...evidence }, null, 2),
        );
        await page.screenshot({ path: path.join(suite.artifactDir, "copy-settled.png") });
        expect(evidence.fallbacks).toEqual(lifecycle === "current" ? [expected] : []);
        if (lifecycle === "current") {
          expect(await panel.getByRole("button", { name: "Copied!", exact: true }).count()).toBe(1);
          const copyButton = panel.getByRole("button", {
            name: action === "path" ? "Copy path" : "Copy file contents",
            exact: true,
          });
          // Wait for the first attempt's feedback to retire before proving native success.
          await copyButton.waitFor({ state: "visible" });
          await copyButton.click();
          await page.waitForFunction(() => window.fileCopyProof.nativeWrites.length === 2);
          await page.evaluate(() => window.fileCopyProof.resolve!());
          await panel
            .getByRole("button", { name: "Copied!", exact: true })
            .waitFor({ state: "visible" });
          const nativeSuccess = await page.evaluate(() => ({
            nativeWrites: window.fileCopyProof.nativeWrites,
            fallbacks: window.fileCopyProof.fallbacks,
          }));
          expect(nativeSuccess.nativeWrites).toEqual([expected, expected]);
          expect(nativeSuccess.fallbacks).toEqual([expected]);
          await writeFile(
            path.join(suite.artifactDir, "native-success.json"),
            JSON.stringify(nativeSuccess, null, 2),
          );
        } else {
          expect(await page.locator(".sidebar-file-view:visible button.copied").count()).toBe(0);
          expect(await page.locator(".file-view__save-notice:visible").count()).toBe(0);
        }
      });
    },
  );
});
