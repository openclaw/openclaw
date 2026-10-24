import type { Locator, Page } from "playwright";
import { expect as browserExpect } from "playwright/test";
import { expect, it } from "vitest";
import { openChatConversationOptions } from "../test-helpers/chat-layout-menu.ts";
import {
  controlUiBundledSettingsStorageKey,
  createControlUiMockBootstrapConfig,
  controlUiSessionUrl,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Speech bubble mode" });
const background = (bubble: Locator, enabled: boolean) => {
  const assertion = browserExpect(bubble);
  return (enabled ? assertion.not : assertion).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
};
function bubbleControls(page: Page) {
  const trigger = page.locator(".chat-header-session-menu__trigger").filter({ visible: true });
  const close = async () => {
    const host = page.locator(".chat-mobile-host").filter({ visible: true });
    if (await host.isVisible()) {
      await host
        .locator(".chat-mobile-host__header")
        .getByRole("button", { name: "Close", exact: true })
        .click();
      await host.waitFor({ state: "hidden" });
    } else {
      await trigger.click();
    }
  };
  const stored = (field = "chatBubbleSessionKeys") =>
    page.evaluate(({ key, property }) => JSON.parse(localStorage.getItem(key) ?? "{}")[property], {
      key: controlUiBundledSettingsStorageKey(suite.server.baseUrl),
      property: field,
    });
  const change = async (enabled: boolean) => {
    const options = await openChatConversationOptions(page);
    const toggle = options
      .getByRole("menuitemcheckbox", { name: "Speech bubbles", exact: true })
      .or(options.getByRole("button", { name: "Speech bubbles", exact: true }));
    await browserExpect(toggle).toBeVisible();
    const selected =
      (await toggle.getAttribute("role")) === "menuitemcheckbox" ? "aria-checked" : "aria-pressed";
    await browserExpect(toggle).toHaveAttribute(selected, String(!enabled));
    await toggle.click();
    await browserExpect(toggle).toHaveAttribute(selected, String(enabled));
  };
  return { close, stored, change };
}

suite.define(() => {
  it("keeps session bubbles independent through reloads, reactions, and mobile changes", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const sessionKey = "agent:main:main";
      const otherSessionKey = "agent:main:dashboard:other-bubbles";
      const sessionId = "bubble-session";
      const messageId = "bubble-prompt";
      const gateway = await installMockGateway(page, {
        sessionKey,
        sessions: [
          { key: sessionKey, sessionId },
          { key: otherSessionKey, sessionId: "other-bubble-session", label: "Other conversation" },
        ],
        sessionTranscripts: {
          [otherSessionKey]: {
            messages: [{ role: "assistant", content: "This conversation keeps its own view." }],
          },
        },
        historyMessages: [
          ["user", messageId, "Can we make this feel more like a conversation?"],
          ["assistant", "bubble-reply", "Absolutely."],
        ].map(([role, id, content], index) => ({
          role,
          content,
          __openclaw: { id, seq: index + 1 },
        })),
      });
      const chatUrl = controlUiSessionUrl(suite.server.baseUrl, sessionKey);
      const otherChatUrl = controlUiSessionUrl(suite.server.baseUrl, otherSessionKey);
      const settingsKey = controlUiBundledSettingsStorageKey(suite.server.baseUrl);
      await page.route("**/control-ui-config.json", async (route) => {
        const response = await route.fetch();
        await route.fulfill({
          response,
          json: { ...(await response.json()), chatBubblesEnabled: true },
        });
      });
      await page.addInitScript(
        ({ key, session }) => {
          if (!localStorage.getItem(key)) {
            localStorage.setItem(key, JSON.stringify({ chatBubbleDisabledSessionKeys: [session] }));
          }
        },
        { key: settingsKey, session: sessionKey },
      );
      const {
        change: changeBubbles,
        close: closeBubbleMenu,
        stored: storedBubbleSessions,
      } = bubbleControls(page);
      await page.goto(chatUrl);
      const chat = page.locator("section.chat");
      const assistant = chat.locator(".chat-group.assistant .chat-bubble").first();
      const user = chat.locator(".chat-group.user .chat-bubble").first();
      await browserExpect(assistant).toContainText("Absolutely.");
      await background(assistant, false);
      await changeBubbles(true);
      await browserExpect.poll(storedBubbleSessions).toEqual([sessionKey]);
      await closeBubbleMenu();
      await browserExpect(chat).toHaveClass(/chat--bubbles/);
      await background(assistant, true);
      const bounds = await Promise.all([assistant.boundingBox(), user.boundingBox()]);
      expect(bounds[0]!.x).toBeLessThan(bounds[1]!.x);
      await gateway.emitGatewayEvent("session.reaction", {
        sessionKey,
        sessionId,
        agentId: "main",
        messageId,
        emoji: "👍",
        action: "added",
        actor: { type: "agent", id: "main", label: "Assistant" },
        reactions: [
          { emoji: "👍", count: 1, identities: [{ id: "agent:main", label: "Assistant" }] },
        ],
      });
      const reaction = chat.locator(
        `.chat-message-reactions[data-message-id="${messageId}"] .chat-reaction-chip[aria-label="👍 1"]`,
      );
      await browserExpect(reaction).toBeVisible();
      await page.goto(otherChatUrl);
      await browserExpect(chat).toContainText("This conversation keeps its own view.");
      await browserExpect(chat).not.toHaveClass(/chat--bubbles/);
      await page.setViewportSize({ width: 390, height: 844 });
      // Closed menus reconcile their parked presentation on open.
      await changeBubbles(true);
      await browserExpect(
        page.locator('.chat-mobile-host__page[data-mobile-page="session-advanced"]'),
      ).toBeVisible();
      await closeBubbleMenu();
      await browserExpect(chat).toHaveClass(/chat--bubbles/);
      await browserExpect.poll(storedBubbleSessions).toEqual([sessionKey, otherSessionKey]);
      await page.reload();
      await browserExpect(chat).toHaveClass(/chat--bubbles/);
      await changeBubbles(false);
      await closeBubbleMenu();
      await browserExpect(chat).not.toHaveClass(/chat--bubbles/);
      await browserExpect.poll(storedBubbleSessions).toEqual([sessionKey]);
      await page.goto(chatUrl);
      await browserExpect(chat).toHaveClass(/chat--bubbles/);
      expect(await chat.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      await page.reload();
      await browserExpect(chat).toHaveClass(/chat--bubbles/);
      await browserExpect(assistant).toContainText("Absolutely.");

      await changeBubbles(false);
      await closeBubbleMenu();
      await browserExpect(chat).not.toHaveClass(/chat--bubbles/);
      await browserExpect.poll(storedBubbleSessions).toBeUndefined();
      await background(assistant, false);
    });
  });
  it("defaults Home on only while the lab is enabled and retains an explicit opt-out", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      let enabled = false;
      const gateway = await installMockGateway(page, {
        historyMessages: [{ role: "assistant", content: "Home conversation." }],
      });
      await page.route("**/control-ui-config.json", (route) =>
        route.fulfill({
          json: { ...createControlUiMockBootstrapConfig(), chatBubblesEnabled: enabled },
        }),
      );
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:main"));
      const chat = page.locator("section.chat");
      await browserExpect(chat.getByText("Home conversation.", { exact: true })).toBeVisible();
      await browserExpect(chat).not.toHaveClass(/chat--bubbles/);
      enabled = true;
      await gateway.emitGatewayEvent("config.changed", {});
      await browserExpect(chat).toHaveClass(/chat--bubbles/);
      const controls = bubbleControls(page);
      await controls.change(false);
      await controls.close();
      await browserExpect(chat).not.toHaveClass(/chat--bubbles/);
      enabled = false;
      await gateway.emitGatewayEvent("config.changed", {});
      await browserExpect
        .poll(() => controls.stored("chatBubbleDisabledSessionKeys"))
        .toEqual(["agent:main:main"]);
      enabled = true;
      await gateway.emitGatewayEvent("config.changed", {});
      await browserExpect(chat).not.toHaveClass(/chat--bubbles/);
      await page.reload();
      await browserExpect(chat.getByText("Home conversation.", { exact: true })).toBeVisible();
      await browserExpect(chat).not.toHaveClass(/chat--bubbles/);
    });
  });
});
