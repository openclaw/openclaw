import { expect, it } from "vitest";
import { controlUiBundledSettingsStorageKey } from "../test-helpers/control-ui-e2e.ts";
import { composer, newChatPage } from "./chat-flow-fixtures.test-support.ts";
import {
  captureUiProof,
  captureUiProofEnabled,
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
  ])("requires visible submit buttons in a $name", async ({ name, userAgent, saved }) => {
    const { context, page } = await newChatPage(suite, {
      userAgent,
      hasTouch: true,
      isMobile: true,
      viewport: { width: 390, height: 844 },
      ...(captureUiProofEnabled
        ? { recordVideo: { dir: suite.artifactDir, size: { width: 390, height: 844 } } }
        : {}),
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
    await page.goto(`${suite.server.baseUrl}chat`);
    const chat = composer(page);
    await chat.fill("First line");
    await chat.press("End");
    await chat.press("Enter");
    await chat.pressSequentially("Second line");
    expect(await chat.inputValue()).toBe("First line\nSecond line");
    await chat.press("Control+Enter");
    await chat.press("Meta+Enter");
    await expectRequestCountStable(gateway, "chat.send", 0);
    const chatDraft = await chat.inputValue();
    await captureUiProof(suite, page, "mobile-submit", `${name}-chat-newline.png`);
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    expect(requireRecord((await gateway.waitForRequest("chat.send")).params).message).toBe(
      chatDraft.trim(),
    );

    await page.goto(`${suite.server.baseUrl}new`);
    const draft = page.locator(".new-session-page__message");
    await draft.fill("New session first line");
    await draft.press("End");
    await draft.press("Enter");
    await draft.pressSequentially("Second line");
    expect(await draft.inputValue()).toBe("New session first line\nSecond line");
    await draft.press("Control+Enter");
    await draft.press("Meta+Enter");
    await expectRequestCountStable(gateway, "sessions.create", 0);
    const newSessionDraft = await draft.inputValue();
    await captureUiProof(suite, page, "mobile-submit", `${name}-start-newline.png`);
    await page.getByRole("button", { name: "Start session", exact: true }).click();
    expect(requireRecord((await gateway.waitForRequest("sessions.create")).params).message).toBe(
      newSessionDraft.trim(),
    );
    if (saved) {
      expect(
        await page.evaluate(
          (key) => JSON.parse(localStorage.getItem(key) ?? "{}").chatSendShortcut,
          settingsKey,
        ),
      ).toBe("modifier-enter");
    }
    const video = page.video();
    await suite.closeBrowserContext(context);
    if (video) {
      console.log(`Mobile submit recording: ${await video.path()}`);
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
