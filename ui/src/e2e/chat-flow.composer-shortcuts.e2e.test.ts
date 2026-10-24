import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { chatFixture, expectText } from "./chat-flow-fixtures.test-support.ts";
import {
  confirmIme,
  chatMessage,
  createChatFlowE2eSuite,
  installMockGateway,
  requireRecord,
  requireString,
} from "./chat-flow.test-support.ts";
import { waitForCommittedComposerDraft } from "./settle.test-support.ts";

const suite = createChatFlowE2eSuite();
const sessionKey = "agent:main:main";
const exactText = (root: Locator | Page, value: string) => root.getByText(value, { exact: true });

async function openChat(options: Parameters<typeof installMockGateway>[1] = {}, route = "chat") {
  const { page, gateway } = await chatFixture(suite, options);
  await page.goto(`${suite.server.baseUrl}${route}`);
  const pane = page.locator(".chat-pane-cache__pane--active");
  const composer = page.locator(".agent-chat__composer-combobox textarea");
  const button = (name: string) => pane.getByRole("button", { name, exact: true });
  return { page, gateway, pane, composer, button };
}

suite.define(() => {
  it("persists the chat send shortcut and keeps multiline and IME input safe", async () => {
    const { page, gateway, composer } = await openChat();
    const expectUnsent = async (text: string) => {
      expect(await composer.inputValue()).toBe(text);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
    };
    await composer.waitFor({ state: "visible", timeout: 10_000 });

    await composer.fill("日本語");
    expect(await confirmIme(composer, "日本語")).toBe(false);
    await expectUnsent("日本語");
    await composer.dispatchEvent("keyup", { key: "Enter" });

    // Software keyboards can commit text through input events without keydown.
    await composer.evaluate((textarea: HTMLTextAreaElement) => {
      textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      textarea.dispatchEvent(
        new CompositionEvent("compositionend", { bubbles: true, data: "中文" }),
      );
      textarea.dispatchEvent(
        new InputEvent("beforeinput", { bubbles: true, inputType: "insertText", data: "中文" }),
      );
      textarea.value = "中文";
      textarea.dispatchEvent(
        new InputEvent("input", { bubbles: true, inputType: "insertText", data: "中文" }),
      );
    });
    await expectUnsent("中文");
    await composer.dispatchEvent("keydown", {
      key: "Enter",
      keyCode: 229,
      isComposing: false,
    });
    await expectUnsent("中文");
    await composer.dispatchEvent("keyup", { key: "Enter" });
    await composer.press("Shift+Enter");
    expect(await composer.inputValue()).toContain("\n");
    expect(await gateway.getRequests("chat.send")).toHaveLength(0);

    // Firefox fill() emits compositionend; type deliberate sends through keyboard events.
    await composer.fill("");
    await composer.pressSequentially("default enter send");
    await composer.press("Enter");
    const defaultParams = requireRecord((await gateway.waitForRequest("chat.send")).params);
    expect(defaultParams.message).toBe("default enter send");
    await gateway.emitChatFinal({
      runId: requireString(defaultParams.idempotencyKey, "default send idempotency key"),
      text: "Default shortcut received.",
    });
    await exactText(page.locator(".chat-thread-inner"), "Default shortcut received.").waitFor({
      timeout: 10_000,
    });

    await page.goto(`${suite.server.baseUrl}settings/appearance`);
    const shortcutSelect = page.locator("[data-settings-send-shortcut]");
    await shortcutSelect.selectOption("modifier-enter");
    expect(await shortcutSelect.inputValue()).toBe("modifier-enter");

    await page.goto(`${suite.server.baseUrl}chat`);
    await composer.waitFor({ state: "visible", timeout: 10_000 });
    expect(await composer.getAttribute("aria-keyshortcuts")).toBe("Control+Enter Meta+Enter");

    await composer.fill("plain enter stays in the draft");
    await composer.press("Enter");
    expect(await composer.inputValue()).toContain("\n");
    expect(await gateway.getRequests("chat.send")).toHaveLength(0);

    await composer.fill("composition must not send");
    await composer.dispatchEvent("compositionstart");
    await composer.press("Control+Enter");
    await composer.dispatchEvent("compositionend");
    expect(await gateway.getRequests("chat.send")).toHaveLength(0);

    await composer.fill("");
    await composer.pressSequentially("modifier send");
    await composer.press("Meta+Enter");
    const modifierRequest = await gateway.waitForRequest("chat.send");
    expect(requireRecord(modifierRequest.params).message).toBe("modifier send");
  });

  it("restores a quoted draft after reload and keeps cancellation cleared", async () => {
    const quote = "Review all 60 checklist items before sending the summary.";
    const draft = "Please explain the quoted checklist.";
    const { page, gateway, pane, button } = await openChat({
      sessionKey,
      historyMessages: [
        chatMessage("assistant", quote, {
          timestamp: 1_800_000_000_000,
          __openclaw: { id: "quoted-checklist", seq: 1 },
        }),
      ],
    });
    const composer = pane.getByRole("textbox", { name: "Chat composer" });
    const group = pane.locator(".chat-group.assistant").filter({ hasText: quote });
    await group.hover();
    await group.getByRole("button", { name: "Reply to message", exact: true }).click();
    const preview = pane.locator(".chat-reply-preview.composer-context-strip");
    await preview.waitFor({ state: "visible" });
    await composer.fill(draft);
    const scopeKey = `chat:v3:${sessionKey}\u0000agent:main`;
    const settledDraft = (text: string | null, reply?: string | null) =>
      waitForCommittedComposerDraft(page, scopeKey, text, 0, undefined, reply);
    await settledDraft(draft);
    await page.reload();
    await expect.poll(() => composer.inputValue()).toBe(draft);
    await group.waitFor({ state: "visible" });

    await expectText(preview.locator(".chat-reply-preview__text"), quote);
    await button("Send message").click();
    const request = await gateway.waitForRequest("chat.send");
    await settledDraft(null, null);
    expect(requireRecord(request.params)).toMatchObject({
      sessionKey,
      message: draft,
      replyToId: "quoted-checklist",
    });
    const runId = requireString(requireRecord(request.params).idempotencyKey, "quoted run");
    await pane.locator('.chat-bubble[data-entry-id="quoted-checklist"]').click({ button: "right" });
    await gateway.emitGatewayEvent("chat", {
      runId,
      sessionKey,
      state: "delta",
      message: chatMessage("assistant", "Still working."),
    });
    await exactText(pane.locator(".chat-bubble.streaming"), "Still working.").waitFor();
    await page
      .locator(".chat-reply-context-menu")
      .getByRole("menuitem", { name: "Reply to message", exact: true })
      .click();
    await preview.waitFor({ state: "visible" });
    await expectText(preview.locator(".chat-reply-preview__text"), quote);
    await preview.getByRole("button", { name: "Cancel reply", exact: true }).click();
    await settledDraft(null, null);
    await gateway.emitChatFinal({
      runId,
      text: "The checklist is ready.",
    });
    await exactText(pane.locator(".chat-group.assistant"), "The checklist is ready.").waitFor();
    await button("Stop generating").waitFor({ state: "detached" });
    const unquotedDraft = "Keep the text without a quote.";
    await composer.fill(unquotedDraft);
    await settledDraft(unquotedDraft, null);
    await group.hover();
    await group.getByRole("button", { name: "Reply to message", exact: true }).click();
    await preview.waitFor({ state: "visible" });
    await settledDraft(unquotedDraft, "quoted-checklist");
    await preview.getByRole("button", { name: "Cancel reply", exact: true }).click();
    await preview.waitFor({ state: "hidden" });
    await settledDraft(unquotedDraft, null);
    await page.reload();
    await expect.poll(() => composer.inputValue()).toBe(unquotedDraft);
    expect(await preview.count()).toBe(0);
  });
});
