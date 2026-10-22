import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { waitForControlUiGatewayReconnecting } from "../test-helpers/control-ui-e2e-readiness.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  persistedText,
  timedText,
  expectTextContains,
  expectCount,
  agentEvent,
  chatEvent,
  chatFixture,
  composer as chatComposer,
  configResponse,
  newChatPage,
  sendMessage,
  textMessage,
  transcript as chatTranscript,
} from "./chat-flow-fixtures.test-support.ts";
import {
  chatSessionListResponse,
  createChatFlowE2eSuite,
  expectRequestCountStable,
  installMockGateway,
  requireRecord,
  requireString,
  waitForRequests,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
async function followUpSettings(page: import("playwright").Page, mode: string, shortcut?: string) {
  await page.goto(`${suite.server.baseUrl}settings/appearance`);
  await page.locator("[data-settings-follow-up-mode]").selectOption(mode);
  if (shortcut) {
    await page.locator("[data-settings-send-shortcut]").selectOption(shortcut);
  }
}

async function restoredSteer(name: string, age: number, offset: number, seq: number) {
  const { page } = await newChatPage(suite);
  const runId = `run-steer-${name}`,
    steerRunId = `steer-${name}`;
  const startedAt = Date.now() - age;
  const initialText = "Explain the long running operation.";
  const steerText = "Now focus on the remaining work.";
  const userMessage = {
    role: "user",
    content: initialText,
    timestamp: startedAt - 1_000,
    __openclaw: { id: `${name}-user`, idempotencyKey: `${runId}:user`, seq: 1 },
  };
  const steerMessage = {
    role: "user",
    content: steerText,
    timestamp: startedAt + offset,
    __openclaw: {
      id: `${name}-steer`,
      idempotencyKey: `${steerRunId}:user`,
      seq,
      steerTargetRunId: runId,
    },
  };
  const sessionInfo = { activeRunIds: [runId], hasActiveRun: true, key: "agent:main:main" };
  const gateway = await installMockGateway(page, {
    historyMessages: [userMessage],
    inFlightRun: { runId, startedAt, text: "" },
    sessionInfo,
  });
  const emitSteer = () =>
    gateway.emitGatewayEvent("session.message", {
      ...sessionInfo,
      clientRunId: steerRunId,
      message: steerMessage,
      messageId: `${name}-steer`,
      messageSeq: seq,
      sessionKey: "agent:main:main",
    });
  const emitDelta = (text: string) =>
    gateway.emitGatewayEvent(
      "chat",
      chatEvent(runId, "agent:main:main", "delta", { message: textMessage("assistant", text) }),
    );
  const reconnect = async () => {
    const after = (await gateway.getRequests("chat.startup")).length;
    await gateway.deferNext("chat.startup");
    await gateway.setOnline(false);
    await waitForControlUiGatewayReconnecting(page);
    await gateway.setOnline(true);
    await gateway.waitForRequest("chat.startup", { after });
    await gateway.resolveDeferred("chat.startup");
  };
  return {
    page,
    gateway,
    runId,
    startedAt,
    initialText,
    steerText,
    userMessage,
    steerMessage,
    sessionInfo,
    emitSteer,
    emitDelta,
    reconnect,
  };
}

suite.define(() => {
  it("removes the typed /steer queue chip after consumption while the original run stays active", async () => {
    const { page } = await newChatPage(suite);
    const runId = "active-run";
    const sessionKey = "agent:main:main";
    const sessionInfo = { key: sessionKey, activeRunIds: [runId], hasActiveRun: true };
    const gateway = await installMockGateway(page, {
      historyMessages: [
        persistedText("user", "Check how the metrics file is populated.", {
          id: "original-user",
          idempotencyKey: `${runId}:user`,
          seq: 1,
        }),
      ],
      inFlightRun: { runId, text: "Checking the metrics pipeline." },
      sessionInfo,
    });
    await page.goto(`${suite.server.baseUrl}chat`);
    const stop = page.getByRole("button", { name: "Stop generating" });
    await stop.waitFor();
    const steerText = "Keep the numbers in metrics.json, not USER.md.";
    await gateway.deferNext("chat.send");
    await chatComposer(page).fill(`/steer ${steerText}`);
    await chatComposer(page).press("Control+Enter");
    const sent = await gateway.waitForRequest("chat.send");
    const params = requireRecord(sent.params);
    expect(params).toMatchObject({ sessionKey, message: steerText, queueMode: "steer" });
    const steerRunId = requireString(params.idempotencyKey, "steer input identity");
    await gateway.resolveDeferred("chat.send", { runId: steerRunId, status: "started" });
    const steerMessage = persistedText("user", steerText, {
      id: "consumed-steer",
      idempotencyKey: `${steerRunId}:user`,
      seq: 2,
      steerTargetRunId: runId,
    });
    await gateway.emitGatewayEvent("session.message", {
      ...sessionInfo,
      sessionKey,
      clientRunId: steerRunId,
      message: steerMessage,
      messageId: "consumed-steer",
      messageSeq: 2,
    });
    const reply = "Understood. I will verify metrics.json and leave USER.md unchanged.";
    await gateway.emitGatewayEvent(
      "chat",
      chatEvent(runId, sessionKey, "delta", {
        message: textMessage("assistant", reply),
      }),
    );
    const userBubble = page.locator(".chat-group.user", { hasText: steerText });
    const replyBubble = chatTranscript(page).getByText(reply, { exact: true });
    await expectCount(userBubble, 1);
    await replyBubble.waitFor();
    await stop.waitFor();
    const parent = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
    if (parent) {
      const dir = createControlUiE2eArtifactDir("consumed-slash-steer", parent);
      const frame = await takeControlUiScreenshotFrame(
        page,
        chatTranscript(page),
        [userBubble, replyBubble, stop],
        { animations: "disabled" },
      );
      await fs.writeFile(path.join(dir, "consumed-steer.png"), frame.png);
    }
    await expectCount(page.locator(".chat-queue__item"), 0);
  });

  it("preserves a non-steer server default for active-run follow-ups", async () => {
    const { page } = await newChatPage(suite);
    const runtimeConfig = {
      messages: { queue: { byChannel: { webchat: "followup" }, mode: "steer" } },
    };
    const gateway = await installMockGateway(page, {
      methodResponses: { "config.get": configResponse(runtimeConfig, "queue-followup-config") },
    });

    await page.goto(`${suite.server.baseUrl}settings/appearance`);
    const followUpSelect = page.locator("[data-settings-follow-up-mode]");
    await followUpSelect.waitFor({ state: "visible", timeout: 10_000 });
    expect(await followUpSelect.inputValue()).toBe("server");
    await expectTextContains(followUpSelect.locator("option:checked"), "Server default (followup)");
    const configPatchCount = (await gateway.getRequests("config.patch")).length;
    const configGetCount = (await gateway.getRequests("config.get")).length;
    const overrideConfig = { ...runtimeConfig, ui: { prefs: { chatFollowUpMode: "steer" } } };
    await gateway.setMethodResponse(
      "config.get",
      configResponse(overrideConfig, "queue-followup-override-config"),
    );
    await followUpSelect.selectOption("steer");
    await waitForRequests(gateway, "config.patch", configPatchCount + 1);
    await waitForRequests(gateway, "config.get", configGetCount + 1);
    await page.getByText("Overriding server default (followup)").waitFor({ timeout: 10_000 });
    await gateway.setMethodResponse(
      "config.get",
      configResponse(runtimeConfig, "queue-followup-reset-config"),
    );
    await page.getByRole("button", { name: "Reset to server default" }).click();
    await waitForRequests(gateway, "config.patch", configPatchCount + 2);
    await waitForRequests(gateway, "config.get", configGetCount + 2);
    await expectTextContains(followUpSelect.locator("option:checked"), "Server default (followup)");
    expect(await followUpSelect.inputValue()).toBe("server");

    await page.goto(`${suite.server.baseUrl}chat`);

    const activePrompt = "keep this run active";
    await sendMessage(page, activePrompt);

    await gateway.waitForRequest("chat.send");
    await page.getByRole("button", { name: "Stop generating" }).waitFor({ timeout: 10_000 });

    const queuedPrompt = "queue this on the server";
    await sendMessage(page, queuedPrompt, "Queue message");

    const sends = await waitForRequests(gateway, "chat.send", 2);
    expect(requireRecord(sends[1]?.params)).toMatchObject({
      message: queuedPrompt,
      queueMode: "followup",
      sessionKey: "agent:main:main",
    });
    await page.locator(".chat-queue").waitFor({ state: "detached", timeout: 10_000 });
  });

  it("keeps the active run across a live steer operation", async () => {
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
        {
          role: "toolResult",
          toolCallId: "callExec",
          toolName: "exec",
          content: [{ type: "text", text: "process still running" }],
          __openclaw: { id: "exec-result", seq: 3 },
        },
      ],
      inFlightRun: { runId, text: "" },
      sessionInfo: { activeRunIds: [runId], hasActiveRun: true, key: "agent:main:main" },
    });

    await page.goto(`${suite.server.baseUrl}settings/appearance`);
    const configPatchesBefore = (await gateway.getRequests("config.patch")).length;
    await page.locator("[data-settings-follow-up-mode]").selectOption("queue");
    await waitForRequests(gateway, "config.patch", configPatchesBefore + 1);
    const shortcut = page.locator("[data-settings-send-shortcut]");
    await shortcut.selectOption("enter");
    expect(await shortcut.inputValue()).toBe("enter");
    await page.goto(`${suite.server.baseUrl}chat`);

    const composer = chatComposer(page);
    await page
      .locator(".chat-tool-msg-summary")
      .getByRole("img", { name: "exec", exact: true })
      .waitFor();
    await page.getByRole("button", { name: "Stop generating" }).waitFor();
    let agentSequence = 0;
    const commentaryText = "The active commentary stays visible.";
    await gateway.emitGatewayEvent(
      "agent",
      agentEvent(
        runId,
        "agent:main:main",
        "item",
        { kind: "preamble", itemId: "active-commentary", progressText: commentaryText },
        ++agentSequence,
        Date.now(),
      ),
    );
    const transcript = chatTranscript(page);
    await transcript.getByText(commentaryText, { exact: true }).waitFor();
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
    expect(steerParams).toMatchObject({
      deliver: false,
      message: steerText,
      queueMode: "steer",
      sessionKey: "agent:main:main",
    });
    expect(steerParams).not.toHaveProperty("expectedRunId");
    expect(steerParams).not.toHaveProperty("expectedLeafEntryId");
    const steerRunId = requireString(steerParams.idempotencyKey, "steer chat send idempotency key");
    await expectCount(transcript.getByText(commentaryText, { exact: true }), 1);
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
      session: {
        activeRunIds: [runId],
        hasActiveRun: true,
        key: "agent:main:main",
        kind: "direct",
        status: "running",
        updatedAt: Date.now(),
      },
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
    await gateway.emitGatewayEvent("session.message", {
      activeRunIds: [],
      clientRunId: runId,
      hasActiveRun: false,
      message: durableFinalMessage,
      messageId: "ui4-final",
      messageSeq: 5,
      runId,
      sessionKey: "agent:main:main",
    });
    await expectCount(
      page.locator("[data-virtual-row-key^='agent-run:'] .chat-bubble.streaming"),
      0,
    );
    await gateway.emitGatewayEvent(
      "chat",
      chatEvent(runId, "agent:main:main", "final", {
        message: textMessage("assistant", finalText, { openclawDisplayContent: [] }),
      }),
    );
    await expectCount(chatTranscript(page).getByText(finalText, { exact: true }), 1);
    await expectCount(page.locator(".chat-work-group", { hasText: "used process" }), 0);
  });

  it.each(["before", "after"] as const)(
    "keeps accepted steers before the unsaved tail when history resolves %s the live event",
    async (historyOrder) => {
      const {
        page,
        gateway,
        runId,
        startedAt,
        initialText,
        steerText,
        userMessage,
        steerMessage,
        sessionInfo,
        emitSteer,
        emitDelta,
        reconnect,
      } = await restoredSteer("order", 3_000, 1_000, 2);
      const beforeText = "This explanation streamed before the steering message.";
      const afterText = "This continuation streamed after the steering message.";
      await page.goto(`${suite.server.baseUrl}chat`);
      const transcript = chatTranscript(page);
      await transcript.getByText(initialText, { exact: true }).waitFor();
      await emitDelta(beforeText);
      await transcript.getByText(beforeText, { exact: true }).waitFor();
      if (historyOrder === "after") {
        await emitSteer();
        await transcript.getByText(steerText, { exact: true }).waitFor();
      }

      await gateway.setMethodResponse("chat.history", {
        messages: [userMessage, steerMessage],
        inFlightRun: { runId, startedAt, text: beforeText },
        sessionInfo,
      });
      await reconnect();
      await transcript.getByText(steerText, { exact: true }).waitFor();
      await page.getByRole("button", { name: "Stop generating" }).waitFor();
      if (historyOrder === "before") {
        await emitSteer();
      }
      await emitDelta(`${beforeText}\n\n${afterText}`);

      await expect
        .poll(() =>
          transcript
            .locator(".chat-bubble .chat-text")
            .evaluateAll((bubbles) => bubbles.map((bubble) => bubble.textContent?.trim())),
        )
        .toEqual([initialText, steerText, `${beforeText}\n${afterText}`]);
    },
  );

  it("keeps an accepted steer between saved output and its live continuation through reconnect", async () => {
    const {
      page,
      gateway,
      runId,
      startedAt,
      initialText,
      steerText,
      userMessage,
      steerMessage,
      sessionInfo,
      emitSteer,
      emitDelta,
      reconnect,
    } = await restoredSteer("split", 5_000, 3_000, 5);
    const beforeText = "A B";
    const commentaryText = "Checking the intermediate result.";
    const latestCommentaryText = "Checking the remaining work.";
    const afterText = "The remaining work continues after steering.";
    await page.goto(`${suite.server.baseUrl}chat`);
    const transcript = chatTranscript(page);
    const bubbleTexts = () =>
      transcript
        .locator(".chat-bubble .chat-text")
        .evaluateAll((bubbles) => bubbles.map((bubble) => bubble.textContent?.trim()));
    await transcript.getByText(initialText, { exact: true }).waitFor();
    await emitDelta(beforeText);
    await transcript.getByText(beforeText, { exact: true }).waitFor();
    await gateway.setMethodResponse("chat.history", {
      messages: [userMessage, steerMessage],
      inFlightRun: { runId, startedAt, text: beforeText },
      sessionInfo,
    });
    await emitSteer();
    await expect.poll(bubbleTexts).toEqual([initialText, steerText, beforeText]);

    const saved = (id: string, seq: number, content: string, extra = {}) => ({
      role: "assistant",
      content,
      __openclaw: { id, runId, seq },
      ...extra,
    });
    const fallback = (itemId: string, replacementText: string) => ({
      openclawStreamFallback: { itemId, source: "segment", replacementText, runId },
    });
    const savedMessages = [
      userMessage,
      saved("split-a", 2, "A", { timestamp: startedAt }),
      saved("split-commentary", 3, commentaryText, {
        timestamp: startedAt + 1_000,
        ...fallback("split-commentary-item", commentaryText),
      }),
      saved("split-b", 4, "B", { timestamp: startedAt + 2_000 }),
      steerMessage,
    ];
    await gateway.setMethodResponse("chat.history", {
      messages: savedMessages,
      inFlightRun: {
        runId,
        startedAt,
        text: "",
        events: [
          agentEvent(
            runId,
            "agent:main:main",
            "item",
            {
              kind: "preamble",
              itemId: "split-latest-commentary",
              progressText: latestCommentaryText,
            },
            1,
            startedAt + 4_000,
          ),
        ],
      },
      sessionInfo,
    });
    await reconnect();
    await transcript.getByText(commentaryText, { exact: true }).waitFor();
    await page.getByRole("button", { name: "Stop generating" }).waitFor();
    await emitDelta(afterText);

    await expect
      .poll(bubbleTexts)
      .toEqual([initialText, "A", commentaryText, "B", steerText, latestCommentaryText, afterText]);
    const savedAfter = [
      ...savedMessages,
      saved(
        "saved-latest-commentary",
        6,
        latestCommentaryText,
        fallback("split-latest-commentary", latestCommentaryText),
      ),
      saved("saved-answer", 7, afterText),
    ];
    await gateway.setMethodResponse("chat.history", {
      messages: savedAfter,
      sessionInfo: { ...sessionInfo, activeRunIds: [], hasActiveRun: false },
    });
    await page.reload();
    await expect
      .poll(bubbleTexts)
      .toEqual([initialText, "A", commentaryText, "B", steerText, latestCommentaryText, afterText]);
  });

  it("keeps modified Enter queued in modifier-enter shortcut mode", async () => {
    const { page, gateway } = await chatFixture(suite);

    await followUpSettings(page, "queue", "modifier-enter");
    await page.goto(`${suite.server.baseUrl}chat`);

    const composer = chatComposer(page);
    await sendMessage(page, "keep the modifier shortcut run active");
    await gateway.waitForRequest("chat.send");
    await page.getByRole("button", { name: "Stop generating" }).waitFor({ timeout: 10_000 });

    const queuedText = "leave this modifier follow-up queued";
    await composer.fill(queuedText);
    await composer.press("Control+Enter");

    const queuedRow = page.locator(".chat-queue__item", { hasText: queuedText });
    await queuedRow.waitFor({ timeout: 10_000 });
    await expectRequestCountStable(gateway, "chat.send", 1);
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

  it("honors a session interrupt override ahead of the webchat config default", async () => {
    const { page } = await newChatPage(suite);
    const sessionKey = "agent:main:main";
    const runtimeConfig = {
      messages: { queue: { byChannel: { webchat: "steer" }, mode: "steer" } },
    };
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "config.get": configResponse(runtimeConfig, "queue-session-override-config"),
        "sessions.list": chatSessionListResponse([
          {
            effectiveQueueMode: "interrupt",
            key: "agent:main:main",
            kind: "direct",
            label: "Main",
            queueMode: "interrupt",
            updatedAt: Date.now(),
          },
        ]),
      },
      sessionInfo: {
        effectiveQueueMode: "interrupt",
        hasActiveRun: false,
        key: "agent:main:main",
        queueMode: "interrupt",
        status: "done",
      },
      sessionKey,
    });

    await page.goto(`${suite.server.baseUrl}chat`);

    await sendMessage(page, "keep this run active");
    await gateway.waitForRequest("chat.send");
    await page.getByRole("button", { name: "Stop generating" }).waitFor({ timeout: 10_000 });

    const followUp = "interrupt for this session override";
    await sendMessage(page, followUp);

    const sends = await waitForRequests(gateway, "chat.send", 2);
    expect(requireRecord(sends[1]?.params)).toMatchObject({
      message: followUp,
      queueMode: "interrupt",
      sessionKey,
    });
  });

  it("steers a restored queued message when only the session row reports the active run", async () => {
    const { page, gateway } = await chatFixture(suite);

    await followUpSettings(page, "queue");
    await page.goto(`${suite.server.baseUrl}chat?session=main`);
    await expect.poll(() => new URL(page.url()).pathname).toMatch(/\/chat\/main$/);

    await sendMessage(page, "keep this run active");
    await gateway.waitForRequest("chat.send");
    await page.getByRole("button", { name: "Stop generating" }).waitFor({ timeout: 10_000 });

    const queuedPrompt = "steer this after restoring the queue";
    await sendMessage(page, queuedPrompt, "Queue message");
    await page.locator(".chat-queue").getByText(queuedPrompt).waitFor({ timeout: 10_000 });

    await gateway.setSessionsListResponse(
      chatSessionListResponse([
        {
          activeLeafEntryId: "leaf-active",
          activeRunIds: ["active-run"],
          hasActiveRun: true,
          key: "global",
          kind: "global",
          label: "Global",
          sessionId: "global-active-run",
          status: "running",
          updatedAt: Date.now(),
        },
        {
          activeLeafEntryId: "leaf-active",
          activeRunIds: ["active-run"],
          hasActiveRun: true,
          key: "agent:main:main",
          kind: "direct",
          label: "Main",
          sessionId: "main-active-run",
          status: "running",
          updatedAt: Date.now(),
        },
      ]),
    );
    await page.reload();
    await gateway.waitForRequest("sessions.list");

    const queue = page.locator(".chat-queue");
    await queue.getByText(queuedPrompt).waitFor({ timeout: 10_000 });
    await queue.getByRole("button", { name: "Steer" }).click();

    const steerRequest = await gateway.waitForRequest("chat.send");
    const steerParams = requireRecord(steerRequest.params);
    expect(steerParams).toMatchObject({
      deliver: false,
      message: queuedPrompt,
      queueMode: "steer",
      sessionKey: "agent:main:main",
    });
    expect(steerParams).not.toHaveProperty("expectedRunId");
    expect(steerParams).not.toHaveProperty("expectedLeafEntryId");
  });
});
