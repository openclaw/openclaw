import { expect, it } from "vitest";
import type { ChatHost } from "../pages/chat/chat-send-contract.ts";
import {
  timedText,
  persistedText,
  expectTextContains,
  agentEvent,
  chatDelta,
  chatEvent,
  chatFixture,
  composer as chatComposer,
  sendChat,
  sendMessage,
  transcript as chatTranscript,
} from "./chat-flow-fixtures.test-support.ts";
import {
  createChatFlowE2eSuite,
  expectRequestCountStable,
  requireRecord,
  requireString,
  waitForRequests,
} from "./chat-flow.test-support.ts";
import { waitForCommittedState } from "./settle.test-support.ts";

const suite = createChatFlowE2eSuite();

type WorkingRowSample = {
  height: number | null;
  key: string | null;
  sameRow: boolean;
  top: number | null;
};

suite.define(() => {
  it.each([
    { label: "desktop hover", mobile: false, viewport: { height: 900, width: 1440 } },
    { label: "mobile tap", mobile: true, viewport: { height: 844, width: 390 } },
  ])("reveals metadata across tool completion on $label", async ({ mobile, viewport }) => {
    const { context, page, gateway } = await chatFixture(
      suite,
      {
        historyMessages: [timedText("assistant", "Earlier completed reply.")],
      },
      { hasTouch: mobile, isMobile: mobile, viewport },
    );
    await page.goto(`${suite.server.baseUrl}chat`);
    await page.getByText("Earlier completed reply.").waitFor();
    const earlier = page.locator(".chat-group.assistant").first();
    const params = await sendChat(page, gateway, "show turn metadata");
    const runId = requireString(params.idempotencyKey, "chat send idempotency key");
    await gateway.emitGatewayEvent(
      "chat",
      chatDelta(runId, "This response is still streaming.", "main"),
    );
    const group = page.locator(".chat-group.assistant").last();
    await group.locator(".chat-bubble.streaming").waitFor();
    const footer = (target: typeof group) => target.locator(":scope > .chat-group-footer");
    const presentation = (target: typeof group) =>
      footer(target).evaluate((element) => {
        const style = getComputedStyle(element);
        return { opacity: style.opacity, pointerEvents: style.pointerEvents };
      });
    await expect.poll(() => presentation(earlier)).toEqual({ opacity: "0", pointerEvents: "none" });
    expect(await footer(group).locator(":scope > *").count()).toBe(0);
    await gateway.emitGatewayEvent(
      "agent",
      agentEvent(
        runId,
        "main",
        "tool",
        {
          args: { path: "README.md" },
          name: "read",
          phase: "start",
          toolCallId: "footer-read",
        },
        1,
        Date.now(),
      ),
    );
    await page.locator('[data-message-id^="tool:assistant:footer-read"]').waitFor();
    await page.locator(".chat-working-indicator").waitFor({ state: "visible" });
    const touch = mobile ? await context.newCDPSession(page) : null;
    if (touch) {
      const bubble = group.locator(".chat-bubble").last();
      await bubble.scrollIntoViewIfNeeded();
      const point = await bubble.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      });
      await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
    } else {
      await group.hover();
    }
    expect(await footer(group).locator(":scope > *").count()).toBe(0);
    await gateway.emitChatFinal({ runId, text: "The turn is complete." });
    await group.getByText("The turn is complete.", { exact: true }).waitFor();
    if (touch) {
      await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    } else {
      await group.hover();
    }
    await expect.poll(() => presentation(group)).toEqual({ opacity: "1", pointerEvents: "auto" });
    expect(await footer(group).locator(".chat-sender-name").textContent()).toBe("OpenClaw");
    expect(
      requireString(
        await footer(group).locator(".chat-group-timestamp").textContent(),
        "assistant timestamp",
      ).trim(),
    ).not.toBe("");
  });

  it("normalizes Unicode line separators in streaming and final chat DOM", async () => {
    const { page, gateway } = await chatFixture(suite);
    await page.goto(`${suite.server.baseUrl}chat`);
    await gateway.deferNext("chat.send");
    const params = await sendChat(page, gateway, "render Unicode separators");
    const runId = requireString(params.idempotencyKey, "chat send idempotency key");
    const streamingText = "## Unicode stream\u2028\u2028working **tail";
    await gateway.emitGatewayEvent("chat", chatDelta(runId, streamingText, "main"));

    await page.locator(".chat-thread h2").getByText("Unicode stream").waitFor({ timeout: 10_000 });
    await page
      .locator(".chat-bubble.streaming strong")
      .getByText("tail")
      .waitFor({ timeout: 10_000 });
    expect(await page.locator(".markdown-plain-text-fallback").count()).toBe(0);

    await gateway.resolveDeferred("chat.send", { runId, status: "started" });
    await page.locator(".chat-thread h2").getByText("Unicode stream").waitFor({ timeout: 10_000 });
    await gateway.emitChatFinal({
      runId,
      text: "## Unicode final\u2028\u2028- first\u2029- **second**",
    });

    await page.locator(".chat-thread h2").getByText("Unicode final").waitFor({ timeout: 10_000 });
    await expect
      .poll(() => page.locator(".chat-thread li").allTextContents(), { timeout: 10_000 })
      .toEqual(["first", "second"]);
    await page.locator(".chat-thread strong").getByText("second").waitFor({ timeout: 10_000 });
    expect(await page.locator(".markdown-plain-text-fallback").count()).toBe(0);
    const finalChatText = await page.locator(".chat-thread .chat-text").last().textContent();
    expect(finalChatText).not.toMatch(/[\u2028\u2029]/u);
  });

  it.each([
    { label: "desktop", viewport: { height: 900, width: 1280 } },
    { label: "mobile", viewport: { height: 844, width: 390 } },
  ])(
    "keeps streamed text visible when a chat error terminates the turn on $label",
    async ({ label, viewport }) => {
      const { page, gateway } = await chatFixture(suite, undefined, {
        hasTouch: label === "mobile",
        isMobile: label === "mobile",
        viewport,
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      const params = await sendChat(page, gateway, "stream before terminal error");
      const runId = requireString(params.idempotencyKey, "chat send idempotency key");
      const partialText = "Partial answer before gateway error.";
      await gateway.emitGatewayEvent("chat", chatDelta(runId, partialText, "main"));
      await chatTranscript(page).getByText(partialText).waitFor({ timeout: 10_000 });
      await gateway.emitGatewayEvent(
        "agent",
        agentEvent(
          runId,
          "main",
          "tool",
          {
            args: { path: "README.md" },
            name: "read",
            phase: "start",
            toolCallId: "call-before-terminal-error",
          },
          1,
          Date.now(),
        ),
      );
      const gatewayErrorText =
        "Agent failed before reply: Session became active in another runner; wait for it to finish before continuing.\nTo view logs, run `openclaw logs --follow` in a terminal.";
      await gateway.emitGatewayEvent(
        "chat",
        chatEvent(runId, "main", "error", {
          errorMessage: gatewayErrorText,
          message: timedText("assistant", gatewayErrorText),
        }),
      );
      const alert = page.locator(".chat-error");
      await alert.waitFor();
      const summary = alert.locator("summary");
      const copy = alert.getByRole("button", { name: "Copy error", exact: true });
      expect(await copy.isVisible()).toBe(label === "desktop");
      await summary.press("Enter");
      await alert.locator("pre").waitFor();
      await summary.press("Space");
      await alert.locator("pre").waitFor({ state: "hidden" });
      if (label === "mobile") {
        await summary.locator(".chat-error__mobile-title").tap();
        await alert.locator("pre").waitFor();
        await summary.locator(".chat-error__mobile-title").tap();
        await alert.locator("pre").waitFor({ state: "hidden" });
      }
      const [alertBox, composerBox] = await Promise.all([
        alert.boundingBox(),
        page.locator(".agent-chat__composer-shell").boundingBox(),
      ]);
      expect(alertBox).not.toBeNull();
      expect(composerBox).not.toBeNull();
      expect(
        Math.abs(alertBox!.x + alertBox!.width / 2 - composerBox!.x - composerBox!.width / 2),
      ).toBeLessThan(1);
      expect(alertBox!.width).toBeLessThanOrEqual(composerBox!.width);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        viewport.width,
      );
      expect(await chatTranscript(page).getByText(partialText, { exact: true }).count()).toBe(1);
      expect(await chatTranscript(page).getByText(`Error: ${gatewayErrorText}`).count()).toBe(0);
      expect(await alert.getByRole("button", { name: "Dismiss error" }).count()).toBe(0);
      expect(await alert.getByRole("button", { name: "Retry", exact: true }).count()).toBe(0);
      await expectRequestCountStable(gateway, "chat.send", 1);
      await sendMessage(page, "retry after error");
      await waitForRequests(gateway, "chat.send", 2);
      await alert.waitFor({ state: "detached", timeout: 10_000 });
    },
  );

  it("keeps the pending telemetry row stable through acknowledgement and streaming", async () => {
    const { page, gateway } = await chatFixture(suite, {
      sessionInfo: { key: "agent:main:main", kind: "group" },
    });

    await page.goto(`${suite.server.baseUrl}chat`);
    await gateway.deferNext("chat.send");

    const prompt = "hold this until the ack arrives";
    await sendMessage(page, prompt);

    const sendRequest = await gateway.waitForRequest("chat.send");
    await expect.poll(() => chatComposer(page).inputValue(), { timeout: 10_000 }).toBe("");
    const params = requireRecord(sendRequest.params);
    const runId = requireString(params.idempotencyKey, "chat send idempotency key");

    await page.locator(".chat-thread").getByText(prompt).waitFor({ timeout: 10_000 });
    const indicator = page.locator(".chat-reading-indicator");
    await indicator.waitFor({ timeout: 10_000 });
    expect(await page.locator(".chat-queue").count()).toBe(0);
    await page.locator(".chat-working-indicator").evaluate(async (element) => {
      await Promise.all(element.getAnimations().map((animation) => animation.finished));
    });
    const pendingRow = await indicator
      .locator(
        "xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' chat-virtual-row ')][1]",
      )
      .elementHandle();
    if (!pendingRow) {
      throw new Error("expected pending working indicator virtual row");
    }
    const pendingKey = await pendingRow.getAttribute("data-virtual-row-key");
    expect(pendingKey).not.toBeNull();
    const sampling = await pendingRow.evaluateHandle((originalRow) => ({
      samples: new Promise<WorkingRowSample[]>((resolve) => {
        const samples: WorkingRowSample[] = [];
        const sample = () => {
          const row = document
            .querySelector(".chat-reading-indicator")
            ?.closest<HTMLElement>(".chat-virtual-row");
          const rect = row?.getBoundingClientRect();
          samples.push({
            height: rect?.height ?? null,
            key: row?.getAttribute("data-virtual-row-key") ?? null,
            sameRow: row === originalRow,
            top: rect?.top ?? null,
          });
          if (samples.length === 20) {
            resolve(samples);
          } else {
            requestAnimationFrame(sample);
          }
        };
        sample();
      }),
    }));
    await gateway.resolveDeferred("chat.send", { runId, status: "started" });
    await page.locator(".chat-thread").getByText(prompt).waitFor({ timeout: 10_000 });
    await indicator.waitFor({ timeout: 10_000 });
    const samples = await sampling.evaluate((result) => result.samples);
    await sampling.dispose();
    const layouts = samples.filter(
      (sample): sample is { height: number; key: string; sameRow: true; top: number } =>
        sample.sameRow &&
        typeof sample.height === "number" &&
        typeof sample.key === "string" &&
        typeof sample.top === "number",
    );
    expect(layouts).toHaveLength(20);
    expect(new Set(layouts.map((sample) => sample.key))).toEqual(new Set([pendingKey]));
    const tops = layouts.map((sample) => sample.top);
    const heights = layouts.map((sample) => sample.height);
    expect(Math.max(...tops) - Math.min(...tops)).toBeLessThan(1);
    expect(Math.max(...heights) - Math.min(...heights)).toBeLessThan(1);

    await gateway.emitGatewayEvent(
      "agent",
      agentEvent(runId, "main", "usage", { outputTokens: 2_400 }, 1, Date.now()),
    );
    await expect
      .poll(async () =>
        (await page.locator(".chat-working-indicator__tokens").textContent())?.trim(),
      )
      .toBe("2.4k output tokens");

    const response = "The streamed response is now visible.";
    await gateway.emitGatewayEvent("chat", chatDelta(runId, response, "main"));

    await chatTranscript(page).getByText(response).waitFor({ timeout: 10_000 });
    expect(await pendingRow.$(".chat-avatar.assistant")).not.toBeNull();
    await indicator.waitFor({ state: "detached", timeout: 10_000 });
    const streamingLayout = await pendingRow.evaluate(
      (row, visibleResponse) => ({
        connected: row.isConnected,
        hasResponse: row.textContent?.includes(visibleResponse) ?? false,
        hasTokens: row.textContent?.includes("2.4k output tokens") ?? false,
        key: row.getAttribute("data-virtual-row-key"),
      }),
      response,
    );
    expect(streamingLayout).toEqual({
      connected: true,
      hasResponse: true,
      hasTokens: false,
      key: pendingKey,
    });
    await page.getByRole("button", { name: "Stop generating" }).waitFor();
    expect(await chatTranscript(page).getByText(response, { exact: true }).count()).toBe(1);
  });

  it("refreshes history after a tool-call window disconnects and reconnects", async () => {
    const { page, gateway } = await chatFixture(suite);

    await page.goto(`${suite.server.baseUrl}chat`);

    const prompt = "use a tool then reconnect";
    await chatComposer(page).fill(prompt);
    await gateway.deferNext("chat.send");
    await page.getByRole("button", { name: "Send message" }).click();

    const sendRequest = await gateway.waitForRequest("chat.send");
    const params = requireRecord(sendRequest.params);
    const runId = requireString(params.idempotencyKey, "chat send idempotency key");
    const sessionKey = requireString(params.sessionKey, "accepted session key");
    // The Gateway registers the run before its started ACK; losing the socket
    // during a tool call must not turn this fixture into a lost-delivery test.
    const acceptedSession = {
      key: sessionKey,
      sessionId: `session:${sessionKey}`,
      hasActiveRun: true,
      activeRunIds: [runId],
      status: "running",
    };
    await gateway.setMethodResponse("chat.history", {
      sessionId: acceptedSession.sessionId,
      sessionInfo: acceptedSession,
      messages: [],
    });
    await gateway.resolveDeferred("chat.send");
    // Default execution commits the original source before its ACK. Publish
    // live state after consumption, then disconnect during the tool run.
    await waitForCommittedState(
      page,
      ({ runId: expectedRunId }) => {
        const state = document.querySelector<HTMLElement & { state: ChatHost }>(
          "openclaw-chat-pane",
        )?.state;
        return state !== undefined && state.chatRunId === expectedRunId && !state.chatSending;
      },
      { runId },
    );
    await gateway.emitGatewayEvent("sessions.changed", acceptedSession);
    await waitForCommittedState(
      page,
      ({ runId: expectedRunId }) => {
        const state = document.querySelector<HTMLElement & { state: ChatHost }>(
          "openclaw-chat-pane",
        )?.state;
        return (
          state !== undefined && state.chatRunId === expectedRunId && state.chatQueue.length === 0
        );
      },
      { runId },
    );
    await page.locator(".chat-thread").getByText(prompt).waitFor({ timeout: 10_000 });

    await gateway.emitGatewayEvent(
      "agent",
      agentEvent(
        runId,
        sessionKey,
        "tool",
        { args: { query: "status" }, name: "status", phase: "start", toolCallId: "tool-1" },
        1,
        Date.now(),
      ),
    );
    await gateway.setHistoryMessages([
      persistedText("user", prompt, { idempotencyKey: `${runId}:user` }),
      timedText("assistant", "Recovered from refreshed history."),
    ]);

    expect(await page.locator(".chat-send-status").count()).toBe(0);

    await gateway.closeLatest(1006, "lost during tool call");

    await chatTranscript(page)
      .getByText("Recovered from refreshed history.")
      .waitFor({ timeout: 15_000 });
    expect(await page.locator(".chat-queue").count()).toBe(0);
    expect(await gateway.getRequests("chat.send")).toHaveLength(1);
  });

  it("keeps chat-only assistant text exact through tool activity and finalization", async () => {
    const { page, gateway } = await chatFixture(suite);

    await page.goto(`${suite.server.baseUrl}chat`);

    const connect = await gateway.waitForRequest("connect");
    expect(requireRecord(connect.params).caps).toContain("chat-only-assistant-text");

    const prompt = "stream before tool";
    const params = await sendChat(page, gateway, prompt);
    const runId = requireString(params.idempotencyKey, "chat send idempotency key");

    const initialStream = `I will inspect the file. ${"Prior streamed output. ".repeat(20)}`;
    await gateway.emitGatewayEvent("chat", chatDelta(runId, initialStream, "main"));
    const transcript = chatTranscript(page);
    await transcript.getByText("I will inspect the file.").waitFor({ timeout: 10_000 });

    await gateway.emitGatewayEvent(
      "agent",
      agentEvent(
        runId,
        "main",
        "tool",
        { name: "read", phase: "result", result: "file contents", toolCallId: "call-read" },
        1,
        Date.now() - 10_000,
      ),
    );
    const toolBubble = page.locator('[data-message-id^="tool:assistant:call-read"]');
    await toolBubble.waitFor({ timeout: 10_000 });

    const nextStream = "\n\n```ts\nconst answer = 42;";
    await gateway.emitGatewayEvent(
      "chat",
      chatEvent(runId, "main", "delta", { deltaText: nextStream }),
    );
    await expectTextContains(
      page.locator(".chat-bubble.streaming code.language-ts"),
      "const answer = 42;",
    );

    const stream = transcript.locator(".chat-bubble.streaming");
    expect(await stream.count()).toBe(1);
    expect((await stream.locator(".chat-text p").textContent())?.trim()).toBe(initialStream.trim());
    expect((await stream.locator("code.language-ts").textContent())?.trim()).toBe(
      "const answer = 42;",
    );
    expect(await toolBubble.count()).toBe(1);
    expect(await transcript.getByText("I will inspect the file.").count()).toBe(1);

    await gateway.emitChatFinal({ runId, text: `${initialStream}${nextStream}\n\`\`\`\n\nDone.` });
    const finalReply = transcript.locator(".chat-bubble", {
      has: page.locator("code.language-ts"),
    });
    await finalReply.getByText("Done.", { exact: true }).waitFor();
    expect(await stream.count()).toBe(0);
    expect(await finalReply.count()).toBe(1);
    expect(
      (await finalReply.locator(".chat-text p").allTextContents()).map((text) => text.trim()),
    ).toEqual([initialStream.trim(), "Done."]);
    expect((await finalReply.locator("code.language-ts").textContent())?.trim()).toBe(
      "const answer = 42;",
    );
  });
});
