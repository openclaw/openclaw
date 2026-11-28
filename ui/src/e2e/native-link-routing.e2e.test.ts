import type { BrowserContext, Page } from "playwright";
import { expect, it } from "vitest";
import type { NativeBrowserMessage, NativeBrowserReply } from "../app/native-browser-bridge.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createLightDesktopControlUiContextOptions } from "./control-ui-browser-options.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { installNativeWebChrome } from "./native-nav.test-support.ts";

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

async function openChat(
  context: BrowserContext,
  text: string,
  setup?: (page: Page) => Promise<void>,
) {
  const page = await context.newPage();
  await setup?.(page);
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

  it("keeps the Mac tab visible behind the command palette and restores the live view", async () => {
    const context = await newBrowserContext();
    await context.addInitScript(() => {
      const browserMessages: NativeBrowserMessage[] = [];
      let resumeShow: (() => void) | undefined;
      window.addEventListener("test:release-native-show", () => resumeShow?.());
      Object.assign(window, {
        openclawNativeBrowserMessages: browserMessages,
        webkit: {
          messageHandlers: {
            openclawBrowser: {
              postMessage: async (message: NativeBrowserMessage): Promise<NativeBrowserReply> => {
                browserMessages.push(message);
                if (message.type === "open") {
                  const state = {
                    revision: 1,
                    tabs: [
                      {
                        id: message.tabId,
                        sessionKey: message.sessionKey,
                        url: message.url,
                        title: "Report",
                        openedBy: "web",
                        loading: false,
                        canGoBack: false,
                        canGoForward: false,
                      },
                    ],
                  };
                  Object.assign(window, { __OPENCLAW_NATIVE_BROWSER__: state });
                  window.dispatchEvent(
                    new CustomEvent("openclaw:native-browser-state", { detail: state }),
                  );
                  return { ok: true, tabId: message.tabId };
                }
                if (message.type === "snapshot") {
                  const canvas = document.createElement("canvas");
                  const paint = canvas.getContext("2d")!;
                  paint.fillStyle = "#27375c";
                  paint.fillRect(0, 0, canvas.width, canvas.height);
                  return {
                    ok: true,
                    dataUrl: canvas.toDataURL(),
                    cssWidth: canvas.width,
                    cssHeight: canvas.height,
                  };
                }
                if (
                  message.type === "present" &&
                  message.visible &&
                  browserMessages.filter((entry) => entry.type === "present" && entry.visible)
                    .length === 2
                ) {
                  await new Promise<void>((resolve) => {
                    resumeShow = resolve;
                  });
                }
                return { ok: true };
              },
            },
          },
        },
      });
    });
    const { page, link } = await openChat(
      context,
      "Read the [report](https://example.com/report).",
      installNativeWebChrome,
    );
    await link.click();
    const lastPresentation = async () =>
      (await nativeBrowserMessages(page))?.findLast((message) => message.type === "present");
    await expect.poll(lastPresentation).toMatchObject({ visible: true });

    await page.keyboard.press("ControlOrMeta+K");
    const input = page.locator(".cmd-palette__input:not([disabled])");
    const backdrop = page.locator(".bp-native-backdrop");
    await expect.poll(() => input.evaluate((node) => node === document.activeElement)).toBe(true);
    await expect.poll(lastPresentation).toMatchObject({ visible: false });
    await expect.poll(() => backdrop.isVisible(), { timeout: 2_000 }).toBe(true);
    expect(await backdrop.evaluate((node) => getComputedStyle(node).pointerEvents)).toBe("none");

    const capturedFrame = await backdrop.getAttribute("src");
    await input.press("Tab");
    await input.evaluate((element) => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 8;
      const encoded = canvas.toDataURL().split(",")[1]!;
      const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
      const clipboard = new DataTransfer();
      clipboard.items.add(new File([bytes], "report.png", { type: "image/png" }));
      element.dispatchEvent(
        new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: clipboard }),
      );
    });
    await page.getByRole("button", { name: "Open image report.png", exact: true }).click();
    const preview = page.getByRole("dialog", { name: "Image preview: report.png", exact: true });
    await preview.waitFor({ state: "visible" });
    await expect.poll(() => backdrop.isVisible()).toBe(false);
    await page.keyboard.press("Escape");
    await preview.waitFor({ state: "hidden" });
    await expect.poll(() => backdrop.isVisible()).toBe(true);
    expect(await backdrop.getAttribute("src")).toBe(capturedFrame);
    expect(await lastPresentation()).toMatchObject({ visible: false });
    expect(
      (await nativeBrowserMessages(page))?.filter((message) => message.type === "snapshot"),
    ).toHaveLength(1);

    await page.keyboard.press("Escape");
    await expect.poll(lastPresentation).toMatchObject({ visible: true });
    await page.keyboard.press("ControlOrMeta+K");
    await expect.poll(() => input.evaluate((node) => node === document.activeElement)).toBe(true);
    await expect.poll(lastPresentation).toMatchObject({ visible: false });
    await expect.poll(() => backdrop.count()).toBe(1);
    await page.evaluate(() => window.dispatchEvent(new Event("test:release-native-show")));
    await page.keyboard.press("Escape");
    await expect.poll(lastPresentation).toMatchObject({ visible: true });
    await expect.poll(() => backdrop.count()).toBe(0);
    expect(
      (await nativeBrowserMessages(page))?.filter((message) => message.type === "open"),
    ).toHaveLength(1);
  });
});
