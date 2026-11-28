import type { Locator, Page } from "playwright";
import { it, expect } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { expectRequestCountStable } from "./chat-flow.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import * as ui from "./session-management.compact.test-support.ts";
import {
  controlUiSessionPath,
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
} from "./session-management.test-support.ts";
import { captureFrame } from "./sidebar-assertions.test-support.ts";

const suite = createSessionManagementE2eSuite();
const main = sessionRow("agent:main:main", "Main", 1);
const chats = [
  sessionRow("agent:main:alpha", "Alpha", 4),
  sessionRow("agent:main:bravo", "Bravo", 3),
  sessionRow("agent:main:charlie", "Charlie", 2),
];
const chatKeys = new Set(chats.map((chat) => chat.key));

async function sidebarOrder(page: Page): Promise<string[]> {
  return (
    await page
      .locator("openclaw-app-sidebar .sidebar-recent-session")
      .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-session-key") ?? ""))
  ).filter((key) => chatKeys.has(key));
}

async function openChat(page: Page, key: string) {
  const gateway = await ui.installSessionRows(page, [main, ...chats], {
    sessionArchiveFiltering: true,
    sessionKey: key,
  });
  await page.goto(controlUiSessionUrl(suite.server.baseUrl, key));
  const rowFor = ui.sessionRows(page.locator("openclaw-app-sidebar"));
  for (const chat of chats) {
    await ui.visible(rowFor(chat.key));
  }
  return { gateway, rowFor, order: await sidebarOrder(page) };
}

const path = (page: Page) => new URL(page.url()).pathname;

async function capture(page: Page, name: string, row: Locator) {
  if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
    const dir = createControlUiE2eArtifactDir("archive-advance");
    await captureFrame(dir, name, page.locator(".shell"), [row]);
  }
}

suite.define(() => {
  it.each(["header", "sidebar"] as const)(
    "archiving the open chat from the %s opens the chat below it; Undo only restores the row",
    (surface) =>
      suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
        const { gateway, rowFor, order } = await openChat(page, "agent:main:bravo");
        const index = order.indexOf("agent:main:bravo");
        const below = order[index + 1] ?? order[index - 1]!;
        await capture(page, `${surface}-before.png`, rowFor("agent:main:bravo"));

        await ui.archiveSession(page, rowFor("agent:main:bravo"), surface);
        await ui.visible(ui.button(page, "Undo"));
        await expect.poll(() => path(page)).toBe(controlUiSessionPath(below));
        await ui.expectCount(rowFor("agent:main:bravo"), 0);
        await capture(page, `${surface}-after.png`, rowFor(below));

        await ui.button(page, "Undo").click();
        await ui.visible(rowFor("agent:main:bravo"));
        await expectRequestCountStable(gateway, "sessions.patch", 0);
        expect(path(page)).toBe(controlUiSessionPath(below));
      }),
  );

  it("opens the chat above when the last chat is archived", () =>
    suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const { rowFor, order } = await openChat(page, "agent:main:alpha");
      const last = order.at(-1)!;
      await rowFor(last).click();
      await expect.poll(() => path(page)).toBe(controlUiSessionPath(last));

      await ui.archiveSession(page, rowFor(last), "sidebar");
      await expect.poll(() => path(page)).toBe(controlUiSessionPath(order.at(-2)!));
    }));

  it("keeps the open chat when another chat is archived", () =>
    suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const { rowFor } = await openChat(page, "agent:main:bravo");
      await ui.archiveSession(page, rowFor("agent:main:alpha"), "sidebar");
      await ui.visible(ui.button(page, "Undo"));
      await ui.expectCount(rowFor("agent:main:alpha"), 0);
      expect(path(page)).toBe(controlUiSessionPath("agent:main:bravo"));
    }));
});
