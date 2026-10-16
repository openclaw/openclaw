import { expect, it } from "vitest";
import { controlUiBundledSettingsStorageKey } from "../test-helpers/control-ui-e2e.ts";
import { composer, newChatPage } from "./chat-flow-fixtures.test-support.ts";
import {
  createChatFlowE2eSuite,
  expectRequestCountStable,
  requireRecord,
} from "./chat-flow.test-support.ts";
import { installMockGateway } from "./new-session-page.test-support.ts";

const suite = createChatFlowE2eSuite();

// Component tests cannot catch assembled-route/settings/transport regressions.
// Browser identity is emulated here, not a physical software-keyboard claim.
suite.define(() => {
  it.each([
    {
      name: "fresh Android browser",
      userAgent: "Mozilla/5.0 (Linux; Android 15) Mobile",
      saved: false,
    },
    {
      name: "iPhone with saved desktop shortcut",
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
      saved: true,
    },
  ])("requires visible submit buttons in a $name", async ({ userAgent, saved }) => {
    const { page } = await newChatPage(suite, {
      userAgent,
      hasTouch: true,
      isMobile: true,
      viewport: { width: 390, height: 844 },
    });
    const settingsKey = controlUiBundledSettingsStorageKey(suite.server.baseUrl);
    if (saved) {
      await page.addInitScript((key) => {
        if (localStorage.getItem(key) === null) {
          localStorage.setItem(key, JSON.stringify({ chatSendShortcut: "modifier-enter" }));
        }
      }, settingsKey);
    }
    const gateway = await installMockGateway(page, {
      historyMessages: [],
      methodResponses: {
        "sessions.create": { key: "agent:main:mobile-button-proof", runStarted: true },
      },
    });
    for (const { route, selector, button, method } of [
      { route: "chat", selector: ".chat-input", button: "Send message", method: "chat.send" },
      {
        route: "new",
        selector: ".new-session-page__message",
        button: "Start session",
        method: "sessions.create",
      },
    ]) {
      await page.goto(`${suite.server.baseUrl}${route}`);
      const draft = route === "chat" ? composer(page) : page.locator(selector);
      await draft.fill("First line Second line");
      await draft.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(10, 11));
      await draft.press("Enter");
      expect(await draft.inputValue()).toBe("First line\nSecond line");
      expect(await draft.evaluate((element: HTMLTextAreaElement) => element.selectionStart)).toBe(
        11,
      );
      expect(await draft.getAttribute("aria-keyshortcuts")).toBeNull();
      for (const key of [
        "Control+Enter",
        "Meta+Enter",
        "Control+Shift+Enter",
        "Meta+Shift+Enter",
      ]) {
        await draft.press(key);
      }
      await expectRequestCountStable(gateway, method, 0);
      const message = await draft.inputValue();
      await page.getByRole("button", { name: button, exact: true }).click();
      expect(requireRecord((await gateway.waitForRequest(method)).params).message).toBe(
        message.trim(),
      );
    }
    if (saved) {
      expect(
        await page.evaluate(
          (key) => JSON.parse(localStorage.getItem(key) ?? "{}").chatSendShortcut,
          settingsKey,
        ),
      ).toBe("modifier-enter");
    }
  });

  it("retains a saved desktop shortcut in a narrow touchscreen browser", async () => {
    const { page } = await newChatPage(suite, {
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/132.0.0.0 Safari/537.36",
      hasTouch: true,
      viewport: { width: 390, height: 844 },
    });
    await page.addInitScript((key) => {
      localStorage.setItem(key, JSON.stringify({ chatSendShortcut: "modifier-enter" }));
    }, controlUiBundledSettingsStorageKey(suite.server.baseUrl));
    const gateway = await installMockGateway(page, { historyMessages: [] });
    await page.goto(`${suite.server.baseUrl}chat`);
    const chat = composer(page);
    await chat.fill("Desktop first line");
    await chat.press("End");
    await chat.press("Enter");
    await chat.pressSequentially("Second line");
    expect(await chat.inputValue()).toBe("Desktop first line\nSecond line");
    await expectRequestCountStable(gateway, "chat.send", 0);
    await chat.press("Control+Enter");
    expect(requireRecord((await gateway.waitForRequest("chat.send")).params).message).toBe(
      "Desktop first line\nSecond line",
    );
  });
});
