import { webkit, type Browser } from "playwright";
import { expect, it } from "vitest";
import {
  controlUiSessionUrl,
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

let webkitBrowser: Browser;
const suite = createControlUiE2eSuite({
  name: "mention invitation editing",
  resources: {
    async run() {
      webkitBrowser = await webkit.launch({ headless: true });
    },
    async close() {
      await webkitBrowser?.close();
    },
  },
});
const key = "agent:main:dashboard:619dfdde-5f1b-4f7f-be9c-68ab72f812f8";

suite.define(() => {
  it.each([
    ["chromium", false],
    ["webkit", false],
    ["chromium", true],
    ["webkit", true],
  ] as const)(
    "keeps editing through Return selection and invitation access in %s (Cocoa SDK15: %s)",
    async (engine, cocoaSelection) => {
      for (const route of ["chat", "new"] as const) {
        const options = {
          viewport: { width: 1280, height: 900 },
          serviceWorkers: "block" as const,
        };
        const context =
          engine === "chromium"
            ? await suite.newBrowserContext(options)
            : await webkitBrowser.newContext(options);
        try {
          const page = await context.newPage();
          if (cocoaSelection) {
            await page.addInitScript(() => {
              // WKWebView apps linked before macOS 15.4 move the document selection
              // when setSelectionRange targets a display:none textarea. Linux WebKit
              // always caches it instead; model only this observed platform boundary.
              // oxlint-disable-next-line typescript/unbound-method -- apply preserves the native textarea receiver.
              const setRange = HTMLTextAreaElement.prototype.setSelectionRange;
              HTMLTextAreaElement.prototype.setSelectionRange = function (...args) {
                setRange.apply(this, args);
                if (
                  this.isConnected &&
                  getComputedStyle(this).display === "none" &&
                  document.activeElement !== this
                ) {
                  document.getSelection()?.collapse(document.body, 0);
                }
              };
            });
          }
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(error.message));
          await installMockGateway(page, {
            sessionKey: key,
            featureMethods: [
              ...defaultControlUiFeatureMethods,
              "users.mentionable",
              "session.members.listEvidence",
              "session.members.setAccess",
            ],
            sessions: [
              createControlUiSessionRow(key, "Mention editing", 1, {
                sharingRole: "owner",
                visibility: "read-only",
              }),
            ],
            presenceUsers: [
              {
                self: true,
                id: "owner",
                identity: { type: "profile", id: "owner" },
                name: "Owner",
              },
            ],
            methodResponses: {
              "users.mentionable": {
                users: [
                  {
                    profileId: "person",
                    displayName: "Casey Vale",
                    inviteAccessOptions: ["read", "suggest", "send"],
                  },
                ],
                truncated: false,
              },
              "session.members.listEvidence": {
                sessionKey: key,
                owner: { type: "human", id: "owner", label: "Owner" },
                members: [],
                identities: [],
                permissions: [],
                role: "owner",
                allowedVisibilities: ["shared", "read-only", "suggest", "draft"],
              },
            },
          });
          await page.goto(
            route === "chat"
              ? controlUiSessionUrl(suite.server.baseUrl, key)
              : suite.server.baseUrl + "new?agent=main",
          );
          const composer = page.locator(".agent-chat__composer-combobox");
          const raw = composer.locator("textarea");
          await raw.click();
          await page.keyboard.type("@Casey");
          await page
            .getByRole("listbox", { name: "Mention a person" })
            .getByRole("option")
            .waitFor();
          await page.keyboard.press("Enter");
          const editor = composer.locator('[data-composer-editor="true"]');
          await editor.waitFor();
          const chip = await composer.locator(".chat-composer-mention").boundingBox();
          if (!chip) {
            throw new Error("Selected mention has no geometry");
          }
          const url = page.url();
          await page.mouse.click(chip.x + chip.width + 4, chip.y + chip.height / 2);
          expect(
            await editor.evaluate((node) =>
              node.contains(document.getSelection()?.anchorNode ?? null),
            ),
          ).toBe(true);
          await page.keyboard.type("abc");
          await page.keyboard.press("Backspace");
          await expect.poll(() => raw.inputValue()).toBe("@Casey Vale ab");
          expect(page.url()).toBe(url);
          await page.keyboard.type(" after mention");
          await expect.poll(() => raw.inputValue()).toBe("@Casey Vale ab after mention");
          const trigger = page.locator(".chat-invite-access").getByRole("button");
          const level = page.getByRole("menuitemradio", { name: "Can suggest", exact: true });
          await trigger.click();
          if (route === "new") {
            await page.keyboard.press("ArrowDown");
            await page.keyboard.press("Enter");
          } else {
            await level.click();
          }
          await expect
            .poll(() => editor.evaluate((node) => document.activeElement === node))
            .toBe(true);
          // Space activates a focused button; it must be typed into the retained editor instead.
          await page.keyboard.type(" after level");
          await expect
            .poll(() => raw.inputValue())
            .toBe("@Casey Vale ab after mention after level");
          expect(await editor.evaluate((node) => document.activeElement === node)).toBe(true);
          expect(await trigger.textContent()).toBe("Can suggest");
          expect(await editor.evaluate(() => document.getSelection()?.isCollapsed)).toBe(true);

          // Only successful selection returns to editing. Escape returns to the trigger,
          // and clicking the composer remains an outside dismissal of this menu.
          await trigger.click();
          await page.keyboard.press("Escape");
          expect(await trigger.evaluate((node) => document.activeElement === node)).toBe(true);
          await trigger.click();
          await editor.click();
          await expect.poll(() => level.isVisible()).toBe(false);
          expect(await editor.evaluate((node) => document.activeElement === node)).toBe(true);
          expect(errors).toEqual([]);
        } finally {
          await (engine === "chromium" ? suite.closeBrowserContext(context) : context.close());
        }
      }
    },
  );
});
