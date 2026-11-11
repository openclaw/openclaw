import { expect, it } from "vitest";
import { projectChatDisplayMessages } from "../../../src/gateway/chat-display-projection.js";
import { prepareChatHistoryFixture } from "../test-helpers/chat-activity-fixtures.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { chatMessage, newChatPage } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Plugin steering notices",
  trackBrowserContexts: true,
});
const sessionKey = "agent:main:plugin-steering";
const userText = "Review the error handling in this change.";
const displayText = "Check the error handling before continuing.";
const rawSteeringText = "Internal routing: apply the Advisor recommendation.";
const finalText = "Reviewed the error handling and confirmed the failure path is covered.";
const baseTime = Date.UTC(2026, 9, 16, 14, 5);

function projectedHistory() {
  const toolStep = (name: string, args: Record<string, string>, offset: number) => [
    {
      role: "assistant",
      content: [{ type: "toolCall", id: name, name, arguments: args }],
      timestamp: baseTime + offset,
    },
    chatMessage("toolResult", "ok", {
      toolCallId: name,
      toolName: name,
      timestamp: baseTime + offset + 1_000,
    }),
  ];
  const messages = [
    { role: "user", content: userText, timestamp: baseTime - 1_000 },
    ...toolStep("read", { path: "/workspace/src/error-handling.ts" }, 0),
    {
      role: "user",
      display: false,
      content: [{ type: "text", text: rawSteeringText }],
      provenance: { kind: "internal_system", sourceTool: "plugin:advisor" },
      __openclaw: {
        pluginSteering: { pluginId: "advisor", pluginName: "Advisor", displayText },
      },
      timestamp: baseTime + 2_000,
    },
    ...toolStep("exec", { command: "pnpm test src/error-handling.test.ts" }, 3_000),
    { role: "assistant", content: finalText, timestamp: baseTime + 5_000 },
  ];
  return prepareChatHistoryFixture(
    projectChatDisplayMessages(messages, { includePluginSteering: true }),
  );
}

suite.define(() => {
  it.each([
    { name: "light desktop", colorScheme: "light", width: 1280, height: 900 },
    { name: "dark desktop", colorScheme: "dark", width: 1280, height: 900 },
    { name: "light mobile", colorScheme: "light", width: 390, height: 844 },
    { name: "dark mobile", colorScheme: "dark", width: 390, height: 844 },
  ] as const)(
    "keeps projected plugin steering in a collapsed native notice on $name",
    async ({ colorScheme, width, height }) => {
      const page = await newChatPage(suite, {
        colorScheme,
        locale: "en-US",
        timezoneId: "UTC",
        reducedMotion: "reduce",
        viewport: { width, height },
      });
      const gateway = await installMockGateway(page, {
        sessionKey,
        sessions: [{ key: sessionKey, kind: "direct", label: "Error handling review" }],
        methodResponses: {
          "chat.history": projectedHistory(),
          "users.prefs.get": {
            status: "ok",
            entries: { "ui.theme": "claw", "ui.themeMode": colorScheme, "ui.locale": "en" },
          },
        },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      const pane = page.locator("openclaw-chat-pane.chat-pane-cache__pane--active");
      await pane.getByText(finalText, { exact: true }).waitFor();
      await expect
        .poll(() => page.locator("html").getAttribute("data-theme-mode"))
        .toBe(colorScheme);
      expect(
        await gateway.getRequests("sessions.messages.subscribe", { key: sessionKey }),
      ).not.toHaveLength(0);

      expect(await pane.locator("details.chat-system-events").count()).toBe(0);
      const notice = pane
        .locator("details.chat-notice-inline")
        .filter({ hasText: "Advisor guidance" });
      await notice.waitFor();
      expect(await notice.count()).toBe(1);
      expect(await notice.locator(".chat-notice-inline__label").textContent()).toBe(
        "Advisor guidance",
      );
      expect(await notice.locator(".chat-notice-inline__time").textContent()).toMatch(
        /^2:05\s*PM$/u,
      );
      const toggle = notice.locator("summary");
      const body = notice.locator(".chat-notice__body");
      expect(await notice.getAttribute("open")).toBeNull();
      expect(await body.count()).toBe(1);
      expect(await body.isVisible()).toBe(false);
      expect(await pane.getByText(rawSteeringText, { exact: true }).count()).toBe(0);
      const userBubbles = pane.locator(".chat-group.user .chat-bubble");
      expect(await userBubbles.count()).toBe(1);
      expect(await userBubbles.first().textContent()).toContain(userText);

      await toggle.click();
      await body.waitFor();
      expect(await notice.getAttribute("open")).not.toBeNull();
      expect((await body.textContent())?.trim()).toBe(displayText);
      expect(await userBubbles.count()).toBe(1);
      await expect
        .poll(() =>
          notice.evaluate((element) => {
            const bounds = element.getBoundingClientRect();
            const assistant = document.querySelector(
              ".chat-group:not(.user):not(.tool) .chat-group-messages",
            );
            if (!assistant) {
              throw new Error("Expected an assistant column");
            }
            return (
              bounds.width > 0 &&
              bounds.left >= 0 &&
              bounds.right <= innerWidth + 1 &&
              document.documentElement.scrollWidth <= innerWidth + 1 &&
              Math.abs(bounds.left - assistant.getBoundingClientRect().left) <= 2
            );
          }),
        )
        .toBe(true);
      await toggle.click();
      await body.waitFor({ state: "hidden" });
      expect(await notice.getAttribute("open")).toBeNull();

      const workSummaries = pane.locator(".chat-activity-group > .chat-activity-group__summary");
      for (const summary of await workSummaries.all()) {
        if ((await summary.getAttribute("aria-expanded")) !== "true") {
          await summary.click();
        }
      }
      const toolRows = pane.locator(".chat-tool-msg-summary");
      await expect.poll(() => toolRows.count()).toBe(2);
      expect(await toolRows.allTextContents()).toEqual([
        expect.stringContaining("error-handling.ts"),
        expect.stringContaining("error-handling.test.ts"),
      ]);
      expect(await pane.getByText(finalText, { exact: true }).isVisible()).toBe(true);
    },
  );
});
