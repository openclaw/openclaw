import type { BrowserContext, Page } from "playwright";
import { expect, it } from "vitest";
import type { NativeBrowserMessage, NativeBrowserReply } from "../app/native-browser-bridge.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createLightDesktopControlUiContextOptions } from "./control-ui-browser-options.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "native link routing",
  trackBrowserContexts: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

async function newBrowserContext() {
  const context = await suite.newBrowserContext(createLightDesktopControlUiContextOptions());
  await context.route("https://example.com/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Report</title>" }),
  );
  return context;
}

type LinkTestWindow = Window & {
  openclawNativeLinkMessages?: unknown[];
  openclawNativeBrowserMessages?: NativeBrowserMessage[];
  openclawModifiedLinkClick?: { defaultPrevented: boolean; metaKey: boolean };
};
const linkMessages = (page: Page) =>
  page.evaluate(() => (window as LinkTestWindow).openclawNativeLinkMessages);
const nativeBrowserMessages = (page: Page) =>
  page.evaluate(() => (window as LinkTestWindow).openclawNativeBrowserMessages);

async function openChat(context: BrowserContext, text: string) {
  const page = await context.newPage();
  await installMockGateway(page, {
    historyMessages: [
      { role: "assistant", timestamp: Date.now(), content: [{ type: "text", text }] },
    ],
  });
  await page.goto(`${suite.server.baseUrl}chat`);
  return { page, link: page.getByRole("link", { name: "report" }) };
}
const expectBrowserTab = (page: Page, url: string) =>
  expect
    .poll(() => nativeBrowserMessages(page))
    .toContainEqual(
      expect.objectContaining({ type: "open", url, tabId: expect.stringMatching(/^mac-/) }),
    );

suite.define(() => {
  it("opens native Browser panel tabs and keeps external link actions", async () => {
    const context = await newBrowserContext();
    await context.grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: new URL(suite.server.baseUrl).origin,
    });
    await context.addInitScript(() => {
      const messages: unknown[] = [];
      const browserMessages: NativeBrowserMessage[] = [];
      Object.assign(window, {
        openclawNativeLinkMessages: messages,
        openclawNativeBrowserMessages: browserMessages,
        webkit: {
          messageHandlers: {
            openclawLink: { postMessage: (message: unknown) => messages.push(message) },
            openclawBrowser: {
              postMessage: async (message: NativeBrowserMessage): Promise<NativeBrowserReply> => {
                browserMessages.push(message);
                return message.type === "open" ? { ok: true, tabId: message.tabId } : { ok: true };
              },
            },
          },
        },
      });
    });
    const { page, link } = await openChat(
      context,
      "Read the [report](https://example.com/report), open [Usage](/usage), or inspect `README.md:1`.",
    );

    await link.click();
    await expectBrowserTab(page, "https://example.com/report");
    await expect.poll(() => linkMessages(page)).toEqual([]);

    await page.evaluate(() => {
      const anchor = document.createElement("a");
      anchor.href = "mailto:hello@example.com";
      anchor.textContent = "email support";
      anchor.addEventListener("click", (event) => {
        if (!event.isTrusted) {
          event.preventDefault();
        }
      });
      document.body.append(anchor);
    });
    const emailLink = page.getByRole("link", { name: "email support" });
    await emailLink.focus();
    await page.keyboard.press("Enter");
    await expect
      .poll(() => linkMessages(page))
      .toContainEqual({
        type: "open-link",
        url: "mailto:hello@example.com",
        target: "external",
      });
    const messageCount = (await linkMessages(page))?.length ?? 0;
    await emailLink.evaluate((anchor) => (anchor as HTMLAnchorElement).click());
    await expect.poll(async () => (await linkMessages(page))?.length ?? 0).toBe(messageCount);

    const bubble = page.locator(".chat-bubble");
    // Keep the menu clear of the report link as the Browser panel resizes the bubble.
    await bubble.click({
      button: "right",
      position: { x: 128, y: 2 },
    });
    const replyMenu = page.getByRole("menu", { name: "Message actions" });
    await expect.poll(() => replyMenu.isVisible()).toBe(true);
    await page.evaluate(() => new Promise(requestAnimationFrame));

    await link.click({ button: "right" });
    const menu = page.getByRole("menu", { name: "Link actions" });
    const menuHost = page.locator("openclaw-native-link-menu");
    await expect.poll(() => menu.isVisible()).toBe(true);
    await expect.poll(() => replyMenu.count()).toBe(0);
    await menuHost.getByRole("menuitem", { name: "Open in Default Browser" }).click();
    await expect
      .poll(() => linkMessages(page))
      .toEqual([
        { type: "open-link", url: "mailto:hello@example.com", target: "external" },
        { type: "open-link", url: "https://example.com/report", target: "external" },
      ]);

    await link.click({ button: "right" });
    await menuHost.getByRole("menuitem", { name: "Copy Link" }).click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe("https://example.com/report");

    await page.evaluate(() => {
      const host = window as LinkTestWindow;
      document.addEventListener(
        "click",
        (event) => {
          host.openclawModifiedLinkClick = {
            defaultPrevented: event.defaultPrevented,
            metaKey: event.metaKey,
          };
        },
        { once: true },
      );
    });
    await link.click({ modifiers: ["Meta"] });
    expect(await page.evaluate(() => (window as LinkTestWindow).openclawModifiedLinkClick)).toEqual(
      { defaultPrevented: false, metaKey: true },
    );
    expect(await linkMessages(page)).toHaveLength(2);

    await page.evaluate(() => {
      const dialog = document.createElement("dialog");
      dialog.id = "native-link-routing-modal";
      dialog.setAttribute("aria-label", "Link routing test");
      dialog.innerHTML = '<a href="https://example.com/modal-report">modal report</a>';
      document.body.append(dialog);
      dialog.showModal();
    });
    const modalLink = page.getByRole("link", { name: "modal report" });
    await modalLink.click({ button: "right" });
    await expect.poll(() => menu.isVisible()).toBe(true);
    await page.keyboard.press("Escape");
    await expect.poll(() => menu.count()).toBe(0);
    await expect
      .poll(() =>
        page.locator("#native-link-routing-modal").evaluate((modal) => {
          return (modal as HTMLDialogElement).open;
        }),
      )
      .toBe(true);
    await modalLink.click({ button: "right" });
    const modalBrowserItem = menuHost.getByRole("menuitem", { name: "Open in Browser Panel" });
    await expect.poll(() => modalBrowserItem.isVisible()).toBe(true);
    await modalBrowserItem.click();
    await expectBrowserTab(page, "https://example.com/modal-report");
    expect(await linkMessages(page)).toHaveLength(2);
    await page.evaluate(() => {
      document.querySelector("#native-link-routing-modal")?.remove();
    });

    await page
      .getByRole("paragraph")
      .getByRole("link", { name: "Usage" })
      .click({ button: "right" });
    expect(await page.locator("openclaw-native-link-menu").count()).toBe(0);
    const messageMenu = page.getByRole("menu", { name: "Message actions" });
    await expect.poll(() => messageMenu.isVisible()).toBe(false);
    await page.evaluate(() => new Promise(requestAnimationFrame));
    await page.keyboard.press("Escape");
    await expect.poll(() => messageMenu.count()).toBe(0);
    await page.locator('a.markdown-file-link[data-file-path="README.md"]').click({
      button: "right",
    });
    expect(await page.locator("openclaw-native-link-menu").count()).toBe(0);
  });

  it("keeps ordinary browser navigation when the native bridge is absent", async () => {
    const context = await newBrowserContext();
    const { page, link } = await openChat(
      context,
      "Read the [report](https://example.com/report).",
    );

    await link.click({ button: "right" });
    expect(await page.locator("openclaw-native-link-menu").count()).toBe(0);
    const popupPromise = page.waitForEvent("popup");
    await link.click();
    const popup = await popupPromise;
    await popup.waitForLoadState("domcontentloaded");
    expect(popup.url()).toBe("https://example.com/report");
  });
});
