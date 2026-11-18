import type { Page } from "playwright";
import { expect, it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Command palette quick switcher" });

const NOW = 1794600000000;
const sessions = (
  [
    ["Release notes", 1_000, false],
    ["Deploy check", 2_000, true],
    ["Design review", 3_000, false],
    ["Customer import", 4_000, true],
  ] as const
).map(([label, age, unread], index) => ({
  label,
  activity: NOW - age,
  unread,
  key: `agent:main:dashboard:00000000-0000-4000-8000-00000000000${index + 1}`,
}));

async function openFirstChat(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "platform", { value: "MacIntel" });
  });
  await installMockGateway(page, {
    sessionKey: sessions[0]!.key,
    sessions: sessions.map(({ key, label, activity, unread }) => ({
      key,
      label,
      displayName: label,
      kind: "direct",
      createdAt: NOW - 60_000,
      updatedAt: activity,
      lastActivityAt: activity,
      unread,
    })),
    sessionTranscripts: Object.fromEntries(
      sessions.map(({ key, label }) => [
        key,
        { messages: [{ role: "assistant", content: [{ type: "text", text: `${label} reply` }] }] },
      ]),
    ),
  });
  await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessions[0]!.key));
  await active(page, "Release notes");
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

async function openSwitcher(page: Page) {
  await page.keyboard.press("Meta+K");
  await page.locator(".cmd-palette__results").waitFor();
}

function chatRows(page: Page) {
  return page
    .locator('.cmd-palette__item--session[role="option"] .cmd-palette__item-title')
    .allTextContents()
    .then((titles) => titles.map((title) => title.trim()));
}

suite.define(() => {
  it("opens on unread chats and jumps to the newest one with Enter", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 820 } }, async ({ page }) => {
      await openFirstChat(page);

      await openSwitcher(page);
      await expect
        .poll(() => chatRows(page))
        .toEqual(["Deploy check", "Customer import", "Design review"]);
      const groups = await page.locator(".cmd-palette__group-label").allTextContents();
      expect(groups.slice(0, 3).map((group) => group.replace(/\d+$/u, "").trim())).toEqual([
        "Unread",
        "Recent",
        "Navigation",
      ]);
      await expect
        .poll(() =>
          page
            .locator('[role="option"][aria-selected="true"] .cmd-palette__item-title')
            .textContent(),
        )
        .toBe("Deploy check");

      await page.keyboard.press("Enter");
      await active(page, "Deploy check");

      // The chat that was just read moves to Recent; the next unread one leads.
      await openSwitcher(page);
      await expect
        .poll(() => chatRows(page))
        .toEqual(["Customer import", "Release notes", "Design review"]);
      await page.keyboard.press("Enter");
      await active(page, "Customer import");

      // With nothing unread, Enter returns to the most recently active other chat.
      await openSwitcher(page);
      await expect
        .poll(() => chatRows(page))
        .toEqual(["Release notes", "Deploy check", "Design review"]);
      expect(await page.locator(".cmd-palette__item--unread").count()).toBe(0);
      await page.keyboard.press("Enter");
      await active(page, "Release notes");
    });
  });
});
