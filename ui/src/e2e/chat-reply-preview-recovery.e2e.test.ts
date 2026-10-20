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
const entry = (role: string, content: string, id: string, seq: number) => ({
  role,
  content,
  timestamp: timestamp + seq - 1,
  __openclaw: { id, seq },
});
const quotedReply = (
  id: string,
  seq: number,
  sourceId: string,
  replyToMessage: unknown,
  content = "Follow up on the earlier answer.",
) => ({
  ...entry("user", content, id, seq),
  __openclaw: { id, seq, replyToId: sourceId, replyToMessage },
});

suite.define(() => {
  it("renders 50 quoted references without per-reference requests, including after reconnect", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const historyMessages = Array.from({ length: 50 }, (_, index) => ({
        ...quotedReply(
          `reply-${index}`,
          100 + index,
          `source-${index}`,
          {
            ok: true,
            message: {
              role: "assistant",
              content: `Original answer ${index + 1}.`,
              __openclaw: { id: `source-${index}` },
            },
          },
          `Follow-up ${index + 1}.`,
        ),
        timestamp: timestamp + index,
      }));
      const gateway = await installMockGateway(page, {
        sessionKey,
        historyMessages,
        methodResponses: { "chat.message.get": { ok: false, unavailableReason: "not_found" } },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      const pane = page.locator(".chat-pane-cache__pane--active");
      const strips = pane.locator(".chat-reply-attribution--inline");
      await expect.poll(() => strips.count()).toBe(50);
      expect(await gateway.getRequests("chat.message.get")).toHaveLength(0);
      expect(await strips.getByRole("button").count()).toBe(50);
      expect(await pane.locator('[data-entry-id^="source-"]').count()).toBe(0);

      const connectCount = (await gateway.getRequests("connect")).length;
      await gateway.closeLatest(1006, "synthetic reconnect");
      await waitForRequests(gateway, "connect", connectCount + 1);
      await expect.poll(() => strips.getByRole("button").count()).toBe(50);
      expect(await gateway.getRequests("chat.message.get")).toHaveLength(0);
    });
  });

  it.each([
    { name: "unconfirmed source", result: undefined, text: "" },
    {
      name: "unavailable source",
      result: { ok: false, unavailableReason: "not_found" },
      text: "Original message unavailable",
    },
  ])("renders a page's $name without fetching it", async ({ result, text }) => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const gateway = await installMockGateway(page, {
        sessionKey,
        historyMessages: [{ ...quotedReply("reply", 101, "older-answer", result), timestamp }],
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
      const reply = quotedReply(
        "reconnect-reply",
        62,
        "reconnect-source",
        {
          ok: false,
          unavailableReason: "not_found",
        },
        "A follow-up question after reconnect.",
      );
      const intervening = Array.from({ length: 60 }, (_, index) =>
        entry(
          index % 2 === 0 ? "assistant" : "user",
          `Conversation entry ${index + 2}.`,
          `intervening-${index}`,
          index + 2,
        ),
      );
      const messages = [...intervening, reply];
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
      const refreshed = [
        ...intervening,
        {
          ...reply,
          __openclaw: { ...reply["__openclaw"], replyToMessage: { ok: true, message: source } },
        },
      ];
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
