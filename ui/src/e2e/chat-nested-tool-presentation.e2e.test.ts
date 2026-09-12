import path from "node:path";
import { expect, it } from "vitest";
import {
  createNestedToolActivity,
  nestedToolActivityContent,
} from "../../../src/sessions/nested-tool-activity.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI nested tool presentation",
  startServerBeforeBrowser: true,
});
const timestamp = Date.UTC(2026, 8, 11, 15, 0);
const runId = "github-sign-in-run";
const command = "gh auth login --hostname github.com --web";
const wrapperCode = "await tools.exec({ command: 'gh auth login --hostname github.com --web' });";

function nestedHistoryMessage(
  toolCallId: string,
  toolName: string,
  input: Record<string, unknown>,
  text: string,
  startOrder: number,
  isError = false,
) {
  const activity = createNestedToolActivity({
    runId,
    scopeId: "github-sign-in-scope",
    afterEntryId: "github-wrapper-call",
    startOrder,
    parentToolCallId: "github-wrapper",
    toolCallId,
    toolName,
    input,
    result: { content: [{ type: "text", text }] },
    isError,
    startedAt: timestamp + startOrder * 1_000,
    timestamp: timestamp + startOrder * 1_000 + 500,
  });
  const [call, result] = nestedToolActivityContent(activity);
  return {
    ...activity,
    runId,
    __openclaw: { runId },
    content: [call, { ...result, role: "toolResult" }],
  };
}

suite.define(() => {
  it("shows child work and its failure before disclosure, with details surviving reload", async () => {
    const artifactDir = createControlUiE2eArtifactDir("chat-nested-tool-presentation");
    await suite.withPage(
      { viewport: { width: 1280, height: 900 }, locale: "en-US" },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          historyMessages: [
            { role: "user", content: "Sign in to GitHub so I can authorize access.", timestamp },
            {
              role: "assistant",
              content: [{ type: "text", text: "Starting GitHub authentication." }],
              openclawStreamFallback: {
                itemId: "github-commentary",
                replacementText: "Starting GitHub authentication.",
                source: "segment",
              },
              timestamp: timestamp + 100,
            },
            {
              role: "assistant",
              runId,
              content: [
                {
                  type: "toolCall",
                  id: "github-wrapper",
                  name: "exec",
                  runId,
                  arguments: { title: "Start GitHub authentication", code: wrapperCode },
                },
              ],
              timestamp: timestamp + 500,
            },
            nestedHistoryMessage(
              "github-login",
              "exec",
              { title: "Sign in to GitHub", command },
              "gh: command not found",
              1,
              true,
            ),
            nestedHistoryMessage(
              "github-read",
              "read",
              { path: "/workspace/README.md" },
              "GitHub CLI is required for this workflow.",
              2,
            ),
            {
              role: "toolResult",
              runId,
              toolCallId: "github-wrapper",
              toolName: "exec",
              content: [{ type: "text", text: "Child operations finished." }],
              timestamp: timestamp + 3_000,
            },
            {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: "GitHub sign-in could not start because the GitHub CLI is unavailable.",
                },
              ],
              timestamp: timestamp + 4_000,
            },
          ],
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        await page
          .getByText("GitHub sign-in could not start because the GitHub CLI is unavailable.", {
            exact: true,
          })
          .waitFor();
        await gateway.waitForRequest("chat.startup");
        const work = page.locator(".chat-activity-group").first();
        const summary = work.locator(":scope > .chat-activity-group__summary");
        await summary.waitFor();
        await page.screenshot({ path: path.join(artifactDir, "01-collapsed.png") });
        expect(await summary.getAttribute("aria-expanded")).toBe("false");
        expect(await summary.textContent()).toContain("Ran a command, read a file");
        const failure = work.locator(".chat-tool-failure", { hasText: "gh: command not found" });
        expect(await failure.isVisible()).toBe(true);
        expect(await failure.textContent()).toContain("Sign in to GitHub");
        await summary.click();
        const activityBody = work.locator(".chat-activity-group__body");
        const wrapper = activityBody.locator(".chat-tool-msg-summary", {
          hasText: "Start GitHub authentication",
        });
        await wrapper.waitFor();
        await wrapper.click();
        await activityBody.getByText(wrapperCode, { exact: false }).first().waitFor();
        const login = activityBody.locator(".chat-tool-msg-summary", {
          hasText: "Sign in to GitHub",
        });
        await login.waitFor();
        await login.click();
        await activityBody.getByText(command, { exact: true }).first().waitFor();
        expect(
          await activityBody
            .locator(".chat-tool-msg-body", { hasText: "gh: command not found" })
            .isVisible(),
        ).toBe(true);
        await page.screenshot({ path: path.join(artifactDir, "02-expanded.png") });
        await summary.click();
        expect(await summary.getAttribute("aria-expanded")).toBe("false");
        await page.reload();
        await gateway.waitForRequest("chat.startup");
        await summary.waitFor();
        expect(await summary.getAttribute("aria-expanded")).toBe("false");
        expect(await summary.textContent()).toContain("Ran a command, read a file");
        expect(await failure.isVisible()).toBe(true);
        await page.screenshot({ path: path.join(artifactDir, "03-reloaded.png") });
        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.setViewportSize({ width: 390, height: 844 });
        await page.locator('.shell-nav[aria-hidden="true"]').waitFor({ state: "attached" });
        await failure.waitFor();
        expect(await failure.isVisible()).toBe(true);
        await page.screenshot({
          path: path.join(artifactDir, "04-mobile.png"),
          animations: "disabled",
        });
      },
    );
  });

  it("keeps an ordinary exec with a code argument as a command", async () => {
    await suite.withPage(
      { viewport: { width: 1280, height: 900 }, locale: "en-US" },
      async ({ page }) => {
        await installMockGateway(page, {
          historyMessages: [
            { role: "user", content: "Check the runtime.", timestamp },
            {
              role: "assistant",
              content: [
                {
                  type: "toolCall",
                  id: "ordinary-exec",
                  name: "exec",
                  arguments: {
                    title: "Check runtime version",
                    command: "node --version",
                    code: "console.log(process.version)",
                  },
                },
              ],
              timestamp: timestamp + 100,
            },
            {
              role: "toolResult",
              toolCallId: "ordinary-exec",
              toolName: "exec",
              content: [{ type: "text", text: "v24.7.0" }],
              timestamp: timestamp + 200,
            },
            {
              role: "assistant",
              content: [{ type: "text", text: "Runtime checked." }],
              timestamp: timestamp + 300,
            },
          ],
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        await page.getByText("Runtime checked.", { exact: true }).waitFor();
        const call = page.locator(".chat-tool-msg-summary", { hasText: "Check runtime version" });
        await call.waitFor();
        await call.click();
        await page
          .locator(".chat-tool-msg-body")
          .getByText("node --version", { exact: true })
          .waitFor();
        await page.locator(".chat-tool-msg-body").getByText("v24.7.0", { exact: true }).waitFor();
        expect(await page.getByText("Code Mode", { exact: true }).count()).toBe(0);
      },
    );
  });
});
