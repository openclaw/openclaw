import { expect, it } from "vitest";
import {
  createChatFlowE2eSuite,
  expectRequestCountStable,
  installMockGateway,
  requireRecord,
  requireString,
  waitForRequests,
} from "./chat-flow.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("preserves IME reply before deliberate Escape abort", async () => {
    const context = await suite.newBrowserContext(createControlUiE2eContextOptions());
    try {
      const page = await context.newPage();
      const quote = "Keep this persisted message as the reply source.";
      const gateway = await installMockGateway(page, {
        sessionKey: "agent:main:main",
        historyMessages: [
          {
            role: "user",
            content: [{ type: "text", text: quote }],
            timestamp: 1_800_000_000_000,
            __openclaw: { id: "ime-reply-source", seq: 1 },
          },
        ],
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      const pane = page.locator(".chat-pane-cache__pane--active");
      const composer = pane.locator(".agent-chat__composer-combobox textarea");
      const initialText = "Keep this run active while composing a reply.";
      await composer.fill(initialText);
      await pane.getByRole("button", { name: "Send message", exact: true }).click();
      const send = await gateway.waitForRequest("chat.send");
      const sendParams = requireRecord(send.params);
      const sessionKey = requireString(sendParams.sessionKey, "active session");
      const runId = requireString(sendParams.idempotencyKey, "active run");
      expect(sendParams).toMatchObject({
        message: initialText,
        sessionKey: "agent:main:main",
        idempotencyKey: runId,
      });
      const stop = pane.getByRole("button", { name: "Stop generating", exact: true });
      await stop.waitFor({ state: "visible" });
      await expect.poll(() => composer.inputValue()).toBe("");

      await pane
        .locator('.chat-bubble[data-entry-id="ime-reply-source"]')
        .click({ button: "right" });
      const menu = page.locator(".chat-reply-context-menu");
      await menu.getByRole("menuitem", { name: "Reply to message", exact: true }).click();
      await menu.waitFor({ state: "detached" });
      const preview = pane.locator(".chat-reply-preview");
      await preview.waitFor({ state: "visible" });
      expect(await preview.locator(".chat-reply-preview__text").textContent()).toBe(quote);
      expect(await composer.evaluate((element) => document.activeElement === element)).toBe(true);
      const draft = "Preserve this unsent reply draft.";
      await composer.fill(draft);

      // Synthetic IME events exercise the application flow, not native IME delivery.
      for (const mode of ["isComposing", "keyCode229"]) {
        const fields = await composer.evaluate((element, compositionMode) => {
          const event = new KeyboardEvent("keydown", {
            key: "Escape",
            bubbles: true,
            cancelable: true,
            isComposing: compositionMode === "isComposing",
            keyCode: compositionMode === "keyCode229" ? 229 : 0,
          });
          element.dispatchEvent(event);
          return {
            key: event.key,
            bubbles: event.bubbles,
            cancelable: event.cancelable,
            isComposing: event.isComposing,
            keyCode: event.keyCode,
            defaultPrevented: event.defaultPrevented,
          };
        }, mode);
        expect(fields).toEqual({
          key: "Escape",
          bubbles: true,
          cancelable: true,
          isComposing: mode === "isComposing",
          keyCode: mode === "keyCode229" ? 229 : 0,
          defaultPrevented: false,
        });
        expect(await preview.locator(".chat-reply-preview__text").textContent()).toBe(quote);
        expect(await composer.inputValue()).toBe(draft);
        expect(await composer.evaluate((element) => document.activeElement === element)).toBe(true);
        await expectRequestCountStable(gateway, "chat.send", 1);
        await expectRequestCountStable(gateway, "chat.abort", 0);
      }

      await composer.fill("");
      await stop.waitFor({ state: "visible" });
      const primary = pane.locator(".agent-chat__composer-actions .chat-send-btn--send");
      expect(await primary.count()).toBe(0);
      expect(await preview.locator(".chat-reply-preview__text").textContent()).toBe(quote);
      const composingDraft = "Preserve this composing reply draft.";
      await composer.evaluate((element, value) => {
        if (!(element instanceof HTMLTextAreaElement)) {
          throw new Error("Expected composer textarea");
        }
        element.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
        element.value = value;
        element.dispatchEvent(
          new InputEvent("input", {
            bubbles: true,
            data: value,
            inputType: "insertCompositionText",
            isComposing: true,
          }),
        );
      }, composingDraft);
      // Stop becoming a follow-up action proves the composing input rerendered the pane.
      await primary.waitFor({ state: "visible" });
      expect(await primary.isEnabled()).toBe(true);
      await stop.waitFor({ state: "detached" });
      expect(await composer.inputValue()).toBe(composingDraft);
      expect(await composer.evaluate((element) => document.activeElement === element)).toBe(true);
      await page.keyboard.press("Escape");
      expect(await preview.locator(".chat-reply-preview__text").textContent()).toBe(quote);
      expect(await composer.inputValue()).toBe(composingDraft);
      expect(await composer.evaluate((element) => document.activeElement === element)).toBe(true);
      await expectRequestCountStable(gateway, "chat.send", 1);
      await expectRequestCountStable(gateway, "chat.abort", 0);

      await composer.evaluate((element) => {
        element.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
      });
      await page.keyboard.press("Escape");
      await preview.waitFor({ state: "detached" });
      expect(await composer.inputValue()).toBe(composingDraft);
      expect(await composer.evaluate((element) => document.activeElement === element)).toBe(true);
      await expectRequestCountStable(gateway, "chat.send", 1);
      await expectRequestCountStable(gateway, "chat.abort", 0);

      await page.keyboard.press("Escape");
      const abort = await gateway.waitForRequest("chat.abort");
      const interrupted = pane.locator(".agent-chat__run-status--interrupted");
      await interrupted.waitFor({ state: "visible" });
      expect(await interrupted.textContent()).toContain("Interrupted");
      await expect
        .poll(() => pane.locator(".agent-chat__run-status-announcement").textContent())
        .toBe("Interrupted");
      expect(requireRecord(abort.params)).toEqual({ sessionKey, runId });
      await stop.waitFor({ state: "detached" });
      expect(await composer.inputValue()).toBe(composingDraft);
      expect(await composer.evaluate((element) => document.activeElement === element)).toBe(true);
      await expectRequestCountStable(gateway, "chat.send", 1);
      await expectRequestCountStable(gateway, "chat.abort", 1);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it.each(["queue", "steer", "collect", "followup"] as const)(
    "explains and submits the opposite of %s with modified Enter",
    async (followUpMode) => {
      const context = await suite.newBrowserContext(createControlUiE2eContextOptions());
      const page = await context.newPage();
      const inheritsQueueMode = followUpMode === "collect" || followUpMode === "followup";
      const runtimeConfig = {
        messages: { queue: { mode: inheritsQueueMode ? followUpMode : "steer" } },
      };
      const gateway = await installMockGateway(
        page,
        inheritsQueueMode
          ? {
              methodResponses: {
                "config.get": {
                  config: runtimeConfig,
                  hash: "composer-shortcut-config",
                  issues: [],
                  raw: JSON.stringify(runtimeConfig),
                  runtimeConfig,
                  valid: true,
                },
              },
            }
          : {},
      );

      try {
        await page.goto(`${suite.server.baseUrl}settings/appearance`);
        const followUp = page.locator("[data-settings-follow-up-mode]");
        await followUp.waitFor({ state: "visible" });
        if (!inheritsQueueMode) {
          await followUp.selectOption(followUpMode);
        }
        await page.locator("[data-settings-send-shortcut]").selectOption("enter");
        await page.goto(`${suite.server.baseUrl}chat`);

        const composer = page.locator(".agent-chat__composer-combobox textarea");
        const initialText = "keep the shortcut run active";
        await composer.fill(initialText);
        await page.getByRole("button", { name: "Send message" }).click();
        const initialSend = await gateway.waitForRequest("chat.send");
        const runId = requireString(requireRecord(initialSend.params).idempotencyKey, "active run");
        await page.getByRole("button", { name: "Stop generating" }).waitFor();

        const followUpText = "use the alternate follow-up action";
        await composer.fill(followUpText);
        const primary = page.locator(".agent-chat__composer-actions .chat-send-btn--send");
        await primary.hover();
        const tooltip =
          followUpMode === "steer"
            ? "Steer ⏎ · Queue ⌘/Ctrl+Enter"
            : "Queue ⏎ · Steer ⌘/Ctrl+Enter";
        const tooltipContent = primary.locator("..").locator("wa-tooltip .tooltip-content");
        await expect.poll(() => tooltipContent.textContent()).toBe(tooltip);
        await tooltipContent.waitFor({ state: "visible" });
        await composer.press("Control+Enter");

        if (followUpMode === "steer") {
          const queuedRow = page.locator(".chat-queue__item", { hasText: followUpText });
          await queuedRow.waitFor();
          await expectRequestCountStable(gateway, "chat.send", 1);
          await gateway.setMethodResponse("chat.history", {
            messages: [{ role: "user", content: [{ type: "text", text: initialText }] }],
            sessionId: "session:agent:main:main",
            sessionInfo: {
              key: "main",
              hasActiveRun: false,
              activeRunIds: [],
              lastRunId: runId,
              status: "done",
            },
            thinkingLevel: null,
          });
          await gateway.emitChatFinal({ runId, text: "The original run is done." });
          const sends = await waitForRequests(gateway, "chat.send", 2);
          const queuedParams = requireRecord(sends[1]?.params);
          expect(queuedParams).toMatchObject({
            message: followUpText,
            sessionKey: "agent:main:main",
          });
          expect(queuedParams).not.toHaveProperty("queueMode");
          await queuedRow.waitFor({ state: "detached" });
          await expectRequestCountStable(gateway, "chat.send", 2);
        } else {
          const sends = await waitForRequests(gateway, "chat.send", 2);
          const steerParams = requireRecord(sends[1]?.params);
          expect(steerParams).toMatchObject({
            deliver: false,
            message: followUpText,
            queueMode: "steer",
            sessionKey: "agent:main:main",
          });
          expect(steerParams).not.toHaveProperty("expectedRunId");
          expect(steerParams).not.toHaveProperty("expectedLeafEntryId");
        }
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );
});
