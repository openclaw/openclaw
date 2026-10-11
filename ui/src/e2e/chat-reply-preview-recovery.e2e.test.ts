import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
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

suite.define(() => {
  it("renders 50 quoted references without per-reference requests, including after reconnect", async () => {
    const artifactDir = createControlUiE2eArtifactDir("chat-reply-preview-requests");
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const historyMessages = Array.from({ length: 50 }, (_, index) => ({
        role: "user",
        content: `Follow-up ${index + 1}.`,
        timestamp: timestamp + index,
        __openclaw: {
          id: `reply-${index}`,
          seq: 100 + index,
          replyToId: `source-${index}`,
          replyToMessage: {
            ok: true,
            message: {
              role: "assistant",
              content: `Original answer ${index + 1}.`,
              __openclaw: { id: `source-${index}` },
            },
          },
        },
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
      const renderGetCount = (await gateway.getRequests("chat.message.get")).length;
      await writeFile(
        path.join(artifactDir, "requests.json"),
        JSON.stringify({ references: 50, renderGetCount }, null, 2),
      );
      console.info(JSON.stringify({ references: 50, renderGetCount }));
      expect(renderGetCount).toBe(0);
      expect(await strips.getByRole("button").count()).toBe(50);
      expect(await pane.locator('[data-entry-id^="source-"]').count()).toBe(0);

      const connectCount = (await gateway.getRequests("connect")).length;
      await gateway.closeLatest(1006, "synthetic reconnect");
      await waitForRequests(gateway, "connect", connectCount + 1);
      await expect.poll(() => strips.getByRole("button").count()).toBe(50);
      const afterReconnectGetCount = (await gateway.getRequests("chat.message.get")).length;
      await writeFile(
        path.join(artifactDir, "requests.json"),
        JSON.stringify({ references: 50, renderGetCount, afterReconnectGetCount }, null, 2),
      );
      expect(afterReconnectGetCount).toBe(0);
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
        historyMessages: [
          {
            role: "user",
            content: "Follow up on the earlier answer.",
            timestamp,
            __openclaw: {
              id: "reply",
              seq: 101,
              replyToId: "older-answer",
              replyToMessage: result,
            },
          },
        ],
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
      const source = {
        role: "assistant",
        content: "The current original answer.",
        timestamp,
        __openclaw: { id: "reconnect-source", seq: 1 },
      };
      const reply = {
        role: "user",
        content: "A follow-up question after reconnect.",
        timestamp: timestamp + 61,
        __openclaw: {
          id: "reconnect-reply",
          seq: 62,
          replyToId: "reconnect-source",
          replyToMessage: { ok: false, unavailableReason: "not_found" },
        },
      };
      const intervening = Array.from({ length: 60 }, (_, index) => ({
        role: index % 2 === 0 ? "assistant" : "user",
        content: `Conversation entry ${index + 2}.`,
        timestamp: timestamp + index + 1,
        __openclaw: { id: `intervening-${index}`, seq: index + 2 },
      }));
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
