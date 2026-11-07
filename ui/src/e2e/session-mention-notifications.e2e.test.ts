import fs from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import type { MentionInboxItem } from "../../../packages/gateway-protocol/src/index.js";
import { defaultControlUiFeatureMethods } from "../test-helpers/control-ui-e2e-defaults.ts";
import {
  controlUiSessionUrl,
  installMockGateway,
  reconnectMockGateway,
  waitForControlUiRoute,
} from "../test-helpers/control-ui-e2e.ts";
import {
  seedChatSettings,
  splitColumns,
  splitTranscripts,
} from "./chat-layout-fixtures.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Cross-session mention notifications",
  startServerBeforeBrowser: true,
});
const artifacts = path.resolve(".openclaw/tmp/mention-notifications");
const reviewKey = "agent:main:review";
const otherKey = "agent:main:other";
const rows = [
  {
    key: otherKey,
    kind: "direct" as const,
    label: "Planning",
    displayName: "Planning",
    updatedAt: 1,
  },
  {
    key: reviewKey,
    kind: "direct" as const,
    label: "Release review",
    displayName: "Release review",
    updatedAt: 1,
  },
];

async function fixture(page: Page) {
  const gatewayInstanceId = "mention-proof";
  let revision = 0;
  const items: MentionInboxItem[] = [];
  const gateway = await installMockGateway(page, {
    gatewayBootId: gatewayInstanceId,
    presenceUsers: [
      { self: true, id: "bob", name: "Bob", identity: { type: "profile", id: "bob" } },
    ],
    featureMethods: [...defaultControlUiFeatureMethods, "mentions.list", "mentions.dismiss"],
    sessionKey: otherKey,
    sessions: rows,
    sessionTranscripts: splitTranscripts(rows),
    methodResponses: { "mentions.list": { gatewayInstanceId, revision, items: [] } },
  });
  return {
    gateway,
    async arrive(this: void, id: string, sessionKey = reviewKey) {
      const item = {
        id,
        senderProfileId: "alice",
        senderLabel: "Alice",
        sessionKey,
        agentId: "main",
        sessionTitle: sessionKey === reviewKey ? "Release review" : "Planning",
        messageId: id,
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        excerpt: "Could @Bob review the release notes before the team meeting?",
        excerptHighlight: { start: 6, end: 10 },
      };
      items.unshift(item);
      revision += 1;
      const reads = (await gateway.getRequests("mentions.list")).length;
      await gateway.setMethodResponse("mentions.list", { gatewayInstanceId, revision, items });
      await gateway.emitGatewayEvent("mentions.changed", { gatewayInstanceId, revision });
      await gateway.waitForRequest("mentions.list", { after: reads });
      return item;
    },
  };
}

async function screenshot(page: Page, filename: string) {
  await fs.mkdir(artifacts, { recursive: true });
  await page.screenshot({
    path: path.join(artifacts, filename),
    fullPage: true,
    animations: "disabled",
  });
}

suite.define(() => {
  it("keeps Inbox independent, pauses for hover or keyboard focus, and does not replay on reconnect", async () => {
    const context = await suite.browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    const { gateway, arrive } = await fixture(page);
    const card = page.locator(".app-toast").filter({ hasText: "Release review" });
    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await waitForControlUiRoute(page, { pathname: "/new", routeId: "new-session" });
      await gateway.waitForRequest("mentions.list");
      await arrive("mention-proof-1");
      await expect.poll(() => card.count()).toBe(1);
      await card.hover();
      await screenshot(page, "after.png");
      await card.getByRole("button", { name: "Dismiss", exact: true }).click();
      await expect.poll(() => card.count()).toBe(0);
      expect(await gateway.getRequests("mentions.dismiss")).toEqual([]);
      const inbox = page.locator("openclaw-app-sidebar .sidebar-issues-button");
      await inbox.click();
      await expect.poll(() => page.locator('[data-mention-id="mention-proof-1"]').count()).toBe(1);
      await inbox.click();

      await arrive("mention-proof-2");
      await expect.poll(() => card.count()).toBe(1);
      await card.hover();
      await page.clock.install();
      await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 100);
      await page.clock.runFor(6_000);
      expect(await card.count()).toBe(1);
      const action = card.getByRole("link", { name: "View session" });
      await action.focus();
      await page.mouse.move(1, 1);
      await page.clock.runFor(6_000);
      expect(await card.count()).toBe(1);
      await page.keyboard.press("Tab");
      await page.keyboard.press("Tab");
      expect(await card.evaluate((element) => element.contains(document.activeElement))).toBe(
        false,
      );
      await page.clock.runFor(5_500);
      await expect.poll(() => card.count()).toBe(0);
      await page.clock.resume();

      await arrive("mention-proof-3");
      await expect.poll(() => card.count()).toBe(1);
      const readsBeforeReconnect = (await gateway.getRequests("mentions.list")).length;
      await reconnectMockGateway(page, gateway);
      await gateway.waitForRequest("mentions.list", { after: readsBeforeReconnect });
      await expect.poll(() => card.count()).toBe(0);
      await inbox.click();
      await expect.poll(() => page.locator('[data-mention-id="mention-proof-3"]').count()).toBe(1);
      await expect.poll(() => page.getByText("Loading mentions…", { exact: true }).count()).toBe(0);
      await inbox.click();
      await arrive("mention-proof-4");
      await expect.poll(() => card.count()).toBe(1);
      const view = card.getByRole("link", { name: "View session" });
      const href = await view.getAttribute("href");
      await view.click();
      await waitForControlUiRoute(page, {
        pathname: new URL(href!, suite.server.baseUrl).pathname,
        routeId: "chat",
      });
      await screenshot(page, "view-session.png");
      await expect
        .poll(() =>
          page
            .locator("openclaw-chat-pane")
            .filter({ hasText: "Conversation Release review" })
            .count(),
        )
        .toBe(1);
      expect(await gateway.getRequests("mentions.dismiss")).toEqual([]);
    } finally {
      await context.close();
    }
  });

  it("suppresses either visible desktop pane but allows a hidden mobile pane", async () => {
    const context = await suite.browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    await seedChatSettings(page, suite.server.baseUrl, { chatSplitLayout: splitColumns(rows, 0) });
    const { gateway, arrive } = await fixture(page);
    const reviewPane = page
      .locator(".chat-split-view__pane")
      .filter({ hasText: "Conversation Release review" });
    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, otherKey));
      await expect.poll(() => reviewPane.isVisible()).toBe(true);
      await gateway.waitForRequest("mentions.list");
      await arrive("desktop-review");
      await arrive("desktop-planning", otherKey);
      await page.waitForTimeout(200);
      expect(await page.locator(".app-toast").count()).toBe(0);
      await screenshot(page, "desktop-split.png");

      await page.setViewportSize({ width: 390, height: 844 });
      await expect.poll(() => reviewPane.isVisible()).toBe(false);
      await arrive("mobile-planning", otherKey);
      await page.waitForTimeout(200);
      expect(await page.locator(".app-toast").count()).toBe(0);
      await arrive("mobile-hidden-review");
      const card = page.locator(".app-toast").filter({ hasText: "Release review" });
      await expect.poll(() => card.count()).toBe(1);
      await screenshot(page, "mobile-hidden-pane.png");
    } finally {
      await context.close();
    }
  });
});
