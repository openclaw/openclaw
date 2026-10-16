import { expect, it } from "vitest";
import { projectChatDisplayMessages } from "../../../src/gateway/chat-display-projection.js";
import { prepareChatHistoryFixture } from "../test-helpers/chat-activity-fixtures.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Plugin steering notices" });
const sessionKey = "agent:main:plugin-steering";
const userText = "Review the error handling in this change.";
const displayText = "Check the error handling before continuing.";
const rawSteeringText =
  "Internal routing context: apply the Advisor recommendation before replying.";
const finalText = "Reviewed the error handling and confirmed the failure path is covered.";
const baseTime = Date.UTC(2026, 9, 16, 14, 5);

function projectedHistory() {
  const messages = [
    {
      role: "user",
      content: userText,
      timestamp: baseTime - 1_000,
    },
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "read-error-handling",
          name: "read",
          arguments: { path: "/workspace/src/error-handling.ts" },
        },
      ],
      timestamp: baseTime,
    },
    {
      role: "toolResult",
      toolCallId: "read-error-handling",
      toolName: "read",
      content: [{ type: "text", text: "The error handler returns a structured failure." }],
      timestamp: baseTime + 1_000,
    },
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
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "check-error-handling",
          name: "exec",
          arguments: { command: "pnpm test src/error-handling.test.ts" },
        },
      ],
      timestamp: baseTime + 3_000,
    },
    {
      role: "toolResult",
      toolCallId: "check-error-handling",
      toolName: "exec",
      content: [{ type: "text", text: "Error handling checks passed." }],
      timestamp: baseTime + 4_000,
    },
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
      await suite.withPage(
        {
          colorScheme,
          locale: "en-US",
          timezoneId: "UTC",
          reducedMotion: "reduce",
          viewport: { width, height },
        },
        async ({ page }) => {
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
          expect(await gateway.getRequests("chat.startup")).not.toHaveLength(0);

          const notice = pane.locator(".chat-notice").filter({ hasText: "Advisor guidance" });
          await notice.waitFor();
          expect(await notice.count()).toBe(1);
          expect(await notice.locator(".chat-divider__title").textContent()).toBe(
            "Advisor guidance",
          );
          expect(await notice.locator(".chat-divider__metric").textContent()).toMatch(
            /^2:05\s*PM$/u,
          );
          const disclosure = notice.locator("details.chat-notice__collapse");
          const toggle = disclosure.locator("summary");
          const body = disclosure.locator(".chat-notice__body");
          expect(await toggle.textContent()).toBe("Show content");
          expect(await disclosure.getAttribute("open")).toBeNull();
          expect(await body.count()).toBe(1);
          expect(await body.isVisible()).toBe(false);
          expect(await pane.getByText(rawSteeringText, { exact: true }).count()).toBe(0);
          const userBubbles = pane.locator(".chat-group.user .chat-bubble");
          expect(await userBubbles.count()).toBe(1);
          expect(await userBubbles.first().textContent()).toContain(userText);

          await toggle.click();
          await body.waitFor();
          expect(await disclosure.getAttribute("open")).not.toBeNull();
          await expect.poll(() => toggle.textContent()).toBe("Hide content");
          expect((await body.textContent())?.trim()).toBe(displayText);
          expect(await userBubbles.count()).toBe(1);
          await expect
            .poll(() =>
              notice.evaluate((element) => {
                const bounds = element.getBoundingClientRect();
                return (
                  bounds.width > 0 &&
                  bounds.left >= 0 &&
                  bounds.right <= innerWidth + 1 &&
                  document.documentElement.scrollWidth <= innerWidth + 1
                );
              }),
            )
            .toBe(true);
          expect(
            await notice.evaluate((element) => {
              const noticeBody = element.querySelector(".chat-notice__body");
              const label = element.querySelector(".chat-divider__label");
              if (!noticeBody || !label) {
                throw new Error("Expected a notice body and label");
              }
              const text = document.createRange();
              text.selectNodeContents(noticeBody.querySelector("p") ?? noticeBody);
              const bodyBounds = text.getBoundingClientRect();
              const labelBounds = label.getBoundingClientRect();
              return Math.abs(
                bodyBounds.left + bodyBounds.width / 2 - labelBounds.left - labelBounds.width / 2,
              );
            }),
          ).toBeLessThanOrEqual(1);
          await toggle.click();
          await body.waitFor({ state: "hidden" });
          expect(await disclosure.getAttribute("open")).toBeNull();
          await expect.poll(() => toggle.textContent()).toBe("Show content");

          const workSummaries = pane.locator(
            ".chat-activity-group > .chat-activity-group__summary",
          );
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
    },
  );
});
