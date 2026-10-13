import { writeFileSync } from "node:fs";
import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect as browserExpect } from "playwright/test";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiBundledSettingsStorageKey,
  createControlUiMockBootstrapConfig,
  controlUiSessionUrl,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Speech bubble mode" });

suite.define(() => {
  it("keeps session bubbles independent through reloads, reactions, and streamed replies", async () => {
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
          {
            role: "user",
            content: "Can we make this feel more like a conversation?",
            __openclaw: { id: messageId, seq: 1 },
          },
          {
            role: "assistant",
            content:
              "Absolutely. Your messages stay on the right, and my replies get a bubble on the left. We can still keep code and longer explanations easy to read.",
            __openclaw: { id: "bubble-reply", seq: 2 },
          },
          {
            role: "user",
            content: "And react to a prompt when a quick acknowledgment is enough.",
            __openclaw: { id: "bubble-follow-up", seq: 3 },
          },
        ],
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
      const openBubbleMenu = async () => {
        await page.locator(".chat-header-session-menu__trigger").click();
        const menu = page.locator("wa-dropdown.chat-header-session-menu");
        const view = menu.getByRole("menuitem", { name: "View", exact: true });
        if (
          await menu.evaluate((el) => el.classList.contains("chat-header-session-menu--compact"))
        ) {
          await view.click();
        } else {
          await view.hover();
        }
        const toggle = menu.getByRole("menuitemcheckbox", { name: "Speech bubbles", exact: true });
        await browserExpect(toggle).toBeVisible();
        return toggle;
      };
      const closeBubbleMenu = async () => {
        await page.locator(".chat-header-session-menu__trigger").click();
      };
      const storedBubbleSessions = () =>
        page.evaluate(
          (key) => JSON.parse(localStorage.getItem(key) ?? "{}").chatBubbleSessionKeys,
          settingsKey,
        );
      await page.goto(chatUrl);
      const chat = page.locator("section.chat");
      const assistant = chat.locator(".chat-group.assistant .chat-bubble").first();
      const user = chat.locator(".chat-group.user .chat-bubble").first();
      await browserExpect(assistant).toContainText("Absolutely.");
      expect(await assistant.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
        "rgba(0, 0, 0, 0)",
      );
      const capture = async (name: string) => {
        if (!process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR) {
          return;
        }
        const frame = await takeControlUiScreenshotFrame(page, chat, [assistant, user], {
          animations: "disabled",
          elements: [chat],
        });
        writeFileSync(path.join(suite.artifactDir, name + ".png"), frame.elements[0]!.png);
      };
      await capture("before");
      const toggle = await openBubbleMenu();
      await browserExpect(toggle).toHaveAttribute("aria-checked", "false");
      await toggle.click();
      await browserExpect(toggle).toHaveAttribute("aria-checked", "true");
      await browserExpect.poll(storedBubbleSessions).toEqual([sessionKey]);
      await closeBubbleMenu();
      await browserExpect(chat).toHaveClass(/chat--bubbles/);
      await browserExpect(assistant).toContainText("Absolutely.");
      expect(await assistant.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(
        "rgba(0, 0, 0, 0)",
      );
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
        '.chat-message-reactions[data-message-id="' +
          messageId +
          '"] .chat-reaction-chip[aria-label="👍 1"]',
      );
      await browserExpect(reaction).toBeVisible();
      await capture("after");
      await page.goto(otherChatUrl);
      await browserExpect(chat).toContainText("This conversation keeps its own view.");
      await browserExpect(chat).not.toHaveClass(/chat--bubbles/);
      await page.setViewportSize({ width: 390, height: 844 });
      await browserExpect(page.locator("wa-dropdown.chat-header-session-menu")).toHaveClass(
        /chat-header-session-menu--compact/,
      );
      const otherToggle = await openBubbleMenu();
      await browserExpect(otherToggle).toHaveAttribute("aria-checked", "false");
      await otherToggle.click();
      await browserExpect(otherToggle).toHaveAttribute("aria-checked", "true");
      await closeBubbleMenu();
      await browserExpect(chat).toHaveClass(/chat--bubbles/);
      await browserExpect.poll(storedBubbleSessions).toEqual([sessionKey, otherSessionKey]);
      await page.reload();
      await browserExpect(chat).toHaveClass(/chat--bubbles/);
      const reloadedToggle = await openBubbleMenu();
      await browserExpect(reloadedToggle).toHaveAttribute("aria-checked", "true");
      await reloadedToggle.click();
      await closeBubbleMenu();
      await browserExpect(chat).not.toHaveClass(/chat--bubbles/);
      await browserExpect.poll(storedBubbleSessions).toEqual([sessionKey]);
      await page.goto(chatUrl);
      await browserExpect(chat).toHaveClass(/chat--bubbles/);
      await browserExpect(assistant).toContainText("Absolutely.");
      await capture("after-mobile");
      expect(await chat.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      await page.reload();
      await browserExpect(chat).toHaveClass(/chat--bubbles/);
      await browserExpect(assistant).toContainText("Absolutely.");

      await page
        .locator(".agent-chat__composer-combobox textarea")
        .fill("Keep this view while replying.");
      await page.getByRole("button", { name: "Send message", exact: true }).click();
      const request = await gateway.waitForRequest("chat.send");
      const params = asOptionalRecord(request.params);
      if (!params || typeof params.idempotencyKey !== "string") {
        throw new Error("Expected chat.send to include its run idempotency key");
      }
      expect(params.sessionKey).toBe(sessionKey);
      const runId = params.idempotencyKey;
      const streamedText = "The streamed reply keeps this session’s bubbles.";
      await gateway.emitGatewayEvent("chat", {
        runId,
        sessionKey,
        seq: 1,
        state: "delta",
        deltaText: streamedText,
        message: { role: "assistant", content: [{ type: "text", text: streamedText }] },
      });
      const streamedReply = chat.locator(".chat-group.assistant .chat-bubble", {
        hasText: streamedText,
      });
      await browserExpect(streamedReply).toBeVisible();
      expect(await streamedReply.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(
        "rgba(0, 0, 0, 0)",
      );
      await gateway.emitChatFinal({ runId, sessionKey, text: streamedText });
      await browserExpect(chat).toHaveClass(/chat--bubbles/);
      await browserExpect(streamedReply).toHaveCount(1);
      await browserExpect(streamedReply).toBeVisible();
      const finalToggle = await openBubbleMenu();
      await finalToggle.click();
      await browserExpect(finalToggle).toHaveAttribute("aria-checked", "false");
      await closeBubbleMenu();
      await browserExpect(chat).not.toHaveClass(/chat--bubbles/);
      await browserExpect.poll(storedBubbleSessions).toBeUndefined();
      expect(await assistant.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
        "rgba(0, 0, 0, 0)",
      );
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
      await page.locator(".chat-header-session-menu__trigger").click();
      const menu = page.locator("wa-dropdown.chat-header-session-menu");
      await menu.getByRole("menuitem", { name: "View", exact: true }).hover();
      await menu.getByRole("menuitemcheckbox", { name: "Speech bubbles", exact: true }).click();
      await page.locator(".chat-header-session-menu__trigger").click();
      await browserExpect(chat).not.toHaveClass(/chat--bubbles/);
      enabled = false;
      await gateway.emitGatewayEvent("config.changed", {});
      await browserExpect
        .poll(() =>
          page.evaluate(
            (key) => JSON.parse(localStorage.getItem(key) ?? "{}").chatBubbleDisabledSessionKeys,
            controlUiBundledSettingsStorageKey(suite.server.baseUrl),
          ),
        )
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
