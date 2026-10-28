import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator } from "playwright";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  agentEvent,
  chatDelta,
  chatFixture,
  composer,
  expectCount,
  persistedText,
  transcript,
} from "./chat-flow-fixtures.test-support.ts";
import { createChatFlowE2eSuite, requireRecord, requireString } from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("shows an explicit followup in the server queue without an assistant acknowledgment", async () => {
    const sessionKey = "agent:main:main";
    const sessionId = "queue-notice-session";
    const incumbentRunId = "queue-notice-incumbent";
    const now = Date.now();
    const original = persistedText("user", "Inspect the synthetic metrics file.", {
      id: "incumbent-user",
      idempotencyKey: `${incumbentRunId}:user`,
      seq: 1,
    });
    const sessionInfo = {
      key: sessionKey,
      sessionId,
      kind: "direct",
      activeRunIds: [incumbentRunId],
      hasActiveRun: true,
      status: "running",
      updatedAt: now,
    };
    const { page, gateway } = await chatFixture(
      suite,
      {
        sessionKey,
        sessions: [sessionInfo],
        historyMessages: [original],
        inFlightRun: {
          runId: incumbentRunId,
          startedAt: now,
          text: "Inspecting the synthetic metrics file.",
        },
      },
      { viewport: { width: 1280, height: 900 } },
    );
    await page.goto(`${suite.server.baseUrl}chat`);
    await page.getByRole("button", { name: "Stop generating" }).waitFor();
    const connection = requireRecord((await gateway.waitForRequest("connect")).params);
    const queueAware =
      Array.isArray(connection.caps) && connection.caps.includes("chat-queue-status");
    const prompt = "Then report the synthetic metric count.";
    await gateway.deferNext("chat.send");
    await composer(page).fill(`/followup ${prompt}`);
    await composer(page).press("Control+Enter");
    const params = requireRecord((await gateway.waitForRequest("chat.send")).params);
    expect(params).toMatchObject({ sessionKey, message: `/followup ${prompt}` });
    const runId = requireString(params.idempotencyKey, "followup input identity");
    const queuedInput = {
      id: "queued-followup",
      runId,
      acceptedAt: now + 1,
      state: "queued",
      queued: true,
      message: { role: "user", content: prompt, timestamp: now + 1 },
    };
    const queuedHistory = {
      sessionId,
      sessionInfo,
      messages: [original],
      pendingInputs: { items: [queuedInput], total: 1, queuedCount: 1 },
      inputReceipts: [{ runId, state: "pending", queued: true }],
    };
    await gateway.setMethodResponse("chat.history", queuedHistory);
    await gateway.resolveDeferred("chat.send", { runId, status: "started" });
    const historyReads = (await gateway.getRequests("chat.history")).length;
    await gateway.emitGatewayEvent("sessions.changed", {
      sessionKey,
      sessionId,
      session: sessionInfo,
      hasActiveRun: true,
      reason: "send",
    });
    await gateway.waitForRequest("chat.history", { after: historyReads });
    const queueRow = page.locator(".chat-queue__item", { hasText: prompt });
    await queueRow.waitFor();

    // This is mocked browser presentation proof. The Gateway boundary test owns
    // recipient filtering and non-retention; old clients receive the old delta.
    const notice =
      "Your message is queued for a new turn after the current turn finishes. It hasn’t changed the work already in progress.";
    const noticeRows = transcript(page).getByText(notice, { exact: true });
    const queuedNotices = await noticeRows.count();
    const parent = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
    const artifactDir = parent
      ? createControlUiE2eArtifactDir("explicit-followup-queue-notice", parent)
      : undefined;
    const capture = async (stage: string, content: Locator[]) => {
      if (!artifactDir) {
        return;
      }
      const frame = await takeControlUiScreenshotFrame(page, page.locator("body"), content, {
        animations: "disabled",
      });
      await writeFile(path.join(artifactDir, `${stage}.png`), frame.png);
    };
    await capture("queued", [queueRow]);

    await gateway.emitChatFinal({ runId: incumbentRunId, text: "Initial inspection finished." });
    const submitted = persistedText("user", prompt, {
      id: queuedInput.id,
      idempotencyKey: `${runId}:user`,
      seq: 3,
    });
    const running = { ...sessionInfo, activeRunIds: [runId], updatedAt: now + 2 };
    await gateway.setMethodResponse("chat.history", {
      sessionId,
      sessionInfo: running,
      messages: [original, submitted],
      pendingInputs: { items: [], total: 0, queuedCount: 0 },
      inputReceipts: [{ runId, state: "consumed", consumedByEventId: queuedInput.id }],
    });
    await gateway.emitGatewayEvent("session.message", {
      sessionKey,
      sessionId,
      session: running,
      activeRunIds: [runId],
      hasActiveRun: true,
      clientRunId: runId,
      messageId: queuedInput.id,
      messageSeq: 3,
      message: submitted,
    });
    await expectCount(queueRow, 0);
    // A delayed legacy acknowledgment can arrive after the incumbent finishes.
    // While the incumbent is active, a different run's delta is not foreground text.
    if (!queueAware) {
      await gateway.emitGatewayEvent("chat", chatDelta(runId, notice, sessionKey, { seq: 1 }));
      await noticeRows.waitFor();
    }
    await gateway.emitGatewayEvent(
      "agent",
      agentEvent(
        runId,
        sessionKey,
        "tool",
        {
          name: "read",
          phase: "start",
          args: { path: "synthetic-metrics.json" },
          toolCallId: "followup-read",
        },
        1,
        now + 2,
      ),
    );
    const tool = page.locator('[data-message-id^="tool:assistant:followup-read"]');
    await tool.waitFor();
    await capture("started", [tool, transcript(page).getByText(prompt, { exact: true })]);
    const startedNotices = await noticeRows.count();
    const answer = "The synthetic file contains three metrics.";
    await gateway.emitChatFinal({ runId, text: answer });
    await transcript(page).getByText(answer, { exact: true }).waitFor();
    expect({ queuedNotices, startedNotices, finalNotices: await noticeRows.count() }).toEqual({
      queuedNotices: 0,
      startedNotices: 0,
      finalNotices: 0,
    });
  });
});
