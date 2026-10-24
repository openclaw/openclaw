import { expect, it } from "vitest";
import { createControlUiE2eSuite } from "../../e2e/control-ui-e2e-suite.test-support.ts";
import { installMockGateway } from "../../test-helpers/control-ui-e2e.ts";

type ClipboardFaultState = {
  execSucceeds: boolean;
  legacyWrites: string[];
  pendingRejects: Array<(reason?: unknown) => void> | null;
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
        const configureClipboard = (patch: Partial<ClipboardFaultState>) =>
          page.evaluate((value) => Object.assign(window.lobsterdexClipboardFault, value), patch);
        const rejectWrite = (index: number) =>
          page.evaluate((pendingIndex) => {
            window.lobsterdexClipboardFault.pendingRejects?.[pendingIndex]?.(
              new DOMException("Write rejected", "NotAllowedError"),
            );
          }, index);
        await page.addInitScript(() => {
          const state: ClipboardFaultState = {
            execSucceeds: true,
            legacyWrites: [],
            pendingRejects: null,
          };
          Object.defineProperty(window, "lobsterdexClipboardFault", { value: state });
          Object.defineProperty(navigator, "clipboard", {
            configurable: true,
            value: {
              writeText() {
                if (!state.pendingRejects) {
                  return Promise.reject(
                    new DOMException("Clipboard access denied", "NotAllowedError"),
                  );
                }
                return new Promise<void>((_resolve, reject) => {
                  state.pendingRejects?.push(reject);
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
        const url = (id: string) =>
          `${new URL(suite.server.baseUrl).origin}/settings/lobsterdex#lobsterdex-${id}`;
        const checkmark = 'path[d="M20 6 9 17l-5-5"]';
        const expectNewestCopy = async () => {
          expect(await crimson.locator(checkmark).count()).toBe(0);
          expect(await blue.locator(checkmark).count()).toBe(1);
          expect((await readClipboard()).legacyWrites).toEqual([url("blue")]);
        };
        await configureClipboard({ execSucceeds: false });
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
          execSucceeds: true,
          legacyWrites: [],
          pendingRejects: [],
        });
        await crimson.focus();
        await page.keyboard.press("Enter");
        await blue.tap();
        await expect
          .poll(() => page.evaluate(() => window.lobsterdexClipboardFault.pendingRejects?.length))
          .toBe(2);
        expect(await pageRoot.getByRole("alert").count()).toBe(0);

        await rejectWrite(1);
        await blue.locator(checkmark).waitFor();
        await expectNewestCopy();
        await expect.poll(() => pageRoot.getByRole("status").textContent()).toContain("Copied!");

        await rejectWrite(0);
        await page.evaluate(
          () =>
            new Promise<void>((resolve) => {
              window.setTimeout(resolve, 0);
            }),
        );
        await expectNewestCopy();
        await expect.poll(() => blue.locator(checkmark).count()).toBe(0);
      },
    );
  });
});
