import fs from "node:fs/promises";
import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import { createNestedToolActivity } from "../../../src/sessions/nested-tool-activity.ts";
import { prepareChatHistoryFixture } from "../test-helpers/chat-activity-fixtures.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { openChatDetails } from "./chat-details.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Conversation skills used",
  startServerBeforeBrowser: true,
});
const timestamp = Date.UTC(2026, 10, 9, 14, 0);
const runId = "skill-run";
const nested = (id: string, name: string, isError = false) =>
  createNestedToolActivity({
    runId,
    scopeId: "skill-scope",
    afterEntryId: "wrapper-call",
    startOrder: 1,
    parentToolCallId: "wrapper",
    toolCallId: id,
    toolName: "skills_read",
    input: { name },
    result: {
      content: [{ type: "text", text: isError ? "Skill not found" : "Instructions loaded" }],
    },
    isError,
    startedAt: timestamp + 100,
    timestamp: timestamp + 200,
  });

suite.define(() => {
  it("shows skills outside the hydrated history page without fetching older transcript bodies", async () => {
    await suite.withPage({ viewport: { width: 1800, height: 1000 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "chat.history": {
            messages: [
              ...Array.from({ length: 80 }, (_, index) => ({
                role: index % 2 ? "assistant" : "user",
                content: "Loaded conversation page item " + index,
                timestamp: timestamp + index,
              })),
              {
                role: "assistant",
                content: "Only the newest conversation page.",
                timestamp: timestamp + 81,
              },
            ],
            hasMore: true,
            nextOffset: 80,
            totalMessages: 300,
            skillsUsed: [{ id: '["earlier-run","earlier-load"]', name: "earlier-review" }],
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await page.getByText("Only the newest conversation page.", { exact: true }).waitFor();
      const details = await openChatDetails(page);
      const skills = details.locator('[data-details-group="skills"]');
      await skills.locator("summary").click();
      await skills.getByText("earlier-review", { exact: true }).waitFor();
      expect(await page.locator(".chat-tool-row").count()).toBe(0);
      const reads = await gateway.getRequests("chat.history");
      expect(reads.some((request) => Number(asOptionalRecord(request.params)?.offset) > 0)).toBe(
        false,
      );
    });
  });

  it("shows successfully loaded native and Code Mode skills, collapsed by default and after reload", async () => {
    await suite.withPage(
      { viewport: { width: 1800, height: 1000 }, locale: "en-US" },
      async ({ page }) => {
        const messages = [
          {
            role: "user",
            content: "Review the release plan using the appropriate skills.",
            timestamp,
          },
          {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "wrapper",
                name: "exec",
                arguments: { code: 'await skills.read("release-runbook")' },
              },
            ],
            timestamp: timestamp + 1,
            __openclaw: { id: "wrapper-call", runId },
          },
          nested("load-release", "release-runbook"),
          nested("missing", "missing-skill", true),
          {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "load-review",
                name: "skills_read",
                arguments: { name: "code-review" },
              },
            ],
            timestamp: timestamp + 300,
            runId,
          },
          {
            role: "toolResult",
            toolCallId: "load-review",
            toolName: "skills_read",
            content: [{ type: "text", text: "Review instructions loaded" }],
            isError: false,
            timestamp: timestamp + 400,
            runId,
          },
          {
            role: "assistant",
            content: "The release plan is ready for review.",
            timestamp: timestamp + 500,
          },
        ];
        const gateway = await installMockGateway(page, {
          agentModel: "openai/gpt-4.1",
          models: [{ id: "gpt-4.1", name: "GPT-4.1", provider: "openai" }],
          methodResponses: { "chat.history": prepareChatHistoryFixture(messages) },
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        await page.getByText("The release plan is ready for review.", { exact: true }).waitFor();
        const details = page.locator(".chat-details[data-desktop]");
        if (!(await details.isVisible())) {
          await page.getByRole("button", { name: "Details", exact: true }).click();
        }
        await details.waitFor();
        const section = details.locator('[data-details-group="skills"]');
        await section.waitFor();
        const frame = await takeControlUiScreenshotFrame(page, details, [section], {
          animations: "disabled",
        });
        await fs.writeFile(path.join(suite.artifactDir, "skills-initial.png"), frame.png);
        const summary = section.locator("summary");
        expect(await summary.getAttribute("aria-expanded")).toBe("false");
        await summary.click();
        await section.getByText("release-runbook", { exact: true }).waitFor();
        await section.getByText("code-review", { exact: true }).waitFor();
        expect(await section.textContent()).not.toContain("missing-skill");
        const expanded = await takeControlUiScreenshotFrame(page, details, [section], {
          animations: "disabled",
        });
        await fs.writeFile(path.join(suite.artifactDir, "skills-expanded.png"), expanded.png);
        await page
          .locator(".agent-chat__composer-combobox textarea")
          .fill("Check release health too.");
        await page.getByRole("button", { name: "Send message", exact: true }).click();
        const sent = await gateway.waitForRequest("chat.send");
        const liveRun = String(asOptionalRecord(sent.params)?.idempotencyKey);
        for (const [seq, phase, detail] of [
          [1, "start", { args: { name: "release-health" } }],
          [2, "result", { result: { content: [{ type: "text", text: "Instructions loaded" }] } }],
        ] as const) {
          await gateway.emitGatewayEvent("agent", {
            sessionKey: "agent:main:main",
            agentId: "main",
            runId: liveRun,
            seq,
            ts: timestamp + 1000 + seq,
            stream: "tool",
            data: { phase, name: "skills_read", toolCallId: "live-skill", ...detail },
          });
        }
        await section.getByText("release-health", { exact: true }).waitFor();
        await page.reload();
        await page.getByText("The release plan is ready for review.", { exact: true }).waitFor();
        if (!(await details.isVisible())) {
          await page.getByRole("button", { name: "Details", exact: true }).click();
        }
        await section.waitFor();
        expect(await summary.getAttribute("aria-expanded")).toBe("false");
        await summary.click();
        await section.getByText("release-runbook", { exact: true }).waitFor();
        await page.setViewportSize({ width: 390, height: 844 });
        const mobile = await openChatDetails(page);
        const mobileSkills = mobile.locator('[data-details-group="skills"]');
        await mobileSkills.waitFor();
        expect(await mobileSkills.evaluate((element) => element.hasAttribute("open"))).toBe(false);
        await mobileSkills.locator("summary").click();
        await mobileSkills.getByText("release-runbook", { exact: true }).waitFor();
        const mobileFrame = await takeControlUiScreenshotFrame(page, mobile, [mobileSkills], {
          animations: "disabled",
        });
        await fs.writeFile(path.join(suite.artifactDir, "skills-mobile.png"), mobileFrame.png);
      },
    );
  });
});
