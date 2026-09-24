import type { Page } from "playwright";
import { expect as expectBrowser } from "playwright/test";
import { expect, it } from "vitest";
import type { MentionInboxItem } from "../../../packages/gateway-protocol/src/index.js";
import type { ChatSplitLayout } from "../pages/chat/split-layout-types.ts";
import {
  controlUiBundledSettingsStorageKey,
  defaultControlUiFeatureMethods,
} from "../test-helpers/control-ui-e2e.ts";
import {
  captureUiProof,
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionsListResponse,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();
const targetKey = "agent:main:design-review";
const keys = ["agent:main:gateway-cleanup", targetKey, "agent:main:release-prep"] as const;
const titles = ["Gateway cleanup", "Design review", "Release prep"];
const bootId = "mention-proof-boot";
const previous: MentionInboxItem = {
  id: "previous",
  senderProfileId: "profile-alex",
  senderLabel: "Alex",
  sessionKey: targetKey,
  agentId: "main",
  sessionTitle: "Earlier discussion",
  messageId: "earlier-message",
  createdAt: 1_000,
  expiresAt: 8_640_000_000_000,
  excerpt: "An earlier mention retained in your Inbox.",
};
const arrival: MentionInboxItem = {
  ...previous,
  id: "new-mention",
  sessionTitle: "Design review",
  messageId: "new-message",
  createdAt: 2_000,
  excerpt: "@Taylor can you check the spacing before we ship?",
  excerptMention: { start: 0, end: 7 },
};
const snapshot = (revision: number, items: MentionInboxItem[]) => ({
  gatewayInstanceId: bootId,
  revision,
  items,
});

async function openTab(page: Page, key: string, mobile = false) {
  const gateway = await installMockGateway(page, {
    sessionKey: key,
    gatewayBootId: bootId,
    presenceUsers: [
      {
        self: true,
        id: "profile-taylor",
        identity: { type: "profile", id: "profile-taylor" },
        name: "Taylor",
      },
    ],
    featureMethods: [...defaultControlUiFeatureMethods, "mentions.list", "mentions.dismiss"],
    historyMessages: [
      {
        role: "assistant",
        content: [{ type: "text", text: "The workspace is ready for collaboration." }],
      },
    ],
    methodResponses: {
      "mentions.list": snapshot(1, [previous]),
      "sessions.list": sessionsListResponse(
        keys.map((sessionKey, i) => ({
          key: sessionKey,
          sessionId: sessionKey.split(":").at(-1),
          kind: "direct",
          label: titles[i],
          displayName: titles[i],
          updatedAt: Date.now() - 60_000,
        })),
      ),
    },
  });
  await page.goto(controlUiSessionUrl(suite.server.baseUrl, key));
  await gateway.waitForRequest("mentions.list");
  // The visible Inbox proves that its initial snapshot has been accepted, not
  // merely requested, before the arrival event is sent through the real client.
  if (mobile) {
    await page
      .locator(".topbar-nav-toggle:visible, .chat-pane__nav-toggle:visible")
      .first()
      .click();
  }
  const inbox = page.getByRole("button", { name: /inbox items?$/i });
  await inbox.click();
  await expectBrowser(page.locator('[data-mention-id="previous"]')).toBeVisible();
  await page.keyboard.press("Escape");
  await expectBrowser(inbox).toHaveAttribute("aria-expanded", "false");
  if (mobile) {
    await page.keyboard.press("Escape");
    await expectBrowser(page.locator(".shell")).not.toHaveClass(/shell--nav-drawer-open/);
  }
  await expectBrowser(page.locator(".app-toast--notification")).toHaveCount(0);
  return gateway;
}

async function deliver(gateway: Awaited<ReturnType<typeof openTab>>, item = arrival, revision = 2) {
  await gateway.setMethodResponse("mentions.list", snapshot(revision, [item, previous]));
  await gateway.emitGatewayEvent("mentions.changed", { gatewayInstanceId: bootId, revision });
}

async function openSplitTab(page: Page) {
  const layout: ChatSplitLayout = {
    activePaneId: "p1",
    columnWeights: [0.5, 0.5],
    columns: [
      { id: "c1", paneWeights: [1], panes: [{ id: "p1", sessionKey: keys[0] }] },
      { id: "c2", paneWeights: [1], panes: [{ id: "p2", sessionKey: targetKey }] },
    ],
  };
  await page.addInitScript(
    ({ storageKey, layout: initialLayout }) => {
      localStorage.setItem(storageKey, JSON.stringify({ chatSplitLayout: initialLayout }));
    },
    { storageKey: controlUiBundledSettingsStorageKey(suite.server.baseUrl), layout },
  );
  const gateway = await openTab(page, keys[0]);
  const cells = page.locator(".chat-split-view__cell");
  await expectBrowser(cells).toHaveCount(2);
  await expectBrowser(cells.first()).toHaveClass(/chat-split-view__cell--active/);
  await expectBrowser(
    cells.first().locator(".agent-chat__composer-combobox textarea"),
  ).toBeVisible();
  return { gateway, cells };
}

async function expectInboxMentions(page: Page, items: readonly MentionInboxItem[]) {
  const inbox = page.getByRole("button", { name: /inbox items?$/i });
  await inbox.click();
  for (const item of items) {
    await expectBrowser(page.locator(`[data-mention-id="${item.id}"]`)).toBeVisible();
  }
  await page.keyboard.press("Escape");
  await expectBrowser(inbox).toHaveAttribute("aria-expanded", "false");
}

suite.define(() => {
  it("suppresses mentions for a visible desktop split even when another pane is active", async () => {
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      const { gateway, cells } = await openSplitTab(page);
      await expectBrowser(cells.last()).toBeVisible();
      await expectBrowser(cells.last()).not.toHaveClass(/chat-split-view__cell--active/);
      await deliver(gateway);
      // Accepted Inbox content fences the negative toast assertion after delivery.
      await expectInboxMentions(page, [arrival]);
      expect(await page.locator(".app-toast--notification").count()).toBe(0);
      await expectBrowser(page).toHaveURL(controlUiSessionUrl(suite.server.baseUrl, keys[0]));
      expect(await gateway.getRequests("mentions.dismiss")).toHaveLength(0);
    });
  });

  it("tracks a hidden split across 1100/1099 without unrelated shell rerenders and retires its active toast", async () => {
    await suite.withPage({ viewport: { width: 1100, height: 900 } }, async ({ page }) => {
      const { gateway, cells } = await openSplitTab(page);
      await expectBrowser(cells.last()).toBeVisible();
      await page.setViewportSize({ width: 1099, height: 900 });
      await expectBrowser(cells.last()).toBeHidden();
      await deliver(gateway);
      const toast = page.locator(".app-toast--notification");
      await expectBrowser(toast).toBeVisible();
      await expectBrowser(toast.locator(".mention-toast__session")).toHaveText(
        arrival.sessionTitle,
      );
      await toast.getByRole("button", { name: "View session" }).focus();
      await page.setViewportSize({ width: 1100, height: 900 });
      await expectBrowser(cells.last()).toBeVisible();
      await expectBrowser(cells.first()).toHaveClass(/chat-split-view__cell--active/);
      await expectBrowser(toast).toHaveCount(0);
      await expectInboxMentions(page, [arrival]);
      expect(await gateway.getRequests("mentions.dismiss")).toHaveLength(0);
    });
  });

  it("retires a queued mention when its split becomes visible without dropping other queued sessions", async () => {
    await suite.withPage({ viewport: { width: 1099, height: 900 } }, async ({ page }) => {
      const { gateway, cells } = await openSplitTab(page);
      await expectBrowser(cells.last()).toBeHidden();
      const first: MentionInboxItem = {
        ...arrival,
        id: "first-outside-split",
        sessionKey: keys[2],
        sessionTitle: "Release prep",
        createdAt: 1_500,
        excerpt: "Please review the release checklist.",
        excerptMention: undefined,
      };
      const last: MentionInboxItem = {
        ...first,
        id: "last-outside-split",
        createdAt: 3_000,
        excerpt: "The final release checklist is ready.",
      };
      await gateway.setMethodResponse(
        "mentions.list",
        snapshot(2, [last, arrival, first, previous]),
      );
      await gateway.emitGatewayEvent("mentions.changed", {
        gatewayInstanceId: bootId,
        revision: 2,
      });
      const toast = page.locator(".app-toast--notification");
      await expectBrowser(toast.locator(".mention-toast__excerpt")).toHaveText(first.excerpt!);
      await toast.getByRole("button", { name: "View session" }).focus();
      await page.setViewportSize({ width: 1100, height: 900 });
      await expectBrowser(cells.last()).toBeVisible();
      await expectBrowser(cells.first()).toHaveClass(/chat-split-view__cell--active/);
      await toast.getByRole("button", { name: "Dismiss", exact: true }).click();
      // Hold the promoted toast so an incorrectly queued B cannot expire into a pass.
      await expectBrowser(toast.locator(".mention-toast__excerpt")).not.toHaveText(first.excerpt!);
      await toast.getByRole("button", { name: "View session" }).focus();
      // The still-hidden session follows directly: B must not get promoted from FIFO.
      await expectBrowser(toast.locator(".mention-toast__excerpt")).toHaveText(last.excerpt!);
      await toast.getByRole("button", { name: "Dismiss", exact: true }).click();
      await expectBrowser(toast).toHaveCount(0);
      await expectInboxMentions(page, [first, arrival, last]);
      expect(await gateway.getRequests("mentions.dismiss")).toHaveLength(0);
    });
  });

  it("notifies only the other two tabs and keeps toast dismissal local", async () => {
    await suite.withPage(
      { viewport: { width: 1280, height: 900 }, colorScheme: "dark" },
      async ({ page, context }) => {
        const pages = [page, await context.newPage(), await context.newPage()] as const;
        const gateways = [
          await openTab(pages[0], keys[0]),
          await openTab(pages[1], keys[1]),
          await openTab(pages[2], keys[2]),
        ] as const;
        await captureUiProof(suite, page, "01-before-mention.png");
        for (const gateway of gateways) {
          await deliver(gateway);
        }
        const toast = page.locator(".app-toast--notification");
        await expectBrowser(toast).toBeVisible();
        await toast.hover({ position: { x: 6, y: 6 } });
        await expectBrowser(pages[1].locator(".app-toast--notification")).toHaveCount(0);
        const other = pages[2].locator(".app-toast--notification");
        await expectBrowser(other).toBeVisible();
        await other.getByRole("button", { name: "View session" }).focus();
        await expectBrowser(toast).toContainText("mentioned you");
        await expectBrowser(toast.locator(".mention-toast__sender-line")).toHaveText(
          "Alex mentioned you",
        );
        await expectBrowser(toast.locator(".mention-toast__session")).toHaveText(
          arrival.sessionTitle,
        );
        await expectBrowser(toast.locator(".mention-toast__excerpt")).toHaveText(arrival.excerpt!);
        await toast.evaluate(async (element) => {
          await Promise.all(element.getAnimations().map((animation) => animation.finished));
        });
        await expectBrowser(toast.locator(".mention-excerpt__highlight")).toHaveText("@Taylor");
        await captureUiProof(suite, page, "02-after-desktop-dark.png");
        await toast.getByRole("button", { name: "Dismiss", exact: true }).click();
        await expectBrowser(toast).toHaveCount(0);
        await expectBrowser(other).toBeVisible();
        await other.getByRole("button", { name: "View session" }).click();
        await expectBrowser(other).toHaveCount(0);
        await expectBrowser(pages[2]).toHaveURL(
          controlUiSessionUrl(suite.server.baseUrl, targetKey),
        );
        for (const gateway of gateways) {
          expect(await gateway.getRequests("mentions.dismiss")).toHaveLength(0);
        }
        await page.reload();
        await gateways[0].waitForRequest("mentions.list");
        await expectBrowser(page.locator(".app-toast--notification")).toHaveCount(0);
      },
    );
  });

  it.each([
    { name: "desktop-light", width: 1280, height: 900, theme: "light" as const },
    { name: "mobile-dark", width: 390, height: 844, theme: "dark" as const },
    { name: "narrow-dark", width: 320, height: 740, theme: "dark" as const },
  ])(
    "keeps long notification content readable in $name",
    async ({ name, width, height, theme }) => {
      await suite.withPage(
        { viewport: { width, height }, colorScheme: theme },
        async ({ page }) => {
          const gateway = await openTab(page, keys[0], width < 768);
          const item = {
            ...arrival,
            excerpt:
              "… background. Before we ship, @Taylor can you check the spacing? Later details. Later details. Later details. Later details. Later details. Later details. Later details. Later details. Later details. Later details. Later details. Later details. Later details. Later details. …",
            excerptMention: { start: 30, end: 37 },
            senderLabel: "Alexandria Catherine Montgomery-Worthington",
            sessionTitle: "Release readiness — notification delivery and workspace collaboration",
          };
          await deliver(gateway, item);
          const toast = page.locator(".app-toast--notification");
          await expectBrowser(toast).toBeVisible();
          await toast.hover({ position: { x: 6, y: 6 } });
          await expectBrowser(toast).toContainText("mentioned you");
          const layout = await toast.evaluate((element) => {
            const box = element.getBoundingClientRect();
            return {
              right: box.right,
              left: box.left,
              overflow: element.scrollWidth > element.clientWidth,
            };
          });
          expect(layout.overflow).toBe(false);
          expect(layout.left).toBeGreaterThanOrEqual(0);
          expect(layout.right).toBeLessThanOrEqual(width);
          const action = await toast.getByRole("button", { name: "View session" }).boundingBox();
          const heading = await toast.locator(".app-toast__title").boundingBox();
          const excerpt = await toast.locator(".mention-toast__excerpt").boundingBox();
          await expectBrowser(toast.locator(".mention-excerpt__highlight")).toHaveText("@Taylor");
          await expectBrowser(toast.locator(".mention-toast__excerpt")).toContainText(
            "Before we ship, @Taylor can you check the spacing?",
          );
          const highlight = await toast.locator(".mention-excerpt__highlight").boundingBox();
          expect(highlight!.y).toBeGreaterThanOrEqual(excerpt!.y);
          expect(highlight!.y + highlight!.height).toBeLessThanOrEqual(
            excerpt!.y + excerpt!.height,
          );
          if (width < 768) {
            const dismiss = await toast.locator(".app-toast__dismiss").boundingBox();
            expect(dismiss!.width).toBeGreaterThanOrEqual(44);
            expect(dismiss!.height).toBeGreaterThanOrEqual(44);
            expect(dismiss!.x).toBeGreaterThanOrEqual(heading!.x + heading!.width);
            const session = await toast.locator(".mention-toast__session").boundingBox();
            expect(session!.x + session!.width).toBeLessThanOrEqual(dismiss!.x);
            expect(dismiss!.y + dismiss!.height).toBeLessThanOrEqual(excerpt!.y);
          }
          await captureUiProof(suite, page, "03-after-" + name + ".png");
          // Routing into the mentioned session retires its active toast without a
          // server dismissal; this is a tab-local presentation decision.
          if (width < 768) {
            // Tap beyond the compact visible border, inside the retained touch area.
            await page.mouse.click(action!.x + action!.width / 2, action!.y + action!.height + 4);
          } else {
            await toast.getByRole("button", { name: "View session" }).click();
          }
          await expectBrowser(page).toHaveURL(controlUiSessionUrl(suite.server.baseUrl, targetKey));
          await expectBrowser(toast).toHaveCount(0);
          expect(await gateway.getRequests("mentions.dismiss")).toHaveLength(0);
        },
      );
    },
  );
});
