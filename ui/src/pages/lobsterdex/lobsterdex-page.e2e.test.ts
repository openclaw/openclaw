import { expect, it } from "vitest";
import { createControlUiE2eSuite } from "../../e2e/control-ui-e2e-suite.test-support.ts";
import { installMockGateway } from "../../test-helpers/control-ui-e2e.ts";

type ClipboardFaultState = {
  asyncWrites: string[];
  execSucceeds: boolean;
  legacyWrites: string[];
  mode: "defer" | "missing" | "reject";
  pendingRejects: Array<(reason?: unknown) => void>;
};

declare global {
  interface Window {
    lobsterdexClipboardFault: ClipboardFaultState;
  }
}

const suite = createControlUiE2eSuite({
  name: "Control UI Lobsterdex clipboard E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}`,
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
        const expectWrites = (asyncWrites: string[], legacyWrites: string[]) =>
          expect.poll(readClipboard).toMatchObject({ asyncWrites, legacyWrites });
        const configureClipboard = (patch: Partial<ClipboardFaultState>) =>
          page.evaluate((value) => Object.assign(window.lobsterdexClipboardFault, value), patch);
        const rejectWrite = (index: number) =>
          page.evaluate((pendingIndex) => {
            window.lobsterdexClipboardFault.pendingRejects[pendingIndex]?.(
              new DOMException("Write rejected", "NotAllowedError"),
            );
          }, index);
        await page.addInitScript(() => {
          const state: ClipboardFaultState = {
            asyncWrites: [],
            execSucceeds: true,
            legacyWrites: [],
            mode: "reject",
            pendingRejects: [],
          };
          Object.defineProperty(window, "lobsterdexClipboardFault", { value: state });
          Object.defineProperty(navigator, "clipboard", {
            configurable: true,
            get: () =>
              state.mode === "missing"
                ? undefined
                : {
                    writeText(text: string) {
                      state.asyncWrites.push(text);
                      if (state.mode === "reject") {
                        return Promise.reject(
                          new DOMException("Clipboard access denied", "NotAllowedError"),
                        );
                      }
                      return new Promise<void>((_resolve, reject) => {
                        state.pendingRejects.push(reject);
                      });
                    },
                  },
          });
          document.execCommand = (command: string) => {
            if (command !== "copy") {
              return false;
            }
            state.legacyWrites.push(
              document.querySelector<HTMLTextAreaElement>("textarea")?.value ?? "",
            );
            return state.execSucceeds;
          };
        });
        await installMockGateway(page);
        const response = await page.goto(`${suite.server.baseUrl}settings/lobsterdex`);
        expect(response?.status()).toBe(200);

        const pageRoot = page.locator("openclaw-lobsterdex-page");
        const copyButtons = pageRoot.getByRole("button", { name: "Copy link" });
        await expect.poll(() => copyButtons.count()).toBeGreaterThan(1);
        const crimson = copyButtons.nth(0);
        const blue = copyButtons.nth(1);
        const crimsonUrl = `${new URL(suite.server.baseUrl).origin}/settings/lobsterdex#lobsterdex-crimson`;
        const blueUrl = `${new URL(suite.server.baseUrl).origin}/settings/lobsterdex#lobsterdex-blue`;
        await crimson.focus();
        await page.keyboard.press("Enter");
        await expectWrites([crimsonUrl], [crimsonUrl]);
        await expect.poll(() => pageRoot.getByRole("status").textContent()).toContain("Copied!");

        await configureClipboard({ mode: "missing" });
        await blue.tap();
        await expectWrites([crimsonUrl], [crimsonUrl, blueUrl]);

        await configureClipboard({ mode: "reject", execSucceeds: false });
        await crimson.tap();
        await expect.poll(() => pageRoot.getByRole("alert").textContent()).toBe("Copy failed");
        await pageRoot.evaluate((element) => {
          const parent = element.parentElement;
          if (!parent) {
            throw new Error("Lobsterdex page has no route host");
          }
          element.remove();
          parent.append(element);
        });
        await expect.poll(() => pageRoot.getByRole("alert").count()).toBe(0);

        await configureClipboard({
          mode: "defer",
          execSucceeds: true,
          asyncWrites: [],
          legacyWrites: [],
          pendingRejects: [],
        });
        await crimson.focus();
        await page.keyboard.press("Enter");
        await blue.tap();
        await expect
          .poll(() => page.evaluate(() => window.lobsterdexClipboardFault.pendingRejects.length))
          .toBe(2);
        expect(await pageRoot.getByRole("alert").count()).toBe(0);

        await rejectWrite(1);
        await blue.locator('path[d="M20 6 9 17l-5-5"]').waitFor();
        expect(await crimson.locator('path[d="M20 6 9 17l-5-5"]').count()).toBe(0);
        await expect.poll(async () => (await readClipboard()).legacyWrites).toEqual([blueUrl]);

        await rejectWrite(0);
        await page.evaluate(
          () =>
            new Promise<void>((resolve) => {
              window.setTimeout(resolve, 0);
            }),
        );
        expect(await crimson.locator('path[d="M20 6 9 17l-5-5"]').count()).toBe(0);
        expect(await blue.locator('path[d="M20 6 9 17l-5-5"]').count()).toBe(1);
        expect((await readClipboard()).legacyWrites).toEqual([blueUrl]);
        await expect.poll(() => blue.locator('path[d="M20 6 9 17l-5-5"]').count()).toBe(0);
      },
    );
  });
});
