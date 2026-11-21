import type { Page } from "playwright";
import { expect, it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { installNativeWebChrome } from "./native-nav.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Sidebar session shortcuts" });

const sessions = ["Alpha", "Bravo", "Charlie", "Delta"].map((label, index) => ({
  label,
  key: `agent:main:dashboard:00000000-0000-4000-8000-00000000000${index + 1}`,
}));

async function openSidebar(page: Page, options: { desktopHost: boolean }) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "platform", { value: "MacIntel" });
  });
  if (options.desktopHost) {
    await installNativeWebChrome(page);
  }
  await installMockGateway(page, {
    sessionKey: sessions[0]!.key,
    sessions: sessions.map(({ key, label }, index) => ({
      key,
      label,
      displayName: label,
      kind: "direct",
      updatedAt: 1794600000000 - index * 1000,
    })),
    sessionTranscripts: Object.fromEntries(
      sessions.map(({ key, label }) => [
        key,
        { messages: [{ role: "assistant", content: [{ type: "text", text: `${label} reply` }] }] },
      ]),
    ),
  });
  await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessions[0]!.key));
  await active(page, "Alpha");
  // Keys go to the composer, where people type when they switch sessions.
  await page.locator(".chat-pane-cache__pane--active textarea").first().focus();
}

async function active(page: Page, label: string) {
  await expect
    .poll(() =>
      page
        .locator('.sidebar-sessions .sidebar-recent-session__link[aria-current="page"]')
        .first()
        .textContent(),
    )
    .toContain(label);
  await page
    .locator(".chat-pane-cache__pane--active")
    .getByText(`${label} reply`, { exact: true })
    .waitFor();
}

suite.define(() => {
  it("opens sidebar sessions by number and returns to recent ones in the desktop app", async () => {
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      await openSidebar(page, { desktopHost: true });
      await page.keyboard.press("Meta+3");
      await active(page, "Charlie");
      await page.keyboard.press("Meta+9");
      await active(page, "Delta");
      await page.keyboard.press("Meta+2");
      await active(page, "Bravo");

      // A quick Control+Tab returns to the session opened before this one.
      await page.keyboard.press("Control+Tab");
      await active(page, "Delta");
      await page.keyboard.press("Control+Tab");
      await active(page, "Bravo");

      // Holding Control walks further back, and releasing it keeps that session.
      await page.keyboard.down("Control");
      await page.keyboard.press("Tab");
      await active(page, "Delta");
      await page.keyboard.press("Tab");
      await active(page, "Charlie");
      await page.keyboard.up("Control");
      await page.keyboard.press("Control+Tab");
      await active(page, "Bravo");
      // Shift walks the other way, starting from the least recent session.
      await page.keyboard.press("Control+Shift+Tab");
      await active(page, "Alpha");
    });
  });

  it("leaves the chords to the browser outside desktop apps", async () => {
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      await openSidebar(page, { desktopHost: false });
      const claimed = await page.evaluate(() => {
        const event = new KeyboardEvent("keydown", {
          key: "2",
          code: "Digit2",
          metaKey: true,
          bubbles: true,
          cancelable: true,
        });
        document.activeElement?.dispatchEvent(event);
        return event.defaultPrevented;
      });
      expect(claimed).toBe(false);
      await page.keyboard.press("Control+Tab");
      await page.waitForTimeout(300);
      await active(page, "Alpha");
    });
  });
});
