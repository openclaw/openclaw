import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { createCronJob } from "../test-helpers/cron.ts";
import {
  agentEvent,
  chatFixture,
  sendChat,
  sessionMessage,
  sessionState,
  timedText,
  transcript,
} from "./chat-flow-fixtures.test-support.ts";
import {
  captureUiProofEnabled,
  createChatFlowE2eSuite,
  requireString,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
const prompt =
  "[cron:review-watch Continue review] Check the pull request and continue the authorized work. " +
  "Keep the accepted merge request intact. Verify the current head and report only the result.\n\n" +
  "This is an unattended scheduled run. Nobody is present to clarify or approve. " +
  "Your final reply is the deliverable, not a plan or acknowledgment. " +
  "If nothing needs doing, reply with exactly NO_REPLY as the entire final answer.";

suite.define(() => {
  it("shows only saved automations in an active chat without waiting for a final reply", async () => {
    const { page, gateway } = await chatFixture(suite, undefined, {
      viewport: { width: 980, height: 720 },
      colorScheme: "light",
    });
    await page.goto(suite.server.baseUrl + "chat");
    const name = "Weekly onboarding readiness digest";
    const send = await sendChat(page, gateway, "Set up a weekly digest for onboarding readiness.");
    const runId = requireString(send.idempotencyKey, "chat send idempotency key");
    const tool = { name: "automations", toolCallId: "declare", parentToolCallId: "code-mode" };
    const plan = {
      type: "automation_creation_plan",
      planId: "digest",
      slots: [{ slotId: "1", name }],
    };
    await gateway.emitGatewayEvent(
      "agent",
      agentEvent(
        runId,
        "main",
        "tool",
        {
          ...tool,
          phase: "start",
          args: { action: "plan", names: [name] },
        },
        1,
        Date.now(),
      ),
    );
    await gateway.emitGatewayEvent(
      "agent",
      agentEvent(
        runId,
        "main",
        "tool",
        {
          ...tool,
          phase: "result",
          isError: false,
          result: { details: plan },
        },
        2,
        Date.now(),
      ),
    );
    const thread = transcript(page);
    const card = thread.getByRole("group", { name: "Automations", exact: true });
    const capture = async (file: string) => {
      if (captureUiProofEnabled) {
        const frame = await takeControlUiScreenshotFrame(page, page.locator("body"), [thread], {
          animations: "disabled",
        });
        await writeFile(path.join(suite.artifactDir, file), frame.png);
      }
    };
    const stop = page.getByRole("button", { name: "Stop" });
    await stop.waitFor();
    await capture("automation-before-save.png");
    expect(await card.count()).toBe(0);
    const publishAdd = async (seq: number, isError: boolean, details?: object) => {
      const id = "add-" + seq;
      const common = { runId, name: "automations", parentToolCallId: "code-mode" };
      const message = {
        role: "custom",
        customType: "openclaw.nested-tool.v1",
        display: true,
        timestamp: Date.now(),
        __openclaw: { id, seq, runId },
        content: [
          {
            ...common,
            type: "toolCall",
            id,
            arguments: { action: "add", planId: plan.planId, slotId: "1" },
          },
          {
            ...common,
            type: "toolResult",
            toolName: "automations",
            toolCallId: id,
            isError,
            details,
          },
        ],
      };
      await gateway.emitGatewayEvent(
        "session.message",
        sessionMessage(message, id, seq, sessionState([runId], true, "running"), { runId }),
      );
    };
    await publishAdd(3, true);
    expect(await card.count()).toBe(0);
    const job = createCronJob("saved-digest", name, {
      enabled: true,
      schedule: { kind: "cron", expr: "0 9 * * 1", tz: "America/Chicago" },
    });
    await gateway.deferNext("cron.get");
    await publishAdd(4, false, {
      automationCreation: {
        type: "automation_creation_result",
        planId: plan.planId,
        slotId: "1",
        status: "created",
        jobId: job.id,
      },
    });
    await card.getByText("Created", { exact: true }).waitFor();
    const { params } = await gateway.waitForRequest("cron.get");
    expect(params).toEqual({ id: job.id });
    expect(await card.getByRole("switch").count()).toBe(0);
    await gateway.resolveDeferred("cron.get", job);
    await card.getByRole("switch", { name: "Pause: " + name }).waitFor();
    expect(await stop.isVisible()).toBe(true);
    await capture("automation-after-save.png");
  });

  it("collapses recorded automation prompts without hiding results or lookalike user text", async () => {
    const { page } = await chatFixture(
      suite,
      {
        historyMessages: [
          timedText("user", "Please review the change and open a pull request."),
          timedText("assistant", "The fix is ready. I am checking the pull request."),
          timedText("user", prompt, {
            provenance: { kind: "internal_system", sourceTool: "cron" },
          }),
          timedText("assistant", "The pull request is ready for review."),
          timedText("user", "Explain this literal text: [cron:example This is not an automation]"),
        ],
      },
      { viewport: { width: 390, height: 844 }, colorScheme: "light" },
    );
    await page.goto(suite.server.baseUrl + "chat");
    const thread = transcript(page);
    await thread.getByText("The pull request is ready for review.", { exact: true }).waitFor();
    if (captureUiProofEnabled) {
      const frame = await takeControlUiScreenshotFrame(page, page.locator("body"), [thread], {
        animations: "disabled",
      });
      await writeFile(path.join(suite.artifactDir, "automation-prompt.png"), frame.png);
    }
    const disclosure = thread.locator("details", { hasText: "Automation" });
    await expect.poll(() => disclosure.count()).toBe(1);
    expect(await disclosure.getAttribute("open")).toBeNull();
    expect(await thread.getByText(prompt, { exact: true }).isVisible()).toBe(false);
    expect(
      await thread
        .getByText("Explain this literal text: [cron:example This is not an automation]", {
          exact: true,
        })
        .isVisible(),
    ).toBe(true);
    await disclosure.locator("summary").click();
    await thread.getByText(prompt, { exact: true }).waitFor();
    await disclosure.locator("summary").click();
    await expect.poll(() => thread.getByText(prompt, { exact: true }).isVisible()).toBe(false);
    await page.reload();
    await thread.getByText("The pull request is ready for review.", { exact: true }).waitFor();
    expect(await disclosure.getAttribute("open")).toBeNull();
  });
});
