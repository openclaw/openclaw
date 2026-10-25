import { expect, it } from "vitest";
import { createControlUiE2eSuite } from "../../e2e/control-ui-e2e-suite.test-support.ts";
import { installMockGateway } from "../../test-helpers/control-ui-e2e.ts";

declare global {
  interface Window {
    lobsterdexClipboardFault: {
      legacyWrites: string[];
      pendingRejects: Array<(reason?: unknown) => void>;
    };
  }
}

const suite = createControlUiE2eSuite({
  name: "Control UI Lobsterdex clipboard E2E",
  startServerBeforeBrowser: true,
});

suite.define(() => {
  it("falls back, announces failure, and keeps feedback with the newest copy", async () => {
    await suite.withPage(
      {
        hasTouch: true,
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 844, width: 390 },
      },
      async ({ page }) => {
        const readClipboard = () => page.evaluate(() => window.lobsterdexClipboardFault);
        const rejectWrite = (index: number) =>
          page.evaluate(async (pendingIndex) => {
            const reject = window.lobsterdexClipboardFault.pendingRejects[pendingIndex];
            if (!reject) {
              throw new Error(`Missing pending clipboard write ${pendingIndex}`);
            }
            reject(new Error("denied"));
            await new Promise<void>((resolve) => {
              window.setTimeout(resolve, 0);
            });
          }, index);
        await page.addInitScript(() => {
          window.lobsterdexClipboardFault = { legacyWrites: [], pendingRejects: [] };
          const state = window.lobsterdexClipboardFault;
          Object.defineProperty(navigator, "clipboard", {
            value: {
              writeText: () =>
                new Promise<void>((_resolve, reject) => {
                  state.pendingRejects.push(reject);
                }),
            },
          });
          document.execCommand = (command: string) => {
            if (command !== "copy") {
              return false;
            }
            state.legacyWrites.push(
              document.querySelector<HTMLTextAreaElement>("textarea")?.value ?? "",
            );
            return state.legacyWrites.length > 1;
          };
        });
        await installMockGateway(page);
        await page.goto(`${suite.server.baseUrl}settings/lobsterdex`);

        const pageRoot = page.locator("openclaw-lobsterdex-page");
        const copyButtons = pageRoot.getByRole("button", { name: "Copy link" });
        const crimson = copyButtons.nth(0);
        const blue = copyButtons.nth(1);
        const blueUrl = `${new URL(suite.server.baseUrl).origin}/settings/lobsterdex#lobsterdex-blue`;
        const checkmark = 'path[d="M20 6 9 17l-5-5"]';
        const expectNewestCopy = async () => {
          expect(await crimson.locator(checkmark).count()).toBe(0);
          expect(await blue.locator(checkmark).count()).toBe(1);
          expect((await readClipboard()).legacyWrites).toEqual([blueUrl, blueUrl]);
        };
        await crimson.focus();
        await page.keyboard.press("Enter");
        await blue.tap();
        await rejectWrite(1);
        await expect.poll(() => pageRoot.getByRole("alert").textContent()).toBe("Copy failed");
        await blue.tap();
        await expect.poll(() => pageRoot.getByRole("alert").count()).toBe(0);

        await rejectWrite(2);
        await blue.locator(checkmark).waitFor();
        await expectNewestCopy();
        await expect.poll(() => pageRoot.getByRole("status").textContent()).toContain("Copied!");

        await rejectWrite(0);
        await expectNewestCopy();
        await expect.poll(() => blue.locator(checkmark).count()).toBe(0);
      },
    );
  });
});
