import { expect, it } from "vitest";
import {
  createChatFlowE2eSuite,
  controlUiSessionUrl,
  installMockGateway,
  waitForRequests,
} from "./chat-flow.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";

const suite = createChatFlowE2eSuite();
const sessionKey = "agent:main:reply-preview";
const timestamp = 1_800_000_000_000;
const missing = { ok: false, unavailableReason: "not_found" };
const entry = (role: string, content: string, id: string, seq: number) => ({
  role,
  content,
  timestamp: timestamp + seq - 1,
  __openclaw: { id, seq },
});
const replyEntry = (id: string, seq: number, sourceId: string, result: unknown) => ({
  ...entry("user", `Follow-up ${id}.`, id, seq),
  __openclaw: { id, seq, replyToId: sourceId, replyToMessage: result },
});

suite.define(() => {
  it.each([
    { name: "unconfirmed source", result: undefined, text: "" },
    {
      name: "unavailable source",
      result: missing,
      text: "Original message unavailable",
    },
  ])("renders a page's $name without fetching it", async ({ result, text }) => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const gateway = await installMockGateway(page, {
        sessionKey,
        historyMessages: [replyEntry("reply", 101, "older-answer", result)],
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      const pane = page.locator(".chat-pane-cache__pane--active");
      await pane.locator('[data-entry-id="reply"]').waitFor({ state: "visible" });
      const composer = pane.locator(".agent-chat__composer-combobox textarea");
      await composer.fill("This draft remains usable.");
      expect(await composer.inputValue()).toBe("This draft remains usable.");
      const strip = pane.locator(".chat-reply-attribution--inline");
      expect((await strip.textContent())?.replace(/\s+/g, " ").trim()).toBe(
        `Replying to ${text}`.trim(),
      );
      expect(await gateway.getRequests("chat.message.get")).toHaveLength(0);
    });
  });

  it("refreshes the page-carried original after reconnect and keeps source navigation working", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const source = entry("assistant", "The current original answer.", "reconnect-source", 1);
      const intervening = Array.from({ length: 60 }, (_, index) =>
        entry(index % 2 === 0 ? "assistant" : "user", `Entry ${index}.`, `gap-${index}`, index + 2),
      );
      const conversation = (result: unknown) => [
        ...intervening,
        replyEntry("reconnect-reply", 62, "reconnect-source", result),
      ];
      const messages = conversation(missing);
      const tailPage = (pageMessages: unknown[]) => ({
        messages: pageMessages,
        hasMore: true,
        nextOffset: messages.length,
        totalMessages: messages.length + 1,
        sessionId: "reply-preview-history",
      });
      const historyPages = (pageMessages: unknown[]) => ({
        cases: [
          {
            match: { offset: messages.length },
            response: {
              messages: [source],
              hasMore: false,
              totalMessages: messages.length + 1,
              sessionId: "reply-preview-history",
            },
          },
          // Reconnect refreshes through chat.history, which owns the same tail cursor as startup.
          { response: tailPage(pageMessages) },
        ],
      });
      const gateway = await installMockGateway(page, {
        sessionKey,
        historyMessages: messages,
        sessions: [{ key: sessionKey, sessionId: "reply-preview-history" }],
        methodResponses: {
          "chat.history": historyPages(messages),
          "chat.startup": tailPage(messages),
        },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      const pane = page.locator(".chat-pane-cache__pane--active");
      const preview = pane.locator(".chat-reply-attribution--inline");
      await pane.locator('[data-entry-id="reconnect-reply"]').waitFor();
      expect(await preview.getByRole("button").count()).toBe(0);
      const refreshed = conversation({ ok: true, message: source });
      await gateway.setMethodResponse("chat.history", historyPages(refreshed));
      await gateway.setMethodResponse("chat.startup", tailPage(refreshed));
      const connectCount = (await gateway.getRequests("connect")).length;
      await gateway.closeLatest(1006, "synthetic reply refresh");
      await waitForRequests(gateway, "connect", connectCount + 1);
      await expect.poll(() => preview.getByRole("button").count()).toBe(1);
      expect(await gateway.getRequests("chat.message.get")).toHaveLength(0);
      await preview.getByRole("button").click();
      await waitForRequests(gateway, "chat.history", 1, { offset: messages.length });
      await pane
        .locator(".chat-text")
        .getByText("The current original answer.", { exact: true })
        .waitFor();
    });
  });
});
