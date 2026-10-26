import type { Locator } from "playwright";
import { expect, it } from "vitest";
import { createNestedToolActivity } from "../../../src/sessions/nested-tool-activity.ts";
import { prepareChatHistoryFixture } from "../test-helpers/chat-activity-fixtures.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { showText } from "./activity-assertions.test-support.ts";
import { chatMessage, textContent } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI nested tool presentation",
  startServerBeforeBrowser: true,
});
const timestamp = Date.UTC(2026, 8, 11, 15, 0);
const runId = "github-sign-in-run";
const command = "printf '\n--- GitHub sign-in ---\n'\ngh auth login --hostname github.com --web";
const wrapperCode = "await tools.exec({ command: 'gh auth login --hostname github.com --web' });";
const conclusion = "GitHub sign-in could not start because the GitHub CLI is unavailable.";
const contextOptions = { viewport: { width: 1280, height: 900 }, locale: "en-US" };

function toolCall(id: string, args: Record<string, unknown>, offset: number, extra = {}) {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name: "exec", ...extra, arguments: args }],
    timestamp: timestamp + offset,
    ...extra,
  };
}

function toolResult(id: string, text: string, offset: number, extra = {}) {
  return chatMessage("toolResult", text, {
    toolCallId: id,
    toolName: "exec",
    timestamp: timestamp + offset,
    ...extra,
  });
}

async function expectCollapsed(work: Locator) {
  const summary = work.locator(":scope > .chat-activity-group__summary");
  expect(await summary.getAttribute("aria-expanded")).toBe("false");
  expect(await summary.locator(".chat-activity-group__label").textContent()).toBe(
    "1 command · 1 read",
  );
  expect((await summary.textContent())?.match(/1 failed/g)).toHaveLength(1);
  expect(await summary.textContent()).not.toContain("/workspace/README.md");
  expect(await summary.getByText("1 failed", { exact: true }).isVisible()).toBe(true);
  expect(await work.textContent()).not.toContain("gh: command not found");
}

function nestedHistory() {
  return (
    [
      ["github-login", "exec", { command }, "gh: command not found", true],
      ["github-read", "read", { path: "/workspace/README.md" }, "GitHub CLI required.", false],
    ] as const
  ).map(([toolCallId, toolName, input, text, isError], index) =>
    Object.assign(
      createNestedToolActivity({
        runId,
        scopeId: "github-sign-in-scope",
        afterEntryId: "github-wrapper-call",
        startOrder: index + 1,
        parentToolCallId: "github-wrapper",
        toolCallId,
        toolName,
        input,
        result: { content: textContent(text) },
        isError,
        startedAt: timestamp + (index + 1) * 1_000,
        timestamp: timestamp + (index + 1) * 1_000 + 500,
      }),
      { runId, __openclaw: { runId } },
    ),
  );
}

suite.define(() => {
  it("keeps failed child diagnostics behind disclosure, including after reload", async () => {
    await suite.withPage(contextOptions, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "chat.history": prepareChatHistoryFixture([
            { role: "user", content: "Sign in to GitHub so I can authorize access.", timestamp },
            chatMessage("assistant", "Starting GitHub authentication.", {
              openclawStreamFallback: {
                itemId: "github-commentary",
                replacementText: "Starting GitHub authentication.",
                source: "segment",
              },
              timestamp: timestamp + 100,
            }),
            toolCall(
              "github-wrapper",
              { title: "Start GitHub authentication", code: wrapperCode },
              500,
              { runId },
            ),
            ...nestedHistory(),
            toolResult("github-wrapper", "Child operations finished.", 3_000, {
              runId,
              isError: false,
            }),
            chatMessage("assistant", conclusion, { timestamp: timestamp + 4_000 }),
          ]),
        },
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await page.getByText(conclusion, { exact: true }).waitFor();
      await gateway.waitForRequest("sessions.messages.subscribe");
      const work = page.locator(".chat-activity-group").first();
      const summary = work.locator(":scope > .chat-activity-group__summary");
      await summary.waitFor();
      await expectCollapsed(work);
      const failure = summary.getByText("1 failed", { exact: true });
      expect(await work.textContent()).not.toContain("Sign in to GitHub");
      await summary.click();
      const activityBody = work.locator(".chat-activity-group__body");
      expect(await activityBody.locator(".chat-tool-row").count()).toBe(1);
      const wrapper = activityBody.locator(".chat-tool-msg-summary", {
        hasText: "Start GitHub authentication",
      });
      await wrapper.waitFor();
      expect(await wrapper.textContent()).toContain("1 failed");
      await wrapper.click();
      const children = activityBody.locator(".chat-tool-children");
      const login = children.locator(".chat-tool-msg-summary", { hasText: "GitHub sign-in" });
      await login.waitFor();
      expect(await activityBody.getByText("gh: command not found").count()).toBe(0);
      await login.click();
      await activityBody.getByText(command, { exact: true }).first().waitFor();
      const diagnostics = activityBody.locator(".chat-tool-msg-body", {
        hasText: "gh: command not found",
      });
      expect(await diagnostics.isVisible()).toBe(true);
      await activityBody.locator(".chat-tool-wrapper-details > summary").click();
      await activityBody.getByText(wrapperCode, { exact: false }).first().waitFor();
      await summary.click();
      expect(await summary.getAttribute("aria-expanded")).toBe("false");
      await page.reload();
      await gateway.waitForRequest("sessions.messages.subscribe");
      await summary.waitFor();
      await expectCollapsed(work);
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.locator('.shell-nav[aria-hidden="true"]').waitFor({ state: "attached" });
      await failure.waitFor();
      expect(await failure.isVisible()).toBe(true);
      expect(await work.textContent()).not.toContain("gh: command not found");
    });
  });

  it("keeps an ordinary exec with a code argument as a command", async () => {
    await suite.withPage(contextOptions, async ({ page }) => {
      await installMockGateway(page, {
        historyMessages: [
          { role: "user", content: "Check the runtime.", timestamp },
          toolCall(
            "ordinary-exec",
            {
              title: "Check runtime version",
              command: "node --version",
              code: "console.log(process.version)",
            },
            100,
          ),
          toolResult("ordinary-exec", "v24.7.0", 200),
          chatMessage("assistant", "Runtime checked.", { timestamp: timestamp + 300 }),
        ],
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await page.getByText("Runtime checked.", { exact: true }).waitFor();
      const call = page.locator(".chat-tool-msg-summary", { hasText: "Check runtime version" });
      await call.waitFor();
      await call.click();
      const body = page.locator(".chat-tool-msg-body");
      await showText(body, "node --version");
      await showText(body, "v24.7.0");
      expect(await page.getByText("Code Mode", { exact: true }).count()).toBe(0);
    });
  });
});
