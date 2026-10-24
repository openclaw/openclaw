import { expect, it } from "vitest";
import { waitForControlUiGatewayReconnecting } from "../test-helpers/control-ui-e2e-readiness.ts";
import {
  persistedText,
  timedText,
  expectCount,
  agentEvent,
  chatEvent,
  chatFixture,
  composer as chatComposer,
  newChatPage,
  sendMessage,
  textMessage,
  transcript as chatTranscript,
} from "./chat-flow-fixtures.test-support.ts";
import {
  createChatFlowE2eSuite,
  expectRequestCountStable,
  installMockGateway,
  requireRecord,
  requireString,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
async function followUpSettings(page: import("playwright").Page, mode: string, shortcut?: string) {
  await page.goto(`${suite.server.baseUrl}settings/appearance`);
  await page.locator("[data-settings-follow-up-mode]").selectOption(mode);
  if (shortcut) {
    await page.locator("[data-settings-send-shortcut]").selectOption(shortcut);
  }
}

suite.define(() => {
  it("keeps steered streaming and durable rows from overlapping", async () => {
    const { page } = await newChatPage(suite);
    const runId = "run-a";
    const gateway = await installMockGateway(page, {
      historyMessages: [
        {
          role: "user",
          content: "run the long command",
          __openclaw: { id: "user-a", idempotencyKey: `${runId}:user`, seq: 1 },
        },
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "callExec", name: "exec", arguments: {} }],
          __openclaw: { id: "exec-call", seq: 2 },
        },
      ],
      inFlightRun: { runId, text: "" },
      sessionInfo: { activeRunIds: [runId], hasActiveRun: true, key: "agent:main:main" },
    });

    await followUpSettings(page, "queue", "enter");
    await page.goto(`${suite.server.baseUrl}chat`);

    const composer = chatComposer(page);
    await page
      .locator(".chat-tool-msg-summary")
      .getByRole("img", { name: "exec", exact: true })
      .waitFor();
    await page.getByRole("button", { name: "Stop generating" }).waitFor();
    let agentSequence = 0;
    const emitTool = (data: Record<string, unknown>) =>
      gateway.emitGatewayEvent(
        "agent",
        agentEvent(runId, "agent:main:main", "tool", data, ++agentSequence, Date.now()),
      );

    const steerText = "steer while the process runs";
    const sendsBeforeSteer = (await gateway.getRequests("chat.send")).length;
    await gateway.deferNext("chat.send");
    await composer.fill(steerText);
    await composer.press("Control+Enter");
    const steerSend = await gateway.waitForRequest("chat.send", { after: sendsBeforeSteer });
    await gateway.emitGatewayEvent(
      "chat",
      chatEvent(runId, "agent:main:main", "status", { seq: 1, phase: "naming_worktree" }),
    );
    const startupIndicator = page.locator('.chat-working-indicator[role="status"]');
    await expect.poll(() => startupIndicator.textContent()).not.toContain("Naming worktree…");
    const steerParams = requireRecord(steerSend.params);
    const steerRunId = requireString(steerParams.idempotencyKey, "steer chat send idempotency key");
    await gateway.resolveDeferred("chat.send", { runId: steerRunId, status: "started" });
    const steerUser = persistedText("user", steerText, {
      id: "ui4-steer-user",
      idempotencyKey: `${steerRunId}:user`,
      seq: 4,
      steerTargetRunId: runId,
    });
    await gateway.deferNext("chat.history");
    await gateway.emitGatewayEvent("session.message", {
      activeRunIds: [runId],
      clientRunId: steerRunId,
      hasActiveRun: true,
      message: steerUser,
      messageId: "ui4-steer-user",
      messageSeq: 4,
      sessionKey: "agent:main:main",
    });
    await page.locator(".chat-group.user", { hasText: steerText }).waitFor();
    await gateway.emitGatewayEvent("chat", chatEvent(steerRunId, "agent:main:main", "final"));

    await emitTool({
      args: { action: "poll" },
      name: "process",
      phase: "start",
      toolCallId: "callProcess",
    });
    await emitTool({
      name: "process",
      phase: "result",
      result: "process complete",
      toolCallId: "callProcess",
    });
    const finalText = Array.from(
      { length: 18 },
      (_, index) =>
        `Terminal response paragraph ${index + 1}. ` +
        "The durable reply must replace every transient projection before the browser paints.",
    ).join("\n\n");
    await gateway.emitGatewayEvent(
      "chat",
      chatEvent(runId, "agent:main:main", "delta", {
        deltaText: finalText,
        message: timedText("assistant", finalText),
      }),
    );
    const streamingBubble = page.locator(".chat-bubble.streaming", {
      hasText: "Terminal response paragraph 1.",
    });
    await streamingBubble.waitFor();
    const steerBubble = page.locator(".chat-group.user", { hasText: steerText }).last();
    const steerElement = await steerBubble.elementHandle();
    // Scrolling between separate protocol reads can make adjacent rows appear to overlap.
    const [steerBounds, streamingBounds] = await streamingBubble.evaluate(
      (streaming, steer) =>
        [steer, streaming].map((element) => {
          if (!element?.isConnected || element.getClientRects().length === 0) {
            return null;
          }
          const { y, height } = element.getBoundingClientRect();
          return { y, height };
        }),
      steerElement,
    );
    await steerElement?.dispose();
    expect(steerBounds).not.toBeNull();
    expect(streamingBounds).not.toBeNull();
    expect(streamingBounds!.y).toBeGreaterThanOrEqual(steerBounds!.y + steerBounds!.height - 1);
    const durableFinalMessage = textMessage("assistant", finalText, {
      __openclaw: { id: "ui4-final", seq: 5, runId },
    });
    await gateway.emitGatewayEvent(
      "chat",
      chatEvent(runId, "agent:main:main", "delta", {
        deltaText: "",
        message: { role: "assistant", content: [] },
        replace: true,
      }),
    );
    await gateway.emitGatewayEvent("session.message", {
      activeRunIds: [runId],
      clientRunId: runId,
      hasActiveRun: true,
      message: durableFinalMessage,
      messageId: "ui4-final",
      messageSeq: 5,
      runId,
      sessionKey: "agent:main:main",
    });
    await page.evaluate(async () => {
      for (let frame = 0; frame < 12; frame++) {
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => resolve());
        });
      }
    });
    await streamingBubble.waitFor({ state: "detached" });
    expect(await chatTranscript(page).getByText(finalText, { exact: true }).count()).toBe(1);
    const overlaps = await page.locator(".chat-thread").evaluate((thread) => {
      const rows = Array.from(thread.querySelectorAll<HTMLElement>(".chat-virtual-row"))
        .map((row) => {
          const rect = row.getBoundingClientRect();
          return { bottom: rect.bottom, key: row.dataset.virtualRowKey ?? "", top: rect.top };
        })
        .filter((row) => row.bottom > row.top)
        .toSorted((left, right) => left.top - right.top);
      return rows.slice(1).flatMap((row, index) => {
        const previous = rows[index];
        return previous && row.key !== previous.key && row.top < previous.bottom - 1
          ? [`${previous.key}->${row.key}`]
          : [];
      });
    });
    expect(overlaps).toEqual([]);
  });

  it("projects one disconnected state for an offline steer follow-up", async () => {
    const { page, gateway } = await chatFixture(suite);

    await followUpSettings(page, "steer", "enter");
    await page.goto(`${suite.server.baseUrl}chat`);

    const composer = chatComposer(page);
    await sendMessage(page, "keep the disconnect run active");
    const initial = requireRecord((await gateway.waitForRequest("chat.send")).params);
    const activeRunId = requireString(initial.idempotencyKey, "initial accepted run");
    await page.getByRole("button", { name: "Stop generating" }).waitFor({ timeout: 10_000 });

    // Establish delivery before disconnect; the follow-up is the only unsent turn.
    const acceptedSession = {
      key: "agent:main:main",
      sessionId: "session:agent:main:main",
      hasActiveRun: true,
      activeRunIds: [activeRunId],
      status: "running",
    };
    await gateway.setMethodResponse("chat.history", {
      sessionId: acceptedSession.sessionId,
      sessionInfo: acceptedSession,
      messages: [
        {
          role: "user",
          content: "keep the disconnect run active",
          idempotencyKey: `${activeRunId}:user`,
        },
      ],
    });
    await gateway.emitGatewayEvent("sessions.changed", acceptedSession);
    await page.locator(".chat-send-status").waitFor({ state: "detached" });

    await gateway.setOnline(false);
    await waitForControlUiGatewayReconnecting(page);

    const followUpText = "steer after the gateway returns";
    await composer.fill(followUpText);
    await page.locator(".agent-chat__composer-actions .chat-send-btn--send").click();

    const rows = page.locator(".chat-queue__item");
    await expectCount(rows, 1);
    await expectCount(rows.getByText("Waiting for reconnect"), 1);
    expect(await rows.getByText("Steer", { exact: true }).count()).toBe(0);
    await expectRequestCountStable(gateway, "chat.send", 1);
  });
});
