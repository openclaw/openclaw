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
const emitFinal = (
  gateway: Awaited<ReturnType<typeof installMockGateway>>,
  runId: string,
  text: string,
  displayContent: ReturnType<typeof textContent> = [],
) =>
  gateway.emitGatewayEvent("chat", {
    sessionKey,
    runId,
    state: "final",
    message: terminalMessage(text, displayContent),
  });
async function openRun(
  page: Page,
  runId: string,
  options: Parameters<typeof installMockGateway>[1],
) {
  const gateway = await installMockGateway(page, {
    inFlightRun: activeRun(runId),
    sessionInfo: activeSession(runId),
    ...options,
  });
  await page.goto(`${suite.server.baseUrl}chat`);
  await stopButton(page).waitFor();
  return gateway;
}

suite.define(() => {
  it("recovers a retired final when its session message was missed", async () => {
    const page = await newChatPage(suite);
    const runId = "missed-terminal-publication";
    const answer = "Review complete. The verified fix is ready.";
    const user = chatMessage("user", "Finalize the review.", {
      __openclaw: { id: "finalize-user", seq: 1, idempotencyKey: runId + ":user" },
    });
    const gateway = await openRun(page, runId, { historyMessages: [user] });
    await page.getByText("Finalize the review.", { exact: true }).waitFor();
    const initialReads = (await gateway.getRequests("chat.history")).length;
    // Persistence succeeded, but this client missed the session.message publication.
    await gateway.setHistoryMessages([
      user,
      chatMessage("assistant", answer, {
        stopReason: "stop",
        __openclaw: { id: "finalize-answer", seq: 2, runId },
      }),
    ]);
    await emitFinal(gateway, runId, answer);
    await stopButton(page).waitFor({ state: "hidden" });

    await page.locator(".chat-text").getByText(answer, { exact: true }).waitFor();

    expect((await gateway.getRequests("chat.history")).length).toBe(initialReads + 1);
    expect(await page.locator(".chat-text").getByText(answer, { exact: true }).count()).toBe(1);
  });

  it("keeps a saved terminal answer once when its fallback notice arrives", async () => {
    const page = await newChatPage(suite);
    const runId = "fallback-terminal-run";
    const answer = "The workspace check is complete.";
    const notice =
      "Model Fallback: backup/model (selected primary/model; selected model unavailable)";
    const user = chatMessage("user", "Check the workspace.", {
      __openclaw: { id: "fallback-user", seq: 1, idempotencyKey: `${runId}:user` },
    });
    const savedAnswer = chatMessage("assistant", answer, {
      __openclaw: { id: "fallback-answer", seq: 2, runId },
    });
    const gateway = await openRun(page, runId, { historyMessages: [user, savedAnswer] });
    await gateway.deferNext("chat.history");
    await emitFinal(gateway, runId, answer);
    await gateway.emitGatewayEvent("chat", {
      sessionKey,
      runId,
      state: "final",
      message: {
        role: "assistant",
        content: [{ type: "text", text: notice, openclawStatusNotice: true }],
      },
    });
    await stopButton(page).waitFor({ state: "hidden" });

    const answerOccurrences = async () =>
      (await page.locator(".chat-group.assistant .chat-text").allTextContents()).filter((text) =>
        text.includes(answer),
      ).length;
    await expect.poll(answerOccurrences).toBe(1);
    expect(await page.locator(".chat-bubble.streaming").count()).toBe(0);
  });

  it.each([
    { order: "before hydration", tool: false, steer: false },
    { order: "after hydration", tool: false, steer: false },
    { order: "replayed after hydration", tool: false, steer: false },
    { order: "before hydration", tool: true, steer: false },
    { order: "before hydration", tool: false, steer: true },
  ])(
    "reconciles persistence $order (tool: $tool, steer: $steer)",
    async ({ order, tool, steer }) => {
      const page = await newChatPage(suite, {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      });
      const runId = "hydrated-answer-run";
      const text = "The workspace check is complete.";
      const tailText = "The follow-up check is complete.";
      const toolEvent = {
        sessionKey,
        runId,
        seq: 1,
        ts: 1_001,
        stream: "tool",
        data: {
          phase: "result",
          toolCallId: "workspace-check",
          name: "read",
          result: { content: textContent("Workspace ready.") },
        },
      };
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
      const message = chatMessage("assistant", text, {
        __openclaw: { id: "hydrated-answer", seq: 2, runId },
      });
      const historyMessages = [
        message,
        ...(steer
          ? [
              chatMessage("user", "Check the follow-up.", {
                __openclaw: {
                  id: "follow-up",
                  seq: 3,
                  idempotencyKey: "follow-up:user",
                  steerTargetRunId: runId,
                },
              }),
            ]
          : []),
      ];
      const sessionInfo = activeSession(runId);
      const inFlightRun = {
        ...activeRun(runId, steer ? "Checking the follow-up." : ""),
        ...(tool ? { events: [toolEvent, itemEvent] } : {}),
      };
      const gateway = await openRun(page, runId, {
        historyMessages: [],
        inFlightRun: { ...inFlightRun, text: "" },
      });
      await gateway.emitGatewayEvent("chat", {
        sessionKey,
        runId,
        state: "delta",
        deltaText: text,
        message: chatMessage("assistant", text),
      });
      if (tool) {
        await gateway.emitGatewayEvent("agent", toolEvent);
        await gateway.emitGatewayEvent("agent", itemEvent);
      }
      const persist = () =>
        gateway.emitGatewayEvent("session.message", {
          sessionKey,
          runId,
          hasActiveRun: true,
          activeRunIds: [runId],
          messageId: "hydrated-answer",
          messageSeq: 2,
          message,
        });
      const snapshot = {
        messages: historyMessages,
        inFlightRun,
        sessionInfo,
        thinkingLevel: null,
      };
      const startupCount = (await gateway.getRequests("chat.startup")).length;
      await gateway.deferNext("chat.startup");
      await gateway.setOnline(false);
      await gateway.setOnline(true);
      await gateway.waitForRequest("chat.startup", { after: startupCount });
      if (order !== "after hydration") {
        await persist();
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
        await persist();
      }
      await gateway.deferNext("chat.history");
      await emitFinal(
        gateway,
        runId,
        steer ? `${text} ${tailText}` : tool ? `Checking the workspace.\n\n${text}` : text,
        steer ? textContent(tailText) : [],
      );
      await stopButton(page).waitFor({ state: "hidden" });

      expect(await assistantTexts(page)).toEqual(steer ? [text, tailText] : [text]);
      expect(await page.locator(".chat-duplicate-count").count()).toBe(0);
      expect(await page.locator(".chat-bubble.streaming").count()).toBe(0);
      if (tool) {
        expect(await page.locator(".chat-tool-msg-summary").count()).toBe(1);
      }
    },
  );

  it("reconciles distinct commentary items once across reconnect", async () => {
    const page = await newChatPage(suite);
    const runId = "commentary-reconciliation-run";
    const startedAt = Date.now() - 30_000;
    const items = [
      { itemId: "commentary-item-one", text: "Inspecting the workspace." },
      { itemId: "commentary-item-two", text: "Checking the result." },
    ] as const;
    const events = items.map(({ itemId, text }, index) => ({
      data: { kind: "preamble", itemId, phase: "end", progressText: text },
      runId,
      seq: index + 1,
      sessionKey,
      stream: "item",
      ts: startedAt + 2_000 + index,
    }));
    const historyMessages = items.map(({ itemId, text }, index) =>
      chatMessage("assistant", text, {
        timestamp: startedAt + 1_000 + index,
        __openclaw: { id: `commentary-message-${index}`, runId, seq: index + 1 },
        openclawStreamFallback: { itemId, replacementText: text, source: "segment" },
      }),
    );
    const sessionInfo = activeSession(runId);
    const gateway = await openRun(page, runId, {
      historyMessages: [],
      inFlightRun: activeRun(runId, "", startedAt),
    });
    const transcript = page.locator(".chat-thread-inner");
    const itemOccurrences = async () => {
      const bubbles = await transcript.locator(".chat-bubble").allTextContents();
      return items.map(({ text }) => bubbles.filter((bubble) => bubble.trim() === text).length);
    };

    for (const event of events) {
      await gateway.emitGatewayEvent("agent", event);
    }
    await expect.poll(itemOccurrences).toEqual([1, 1]);
    await expect
      .poll(async () =>
        (
          await transcript.locator(".chat-text").filter({ hasText: items[1].text }).textContent()
        )?.trim(),
      )
      .toBe(items[1].text);

    const startupCount = (await gateway.getRequests("chat.startup")).length;
    await gateway.setMethodResponse("chat.startup", {
      messages: historyMessages,
      inFlightRun: { runId, startedAt, text: "", events },
      sessionInfo,
      thinkingLevel: null,
    });
    await gateway.setOnline(false);
    await gateway.setOnline(true);
    await gateway.waitForRequest("chat.startup", { after: startupCount });
    await expect.poll(itemOccurrences).toEqual([1, 1]);
  });

  it("keeps persisted commentary once when its replay items were evicted", async () => {
    const page = await newChatPage(suite);
    const runId = "evicted-commentary-run";
    const commentary = ["Checking the workspace.", "The focused tests are green."];
    const historyMessages = [
      chatMessage("user", "Inspect the workspace.", {
        __openclaw: { id: "user", seq: 1, idempotencyKey: `${runId}:user` },
      }),
      ...commentary.map((text, index) =>
        chatMessage("assistant", text, {
          __openclaw: { id: `commentary-${index}`, runId, seq: index + 2 },
          openclawStreamFallback: {
            itemId: `preamble-${index}`,
            replacementText: text,
            source: "segment",
          },
        }),
      ),
    ];
    await openRun(page, runId, {
      historyMessages,
      inFlightRun: {
        ...activeRun(runId, "Still working."),
        events: [
          {
            runId,
            seq: 51,
            stream: "tool",
            ts: 2_000,
            sessionKey,
            data: {
              phase: "result",
              toolCallId: "focused-tests",
              name: "exec",
              result: { content: textContent("Tests passed.") },
            },
          },
        ],
      },
    });
    const readAssistantTexts = () => assistantTexts(page);
    await expect.poll(readAssistantTexts).toEqual([...commentary, "Still working."]);
    expect(await page.locator(".chat-tool-msg-summary").count()).toBe(1);
  });

  it.each([
    { persistence: "after partial streaming", terminal: "final" },
    { persistence: "before first stream", terminal: "error" },
  ])(
    "keeps one answer during workspace reconciliation with persistence $persistence and $terminal",
    async ({ persistence, terminal }) => {
      const page = await newChatPage(suite);
      const gateway = await installMockGateway(page, { historyMessages: [] });
      await page.goto(`${suite.server.baseUrl}chat`);
      await page.locator(".agent-chat__composer-combobox textarea").fill("Check the workspace");
      await page.getByRole("button", { name: "Send message" }).click();
      const send = await gateway.waitForRequest("chat.send");
      const runId = requireString(requireRecord(send.params).idempotencyKey, "chat run id");
      const text = "Workspace changes are ready.";
      const partial = "Workspace";
      const emitDelta = (snapshot: string, deltaText: string, replace = false) =>
        gateway.emitGatewayEvent("chat", {
          sessionKey: "main",
          runId,
          state: "delta",
          deltaText,
          ...(replace ? { replace: true } : {}),
          message: chatMessage("assistant", snapshot),
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
      await gateway.emitGatewayEvent("session.message", {
        sessionKey: "main",
        runId,
        clientRunId: runId,
        hasActiveRun: true,
        activeRunIds: [runId],
        messageId: "workspace-answer",
        messageSeq: 2,
        session: {
          key: "main",
          kind: "direct",
          status: "running",
          updatedAt: Date.now(),
          hasActiveRun: true,
          activeRunIds: [runId],
        },
        message: chatMessage("assistant", text, {
          __openclaw: { id: "workspace-answer", seq: 2, runId },
        }),
      });
      await page.locator(".chat-group.assistant .chat-text", { hasText: text }).waitFor();
      await gateway.emitGatewayEvent("agent", {
        sessionKey: "main",
        runId,
        seq: 3,
        ts: Date.now(),
        stream: "lifecycle",
        data: { phase: "finishing" },
      });
      await expect.poll(() => page.locator(".chat-bubble.streaming").count()).toBe(0);
      expect(await assistantTexts(page)).toEqual([text]);
      expect(await page.locator(".chat-duplicate-count").count()).toBe(0);
      expect(await stopButton(page).isEnabled()).toBe(true);
      await page.locator(".chat-working-indicator").waitFor({ state: "hidden" });

      const errorMessage = "Workspace reconciliation failed: the destination is read-only.";
      await gateway.emitGatewayEvent("chat", {
        sessionKey: "main",
        runId,
        state: terminal,
        ...(terminal === "error" ? { errorMessage } : {}),
        message: terminalMessage(text),
      });
      await stopButton(page).waitFor({ state: "hidden" });
      await page.locator(".chat-working-indicator").waitFor({ state: "hidden" });
      if (terminal === "error") {
        const failure = page.locator(".chat-error").filter({ hasText: errorMessage });
        await failure
          .locator("summary strong")
          .getByText("Couldn't finish this reply. Check the conversation before trying again.")
          .waitFor();
        await failure.locator("summary").click();
        await failure.getByLabel("Error details", { exact: true }).waitFor();
        expect(await failure.getByLabel("Error details", { exact: true }).textContent()).toContain(
          errorMessage,
        );
      }
      await emitDelta(text, text.slice(partial.length));
      await expect.poll(() => page.locator(".chat-bubble.streaming").count()).toBe(0);
      expect(await assistantTexts(page)).toEqual([text]);
      expect(await page.locator(".chat-duplicate-count").count()).toBe(0);
    },
  );
});
