import type { Page } from "playwright";
import { expect, it } from "vitest";
import {
  chatMessage,
  newChatPage,
  textContent,
  createChatFlowE2eSuite,
  installMockGateway,
  requireRecord,
  requireString,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
const sessionKey = "agent:main:main";
const activeSession = (runId: string) => ({
  key: sessionKey,
  activeRunIds: [runId],
  hasActiveRun: true,
});
const activeRun = (runId: string, text = "", startedAt = 1_000) => ({ runId, startedAt, text });
const assistantTexts = async (page: Page) =>
  (await page.locator(".chat-group.assistant .chat-text").allTextContents()).map((value) =>
    value.trim(),
  );
const terminalMessage = (text: string, displayContent: ReturnType<typeof textContent> = []) =>
  chatMessage("assistant", text, { openclawDisplayContent: displayContent });
const stopButton = (page: Page) => page.getByRole("button", { name: "Stop generating" });
type Gateway = Awaited<ReturnType<typeof installMockGateway>>;
const savedAnswer = (runId: string, text: string, id = "answer", seq = 2) => ({
  ...chatMessage("assistant", text),
  __openclaw: { id, seq, runId },
});
const savedUser = (runId: string, text: string, id = "user", extra = {}) =>
  chatMessage("user", text, {
    __openclaw: { id, seq: 1, idempotencyKey: `${runId}:user`, ...extra },
  });
const toolResult = (runId: string, toolCallId: string, name: string, text: string, seq = 1) => ({
  sessionKey,
  runId,
  seq,
  ts: 1_000 + seq,
  stream: "tool",
  data: { phase: "result", toolCallId, name, result: { content: textContent(text) } },
});
function commentaryFixture(runId: string, texts: string[], startedAt?: number, firstSeq = 1) {
  return {
    events: texts.map((text, index) => ({
      data: { kind: "preamble", itemId: `preamble-${index}`, phase: "end", progressText: text },
      runId,
      seq: index + firstSeq,
      sessionKey,
      stream: "item",
      ts: (startedAt ?? 0) + 2_000 + index,
    })),
    messages: texts.map((text, index) =>
      Object.assign(savedAnswer(runId, text, `commentary-${index}`, index + firstSeq), {
        ...(startedAt === undefined ? {} : { timestamp: startedAt + 1_000 + index }),
        openclawStreamFallback: {
          itemId: `preamble-${index}`,
          replacementText: text,
          source: "segment",
        },
      }),
    ),
  };
}
function runEvents(gateway: Gateway, runId: string, key = sessionKey) {
  const emit = (kind: string, payload: Record<string, unknown>) =>
    gateway.emitGatewayEvent(kind, { sessionKey: key, runId, ...payload });
  return {
    chat: (state: string, message: Record<string, unknown>, extra = {}) =>
      emit("chat", { state, message, ...extra }),
    final: (text: string, displayContent: ReturnType<typeof textContent> = []) =>
      emit("chat", { state: "final", message: terminalMessage(text, displayContent) }),
    agent: (stream: string, data: object, seq: number) =>
      emit("agent", { stream, data, seq, ts: Date.now() }),
    persist: (message: ReturnType<typeof savedAnswer>, extra = {}) =>
      emit("session.message", {
        hasActiveRun: true,
        activeRunIds: [runId],
        messageId: message["__openclaw"].id,
        messageSeq: message["__openclaw"].seq,
        message,
        ...extra,
      }),
  };
}
async function reconnect(gateway: Gateway) {
  const after = (await gateway.getRequests("chat.startup")).length;
  await gateway.setOnline(false);
  await gateway.setOnline(true);
  await gateway.waitForRequest("chat.startup", { after });
  return after;
}
async function expectReconciled(page: Page, texts: string[]) {
  expect(await assistantTexts(page)).toEqual(texts);
  expect(await page.locator(".chat-duplicate-count").count()).toBe(0);
  expect(await page.locator(".chat-bubble.streaming").count()).toBe(0);
}
async function openRun(runId: string, options: Parameters<typeof installMockGateway>[1]) {
  const page = await newChatPage(suite);
  const gateway = await installMockGateway(page, {
    historyMessages: [],
    inFlightRun: activeRun(runId),
    sessionInfo: activeSession(runId),
    ...options,
  });
  await page.goto(`${suite.server.baseUrl}chat`);
  await stopButton(page).waitFor();
  return { page, gateway, events: runEvents(gateway, runId) };
}

suite.define(() => {
  it("recovers a retired final when its session message was missed", async () => {
    const runId = "missed-terminal-publication";
    const answer = "Review complete. The verified fix is ready.";
    const user = savedUser(runId, "Finalize the review.");
    const { page, gateway, events } = await openRun(runId, { historyMessages: [user] });
    await page.getByText("Finalize the review.", { exact: true }).waitFor();
    const initialReads = (await gateway.getRequests("chat.history")).length;
    // Persistence succeeded, but this client missed the session.message publication.
    await gateway.setHistoryMessages([user, { ...savedAnswer(runId, answer), stopReason: "stop" }]);
    await events.final(answer);
    await stopButton(page).waitFor({ state: "hidden" });

    await page.locator(".chat-text").getByText(answer, { exact: true }).waitFor();

    expect((await gateway.getRequests("chat.history")).length).toBe(initialReads + 1);
    expect(await page.locator(".chat-text").getByText(answer, { exact: true }).count()).toBe(1);
  });

  it("keeps a saved terminal answer once when its fallback notice arrives", async () => {
    const runId = "fallback-terminal-run";
    const answer = "The workspace check is complete.";
    const notice =
      "Model Fallback: backup/model (selected primary/model; selected model unavailable)";
    const user = savedUser(runId, "Check the workspace.");
    const { page, gateway, events } = await openRun(runId, {
      historyMessages: [user, savedAnswer(runId, answer)],
    });
    await gateway.deferNext("chat.history");
    await events.final(answer);
    await events.chat("final", {
      role: "assistant",
      content: [{ type: "text", text: notice, openclawStatusNotice: true }],
    });
    await stopButton(page).waitFor({ state: "hidden" });

    await expect
      .poll(async () => (await assistantTexts(page)).filter((text) => text.includes(answer)).length)
      .toBe(1);
    expect(await page.locator(".chat-bubble.streaming").count()).toBe(0);
  });

  it.each([
    { order: "before hydration", tool: false, steer: false },
    { order: "after hydration", tool: false, steer: false },
    { order: "replayed after hydration", tool: false, steer: false },
    { order: "before hydration", tool: true, steer: false },
    { order: "before hydration", tool: false, steer: true },
  ])("reconciles $order (tool=$tool, steer=$steer)", async ({ order, tool, steer }) => {
    const runId = "hydrated-answer-run";
    const text = "The workspace check is complete.";
    const tailText = "The follow-up check is complete.";
    const toolEvent = toolResult(runId, "workspace-check", "read", "Workspace ready.");
    const itemEvent = {
      ...toolEvent,
      seq: 2,
      stream: "item",
      data: {
        itemId: "tool:workspace-check",
        toolCallId: "workspace-check",
        kind: "tool",
        name: "read",
        title: "Check workspace",
        phase: "end",
        status: "completed",
      },
    };
    const message = savedAnswer(runId, text, "hydrated-answer");
    const historyMessages: ReturnType<typeof chatMessage>[] = [message];
    if (steer) {
      historyMessages.push(
        savedUser("follow-up", "Check the follow-up.", "follow-up", {
          seq: 3,
          steerTargetRunId: runId,
        }),
      );
    }
    const inFlightRun = {
      ...activeRun(runId, steer ? "Checking the follow-up." : ""),
      ...(tool ? { events: [toolEvent, itemEvent] } : {}),
    };
    const { page, gateway, events } = await openRun(runId, {
      inFlightRun: { ...inFlightRun, text: "" },
    });
    await events.chat("delta", chatMessage("assistant", text), { deltaText: text });
    if (tool) {
      await gateway.emitGatewayEvent("agent", toolEvent);
      await gateway.emitGatewayEvent("agent", itemEvent);
    }
    const snapshot = {
      messages: historyMessages,
      inFlightRun,
      sessionInfo: activeSession(runId),
      thinkingLevel: null,
    };
    await gateway.deferNext("chat.startup");
    const startupCount = await reconnect(gateway);
    if (order !== "after hydration") {
      await events.persist(message);
      // A commit during the in-flight read retires it; the Gateway answers one fresh read.
      await gateway.deferNext("chat.startup");
    }
    await gateway.resolveDeferred("chat.startup", snapshot);
    if (order !== "after hydration") {
      await gateway.waitForRequest("chat.startup", { after: startupCount + 1 });
      await gateway.resolveDeferred("chat.startup", snapshot);
    }
    await page.waitForFunction(() => {
      const pane = document.querySelector<HTMLElement & { state?: { chatLoading: boolean } }>(
        "openclaw-chat-pane",
      );
      return pane?.state?.chatLoading === false;
    });
    await page.locator(".chat-group.assistant .chat-text", { hasText: text }).waitFor();
    if (order !== "before hydration") {
      await events.persist(message);
    }
    await gateway.deferNext("chat.history");
    await events.final(
      steer ? `${text} ${tailText}` : tool ? `Checking the workspace.\n\n${text}` : text,
      steer ? textContent(tailText) : [],
    );
    await stopButton(page).waitFor({ state: "hidden" });

    await expectReconciled(page, steer ? [text, tailText] : [text]);
    if (tool) {
      expect(await page.locator(".chat-tool-msg-summary").count()).toBe(1);
    }
  });

  it("reconciles distinct commentary items once across reconnect", async () => {
    const runId = "commentary-reconciliation-run";
    const startedAt = Date.now() - 30_000;
    const texts = ["Inspecting the workspace.", "Checking the result."];
    const { events, messages } = commentaryFixture(runId, texts, startedAt);
    const { page, gateway } = await openRun(runId, {
      inFlightRun: activeRun(runId, "", startedAt),
    });
    const transcript = page.locator(".chat-thread-inner");
    const itemOccurrences = async () => {
      const bubbles = await transcript.locator(".chat-bubble").allTextContents();
      return texts.map((text) => bubbles.filter((bubble) => bubble.trim() === text).length);
    };

    for (const event of events) {
      await gateway.emitGatewayEvent("agent", event);
    }
    await expect.poll(itemOccurrences).toEqual([1, 1]);
    const secondText = transcript.locator(".chat-text").filter({ hasText: texts[1] });
    await expect.poll(async () => (await secondText.textContent())?.trim()).toBe(texts[1]);

    await gateway.setMethodResponse("chat.startup", {
      messages,
      inFlightRun: { runId, startedAt, text: "", events },
      sessionInfo: activeSession(runId),
      thinkingLevel: null,
    });
    await reconnect(gateway);
    await expect.poll(itemOccurrences).toEqual([1, 1]);
  });

  it("keeps persisted commentary once when its replay items were evicted", async () => {
    const runId = "evicted-commentary-run";
    const commentary = ["Checking the workspace.", "The focused tests are green."];
    const historyMessages = [
      savedUser(runId, "Inspect the workspace."),
      ...commentaryFixture(runId, commentary, undefined, 2).messages,
    ];
    const { page } = await openRun(runId, {
      historyMessages,
      inFlightRun: {
        ...activeRun(runId, "Still working."),
        events: [{ ...toolResult(runId, "focused-tests", "exec", "Tests passed.", 51), ts: 2_000 }],
      },
    });
    await expect.poll(() => assistantTexts(page)).toEqual([...commentary, "Still working."]);
    expect(await page.locator(".chat-tool-msg-summary").count()).toBe(1);
  });

  it.each([
    { persistence: "after partial streaming", terminal: "final" },
    { persistence: "before first stream", terminal: "error" },
  ])("deduplicates $persistence then $terminal", async ({ persistence, terminal }) => {
    const page = await newChatPage(suite);
    const gateway = await installMockGateway(page, { historyMessages: [] });
    await page.goto(`${suite.server.baseUrl}chat`);
    await page.locator(".agent-chat__composer-combobox textarea").fill("Check the workspace");
    await page.getByRole("button", { name: "Send message" }).click();
    const send = await gateway.waitForRequest("chat.send");
    const runId = requireString(requireRecord(send.params).idempotencyKey, "chat run id");
    const text = "Workspace changes are ready.";
    const partial = "Workspace";
    const events = runEvents(gateway, runId, "main");
    const emitDelta = (snapshot: string, deltaText: string, replace = false) =>
      events.chat("delta", chatMessage("assistant", snapshot), {
        deltaText,
        ...(replace ? { replace: true } : {}),
      });
    if (persistence === "after partial streaming") {
      await emitDelta(partial, partial);
      await page.locator(".chat-bubble.streaming", { hasText: partial }).waitFor();
    }
    // Hold background refreshes so only the live message/delta boundary can repair the view.
    await gateway.deferNext("chat.history");
    if (persistence === "after partial streaming") {
      // The Gateway retires committed text before publishing its durable row.
      await emitDelta("", "", true);
    }
    await events.persist(savedAnswer(runId, text, "workspace-answer"), {
      clientRunId: runId,
      session: {
        ...activeSession(runId),
        key: "main",
        kind: "direct",
        status: "running",
        updatedAt: Date.now(),
      },
    });
    await page.locator(".chat-group.assistant .chat-text", { hasText: text }).waitFor();
    await events.agent("lifecycle", { phase: "finishing" }, 3);
    await expect.poll(() => page.locator(".chat-bubble.streaming").count()).toBe(0);
    await expectReconciled(page, [text]);
    expect(await stopButton(page).isEnabled()).toBe(true);
    await page.locator(".chat-working-indicator").waitFor({ state: "hidden" });

    const errorMessage = "Workspace reconciliation failed: the destination is read-only.";
    const terminalDetails = terminal === "error" ? { errorMessage } : {};
    await events.chat(terminal, terminalMessage(text), terminalDetails);
    await stopButton(page).waitFor({ state: "hidden" });
    await page.locator(".chat-working-indicator").waitFor({ state: "hidden" });
    if (terminal === "error") {
      const failure = page.locator(".chat-error").filter({ hasText: errorMessage });
      await failure
        .locator("summary strong")
        .getByText("Couldn't finish this reply. Check the conversation before trying again.")
        .waitFor();
      await failure.locator("summary").click();
      const details = failure.getByLabel("Error details", { exact: true });
      await details.waitFor();
      expect(await details.textContent()).toContain(errorMessage);
    }
    await emitDelta(text, text.slice(partial.length));
    await expect.poll(() => page.locator(".chat-bubble.streaming").count()).toBe(0);
    await expectReconciled(page, [text]);
  });
});
