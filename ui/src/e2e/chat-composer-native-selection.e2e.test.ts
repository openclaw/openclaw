import { webkit, type Browser } from "playwright";
import { expect, it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { waitForGatewayRecoveryScope } from "./new-session-page.test-support.ts";

let webkitBrowser: Browser;
const suite = createControlUiE2eSuite({
  name: "chat composer native selection",
  resources: {
    async run() {
      webkitBrowser = await webkit.launch({ headless: true });
    },
    async close() {
      await webkitBrowser?.close();
    },
  },
});

suite.define(() => {
  it.each(["chromium", "webkit"] as const)(
    "keeps typing in the rich composer when the app's WebKit moves hidden-field selection in %s",
    async (engine) => {
      const options = { viewport: { width: 1280, height: 900 }, serviceWorkers: "block" as const };
      const context =
        engine === "chromium"
          ? await suite.newBrowserContext(options)
          : await webkitBrowser.newContext(options);
      try {
        const page = await context.newPage();
        await page.addInitScript(() => {
          // The macOS app's WKWebView (linked before SDK 15.4) moves the document selection
          // out of the focused editor when setSelectionRange targets an unfocused textarea,
          // unless that textarea is rendered and visibility:hidden or zero-height
          // (WebKit HTMLTextFormControlElement::setSelectionRange). A display:none textarea
          // lands the selection on BODY. Other WebKit and Chromium builds cache it instead;
          // model only that observed platform boundary.
          // oxlint-disable-next-line typescript/unbound-method -- apply preserves the native textarea receiver.
          const setRange = HTMLTextAreaElement.prototype.setSelectionRange;
          HTMLTextAreaElement.prototype.setSelectionRange = function (...args) {
            setRange.apply(this, args);
            const style = getComputedStyle(this);
            const cached =
              style.display !== "none" &&
              (style.visibility === "hidden" || this.clientHeight === 0);
            if (this.isConnected && document.activeElement !== this && !cached) {
              document.getSelection()?.collapse(document.body, 0);
            }
          };
        });
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await installMockGateway(page, {
          presenceUsers: [
            {
              self: true,
              id: "viewer",
              identity: { type: "profile", id: "viewer" },
              name: "Viewer",
            },
          ],
          methodResponses: {
            "users.mentionable": {
              users: [{ profileId: "person", displayName: "Casey Vale", online: true }],
              truncated: false,
            },
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:main"));
        await waitForGatewayRecoveryScope(page);
        const composer = page.locator(".agent-chat__composer-combobox");
        const raw = composer.locator("textarea");
        await raw.click();
        await page.keyboard.type("@Casey");
        await page.getByRole("listbox", { name: "Mention a person" }).getByRole("option").waitFor();
        await page.keyboard.press("Enter");
        const editor = composer.locator('[data-composer-editor="true"]');
        await editor.waitFor();
        const chip = await composer.locator(".chat-composer-mention").boundingBox();
        if (!chip) {
          throw new Error("Selected mention has no geometry");
        }
        const url = page.url();
        await page.mouse.click(chip.x + chip.width + 4, chip.y + chip.height / 2);
        await page.keyboard.type("abc");
        await page.keyboard.press("Backspace");
        await expect.poll(() => raw.inputValue()).toBe("@Casey Vale ab");
        expect(page.url()).toBe(url);
        expect(
          await editor.evaluate((node) =>
            node.contains(document.getSelection()?.anchorNode ?? null),
          ),
        ).toBe(true);
        expect(errors).toEqual([]);
      } finally {
        await (engine === "chromium" ? suite.closeBrowserContext(context) : context.close());
      }
    },
  );
});
