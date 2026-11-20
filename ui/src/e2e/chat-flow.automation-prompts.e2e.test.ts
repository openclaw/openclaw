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

  it.each([
    {
      scenario: "explicit",
      prompt: "Remind me tomorrow to water the plants.",
      reply: "I'll remind you tomorrow.",
      entries: [{ name: "Water the plants", showCard: true }],
    },
    {
      scenario: "internal",
      prompt: "Publish the onboarding Template.",
      reply: "The Template was submitted for review.",
      entries: [{ name: "Check Template review status", showCard: false }],
    },
    {
      scenario: "mixed",
      prompt: "Publish the onboarding Template and remind me tomorrow to write release notes.",
      reply: "The Template was submitted, and I'll remind you tomorrow.",
      entries: [
        { name: "Check Template review status", showCard: false },
        { name: "Write release notes", showCard: true },
      ],
    },
  ])(
    "shows only user-requested creation cards ($scenario)",
    async ({ scenario, prompt: userPrompt, reply, entries }) => {
      const runId = "run-" + scenario;
      const planId = "plan-" + scenario;
      const jobs = entries.map(({ name }, i) =>
        createCronJob(scenario + "-" + i, name, {
          enabled: true,
          schedule: { kind: "at", at: "2099-11-21T17:00:00.000Z" },
        }),
      );
      const time = Date.now();
      const receipt = (
        action: string,
        callId: string,
        args: object,
        details: object,
        seq: number,
      ) => ({
        role: "custom",
        customType: "openclaw.nested-tool.v1",
        display: true,
        timestamp: time + seq,
        __openclaw: { id: callId, seq, runId },
        content: [
          { type: "toolCall", id: callId, name: "automations", arguments: { action, ...args } },
          {
            type: "toolResult",
            toolName: "automations",
            toolCallId: callId,
            isError: false,
            details,
          },
        ],
      });
      const { page, gateway } = await chatFixture(
        suite,
        {
          subscriptionInitialHistory: false,
          deferredMethods: ["chat.startup"],
          historyMessages: [
            timedText("user", userPrompt, {
              timestamp: time,
              __openclaw: { id: "prompt", seq: 1, runId },
            }),
            receipt(
              "plan",
              "declare",
              { names: entries.map(({ name }) => name) },
              {
                type: "automation_creation_plan",
                planId,
                slots: entries.map(({ name }, i) => ({ slotId: String(i + 1), name })),
              },
              2,
            ),
            ...entries.map(({ showCard }, i) =>
              receipt(
                "add",
                "add-" + i,
                { position: i + 1, ...(showCard ? { showCard } : {}) },
                {
                  automationCreation: {
                    type: "automation_creation_result",
                    planId,
                    slotId: String(i + 1),
                    status: "created",
                    jobId: jobs[i]!.id,
                    showCard,
                  },
                },
                i + 3,
              ),
            ),
            timedText("assistant", reply, {
              stopReason: "stop",
              timestamp: time + 10,
              __openclaw: { id: "answer", seq: jobs.length + 3, runId },
            }),
          ],
          methodResponses: {
            "cron.get": { cases: jobs.map((job) => ({ match: { id: job.id }, response: job })) },
          },
        },
        { viewport: { width: 1100, height: 800 }, colorScheme: "light" },
      );
      await page.goto(suite.server.baseUrl + "chat/main");
      // Install the transcript owner before delivering the mocked authoritative history.
      await gateway.waitForRequest("chat.startup");
      await page.locator(".chat-thread-viewport").waitFor();
      await gateway.resolveDeferred("chat.startup");
      const thread = transcript(page);
      const answer = thread.getByText(reply, { exact: true });
      await answer.waitFor();
      const card = thread.getByRole("group", { name: "Automations", exact: true });
      const shown = jobs.filter((_, i) => entries[i]?.showCard);
      for (const job of shown) {
        await card.getByRole("switch", { name: "Pause: " + job.name }).waitFor();
      }
      if (captureUiProofEnabled) {
        const frame = await takeControlUiScreenshotFrame(page, page.locator("body"), [answer], {
          animations: "disabled",
        });
        await writeFile(path.join(suite.artifactDir, "automation-" + scenario + ".png"), frame.png);
      }
      expect(await card.count()).toBe(shown.length ? 1 : 0);
      expect(await card.locator("[data-job-id]").count()).toBe(shown.length);
      expect(await card.getByRole("heading").count()).toBe(0);
      const requests = await gateway.getRequests("cron.get");
      expect(requests.map(({ params }) => params)).toEqual(shown.map(({ id }) => ({ id })));
    },
  );

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
