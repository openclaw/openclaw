import type { Page } from "playwright";
import { expect, it } from "vitest";
import type { ChatQueueItem } from "../lib/chat/chat-types.ts";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import {
  chatSessionListResponse,
  newChatPage,
  chatMessage,
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  expectDefined,
  expectRequestCountStable,
  installMockGateway,
  requireRecord,
  readOutboxPayloadAttachments,
  requireString,
  scrollChatThreadToTop,
  visibleChatBubbleTexts,
  waitForChatScrollIdle,
  waitForRequests,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
const wait = { timeout: 10_000 };
type FrameSample = {
  hiddenNotice: boolean;
  loading: boolean;
  messageCount: number;
  minOpacity: number;
  sessionKey: string;
};
const sessionRow = (key: string, label: string, updatedAt: number, extra = {}) => ({
  key,
  kind: "direct",
  label,
  updatedAt,
  ...extra,
});
async function expectVisiblePair(page: Page, userIndex: number) {
  await expect
    .poll(async () => {
      const texts = await visibleChatBubbleTexts(page);
      return (
        texts.some((text) => text.includes(`User history question ${userIndex}`)) &&
        texts.some((text) => text.includes(`Assistant history answer ${userIndex + 1}`))
      );
    }, wait)
    .toBe(true);
}

const historyCase = (sessionKey: string, messages: unknown[], sessionId: string, extra = {}) => ({
  match: { sessionKey },
  response: { messages, sessionId, ...extra },
});
type FrameWindow = typeof globalThis & { chatSessionReturnSamples: FrameSample[] };
const sessionLink = (page: Page, key: string) =>
  page.locator(`.sidebar-recent-session[data-session-key="${key}"] a.sidebar-recent-session__link`);

suite.define(() => {
  it("restores active commentary when an evicted session revalidates from its cursor", async () => {
    const page = await newChatPage(suite);
    const sessionA = "agent:main:session-a";
    const sessionB = "agent:main:session-b";
    const sessionKeys = [
      sessionA,
      sessionB,
      "agent:main:session-c",
      "agent:main:session-d",
      "agent:main:session-e",
    ];
    const commentary = "Checking the workspace after returning.";
    const runStartedAt = Date.now() - 10_000;
    const pageResponse = (sessionKey: string, label: string) => ({
      deltaCursor: `cursor-${label.toLowerCase()}`,
      messages: [{ role: "user", content: `${label} cached prompt`, timestamp: 1 }],
      sessionId: `${label.toLowerCase()}-session`,
      sessionInfo: {
        key: sessionKey,
        sessionId: `${label.toLowerCase()}-session`,
        kind: "direct",
        updatedAt: 1,
      },
    });
    const historyCases = [
      {
        match: { cursor: "cursor-b", sessionKey: sessionB },
        response: {
          kind: "delta",
          messages: [],
          deltaCursor: "cursor-b-current",
          sessionInfo: {
            ...pageResponse(sessionB, "B").sessionInfo,
            updatedAt: 2,
            hasActiveRun: true,
            activeRunIds: ["run-b"],
            status: "running",
          },
          inFlightRun: {
            runId: "run-b",
            text: "",
            startedAt: runStartedAt,
            events: [
              {
                runId: "run-b",
                seq: 1,
                stream: "item",
                ts: runStartedAt,
                sessionKey: sessionB,
                data: {
                  kind: "preamble",
                  itemId: "preamble-restored",
                  progressText: commentary,
                },
              },
            ],
          },
        },
      },
      ...sessionKeys.map((sessionKey, index) => ({
        match: { sessionKey },
        response: pageResponse(sessionKey, String.fromCharCode(65 + index)),
      })),
    ];
    const sessionRows = sessionKeys.map((key, index) => ({
      key,
      sessionId: `${String.fromCharCode(97 + index)}-session`,
      kind: "direct" as const,
      label: `Session ${String.fromCharCode(65 + index)}`,
      updatedAt: sessionKeys.length - index,
      ...(key === sessionB
        ? { activeRunIds: ["run-b"], hasActiveRun: true, status: "running" as const }
        : {}),
    }));
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "chat.history": { cases: historyCases },
        "chat.startup": { cases: historyCases },
        "sessions.list": chatSessionListResponse(sessionRows),
      },
      sessionKey: sessionA,
    });

    await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionA));
    await page.getByText("A cached prompt", { exact: true }).waitFor(wait);
    await sessionLink(page, sessionB).click();
    await page.getByText("B cached prompt", { exact: true }).waitFor(wait);
    await sessionLink(page, sessionA).click();
    for (const [index, key] of sessionKeys.slice(2).entries()) {
      await sessionLink(page, key).click();
      await page
        .getByText(`${String.fromCharCode(67 + index)} cached prompt`, { exact: true })
        .waitFor(wait);
    }

    const cursorRequests = async () =>
      [
        ...(await gateway.getRequests("chat.startup")),
        ...(await gateway.getRequests("chat.history")),
      ]
        .map((request) => requireRecord(request.params))
        .filter((params) => params.sessionKey === sessionB && params.cursor === "cursor-b");
    const cursorRequestsBeforeReturn = (await cursorRequests()).length;
    await sessionLink(page, sessionB).click();
    await expect
      .poll(async () => (await cursorRequests()).length)
      .toBeGreaterThan(cursorRequestsBeforeReturn);
    const activePane = page.locator('openclaw-chat-pane[aria-hidden="false"]');
    const assistantText = activePane.locator(".chat-group.assistant .chat-text");
    await activePane.getByRole("button", { name: "Stop generating", exact: true }).waitFor(wait);
    await assistantText.getByText(commentary, { exact: true }).waitFor(wait);
    expect(
      await assistantText.allTextContents().then((texts) => texts.map((text) => text.trim())),
    ).toEqual([commentary]);
    expect(
      await activePane.locator(".chat-bubble").getByText(commentary, { exact: true }).count(),
    ).toBe(1);
  });

  it("keeps an unrelated retained transcript after another tab deletes a session", async () => {
    const page = await newChatPage(suite);
    const sessionA = "agent:main:session-a";
    const sessionB = "agent:main:session-b";
    const deletedSession = "agent:main:session-c";
    const sessionAText = "Session A survives the peer deletion.";
    const sessionBText = "Session B keeps the first pane retained.";
    const historyCases = {
      cases: [
        historyCase(sessionA, [chatMessage("assistant", sessionAText)], "session-a"),
        historyCase(sessionB, [chatMessage("assistant", sessionBText)], "session-b"),
      ],
    };
    const sessionListResponse = chatSessionListResponse([
      { key: sessionA, sessionId: "session-a", kind: "direct", label: "Session A", updatedAt: 3 },
      { key: sessionB, sessionId: "session-b", kind: "direct", label: "Session B", updatedAt: 2 },
      { key: deletedSession, kind: "direct", label: "Session C", updatedAt: 1 },
    ]);
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "chat.history": historyCases,
        "chat.startup": historyCases,
        "sessions.list": sessionListResponse,
      },
      sessionKey: sessionA,
    });

    await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionA));
    await page.getByText(sessionAText, { exact: true }).waitFor(wait);

    await sessionLink(page, sessionB).click();
    await page.getByText(sessionBText, { exact: true }).waitFor(wait);
    const retainedHistoryRequests = async () =>
      (await gateway.getRequests("chat.history")).filter(({ params }) => {
        const { sessionKey } = requireRecord(params);
        return sessionKey === sessionA || sessionKey === sessionB;
      });
    const historyRequestsBeforePeerDelete = (await retainedHistoryRequests()).length;
    const startupRequestsBeforePeerDelete = (await gateway.getRequests("chat.startup")).length;
    await page.evaluate(() => {
      window.addEventListener("storage", (event) => {
        if (event.key === "openclaw.control.chatSnapshots.invalidate.v1") {
          document.documentElement.dataset.snapshotInvalidationReceived = "true";
        }
      });
    });

    const peer = await page.context().newPage();
    try {
      await installMockGateway(peer, {
        methodResponses: {
          "sessions.delete": { deleted: true, ok: true },
          "sessions.list": sessionListResponse,
        },
        sessionKey: deletedSession,
      });
      await peer.goto(`${suite.server.baseUrl}sessions`);
      await peer.locator("openclaw-app-shell").waitFor({ state: "attached" });
      await expect(
        evaluateControlUiContext(
          peer,
          (application, sessionKey) => application.sessions.delete(sessionKey, { agentId: "main" }),
          deletedSession,
        ),
      ).resolves.toMatchObject({ deleted: true });
      await page.waitForFunction(
        () => document.documentElement.dataset.snapshotInvalidationReceived === "true",
      );
    } finally {
      await peer.close();
    }

    await sessionLink(page, sessionA).click();
    await page.getByText(sessionAText, { exact: true }).waitFor(wait);
    // Prefetch may warm C without reloading either retained pane. Request capture is
    // append-only, so checking history after the startup window covers the same interval.
    await expectRequestCountStable(gateway, "chat.startup", startupRequestsBeforePeerDelete);
    expect(await retainedHistoryRequests()).toHaveLength(historyRequestsBeforePeerDelete);
  });

  it("restores reasoning and tool activity after navigating away from a session", async () => {
    const page = await newChatPage(suite);
    const sessionA = "agent:main:session-a";
    const sessionB = "agent:main:session-b";
    const visibleAnswer = "Trace preserved after navigation.";
    const reasoning = "Checked the persisted session trace.";
    const placeholder = "Current session placeholder.";
    const currentMessages = [chatMessage("assistant", placeholder, { timestamp: 1 })];
    const traceMessages = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: reasoning },
          { type: "text", text: visibleAnswer },
          {
            type: "toolCall",
            id: "call-read",
            name: "read",
            arguments: { path: "AGENTS.md" },
          },
        ],
        timestamp: 2,
      },
      {
        role: "toolResult",
        toolCallId: "call-read",
        toolName: "read",
        content: [{ type: "text", text: "file contents" }],
        timestamp: 3,
      },
    ];
    const responseCases = {
      cases: [
        historyCase(sessionB, traceMessages, "trace-session", { thinkingLevel: "high" }),
        historyCase(sessionA, currentMessages, "current-session", { thinkingLevel: "high" }),
      ],
    };
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "chat.history": responseCases,
        "chat.startup": responseCases,
        "sessions.list": chatSessionListResponse([
          sessionRow(sessionA, "Session A", 2, {
            sessionId: "current-session",
            reasoningLevel: "on",
          }),
          sessionRow(sessionB, "Session B", 1, {
            sessionId: "trace-session",
            reasoningLevel: "on",
          }),
        ]),
      },
      sessionKey: sessionA,
    });

    await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionA));
    await page.getByText(placeholder).waitFor(wait);

    const expectTrace = async () => {
      await page.getByText(visibleAnswer, { exact: true }).waitFor(wait);
      await expect.poll(() => page.locator(".chat-thinking").textContent()).toContain(reasoning);
      await expect
        .poll(() => page.locator(".chat-tool-msg-summary").textContent())
        .toContain("Read");
    };

    await sessionLink(page, sessionB).click();
    await expectTrace();

    await sessionLink(page, sessionA).click();
    await page.getByText(placeholder).waitFor(wait);
    const historyRequestsBeforeReturn = (await gateway.getRequests("chat.history")).length;
    await sessionLink(page, sessionB).click();
    await expectTrace();
    expect(await gateway.getRequests("chat.history")).toHaveLength(historyRequestsBeforeReturn);
  });

  it("shows persisted user messages after opening History and scrolling mixed history", async () => {
    const page = await newChatPage(suite);
    const baseTs = Date.now() - 100_000;
    const currentSessionMessages = [
      chatMessage("assistant", "Current session placeholder", { timestamp: baseTs - 1 }),
    ];
    const historyMessages = Array.from({ length: 70 }, (_, index) => ({
      content: [
        {
          text: `${index % 2 === 0 ? "User history question" : "Assistant history answer"} ${index}\n${"history detail line\n".repeat(4)}`,
          type: index % 2 === 0 ? "input_text" : "output_text",
        },
      ],
      role: index % 2 === 0 ? "user" : "assistant",
      timestamp: baseTs + index,
    }));
    const gateway = await installMockGateway(page, {
      // A stays fixed while B's shared history/startup snapshot grows below.
      historyMessages: currentSessionMessages,
      sessionTranscripts: {
        "agent:main:session-a": { messages: currentSessionMessages },
      },
      deferredMethods: ["chat.history"],
      methodResponses: {
        "sessions.list": chatSessionListResponse([
          sessionRow("agent:main:session-a", "Session A", 2, {
            sessionId: "control-ui-e2e-history-session-a",
          }),
          sessionRow("agent:main:session-b", "Session B", 1, {
            sessionId: "control-ui-e2e-history-session-b",
          }),
        ]),
      },
      sessionKey: "agent:main:session-a",
    });

    await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:session-a"));
    await page.getByText("Current session placeholder").waitFor(wait);

    // Keyboard navigation intent warms the short snapshot before startup expands it.
    const sessionBLink = sessionLink(page, "agent:main:session-b");
    await sessionBLink.focus();
    await waitForRequests(gateway, "chat.history", 1, { sessionKey: "agent:main:session-b" });
    await gateway.resolveDeferred("chat.history");
    await gateway.deferNext("chat.startup", { sessionKey: "agent:main:session-b" });
    const startupCountBeforeSwitch = (await gateway.getRequests("chat.startup")).length;
    await sessionBLink.click();
    const startupRequests = await waitForRequests(
      gateway,
      "chat.startup",
      startupCountBeforeSwitch + 1,
    );
    const historyRequest = expectDefined(startupRequests.at(-1), "session B startup request");
    expect(requireRecord(historyRequest.params)).toMatchObject({
      sessionKey: "agent:main:session-b",
    });
    const activeThread = page.locator(".chat-pane-cache__pane--active .chat-thread");
    await activeThread.getByText("Current session placeholder").waitFor(wait);
    await gateway.setHistoryMessages(historyMessages);
    await gateway.resolveDeferred("chat.startup");
    await activeThread.getByText("User history question 68").waitFor(wait);
    await activeThread
      .locator(".chat-bubble")
      .getByText("Assistant history answer 69")
      .waitFor(wait);
    await expectVisiblePair(page, 68);

    await waitForChatScrollIdle(page);
    await scrollChatThreadToTop(page);
    await activeThread.getByText("User history question 0").waitFor(wait);
    await scrollChatThreadToTop(page);
    await expectVisiblePair(page, 0);
  });

  it("keeps evicted paginated history stable when returning to a session", async () => {
    const page = await newChatPage(suite);
    const historyMessage = (seq: number, label: string) => ({
      __openclaw: { id: `history-${seq}`, seq },
      content: [
        {
          text: `${label} ${seq}\n${"retained transcript detail\n".repeat(3)}`,
          type: seq % 2 === 0 ? "output_text" : "input_text",
        },
      ],
      role: seq % 2 === 0 ? "assistant" : "user",
      timestamp: 1_800_000_000_000 + seq,
    });
    const shortSession = (letter: string, firstSeq: number, updatedAt: number) => ({
      ...sessionRow(`agent:main:session-${letter}`, `Session ${letter.toUpperCase()}`, updatedAt),
      messages: [firstSeq, firstSeq + 1].map((seq) =>
        historyMessage(seq, letter === "a" ? "short session" : `session ${letter}`),
      ),
      sessionId: `short-history-session${letter === "a" ? "" : `-${letter}`}`,
    });
    const shortSessions = [
      shortSession("a", 1, 4),
      shortSession("c", 201, 2),
      shortSession("d", 301, 1),
    ];
    const shortSessionHistoryCases = shortSessions.map(({ key, messages, sessionId }) =>
      historyCase(key, messages, sessionId, {
        hasMore: false,
        thinkingLevel: null,
        totalMessages: 2,
      }),
    );
    const recentMessages = Array.from({ length: 100 }, (_, index) =>
      historyMessage(index + 41, "recent retained message"),
    );
    const olderMessages = Array.from({ length: 40 }, (_, index) =>
      historyMessage(index + 1, "older retained message"),
    );
    const recentHistory = historyCase(
      "agent:main:session-b",
      recentMessages,
      "retained-history-session",
      {
        hasMore: true,
        nextOffset: 100,
        thinkingLevel: null,
        totalMessages: 140,
      },
    );
    const gateway = await installMockGateway(page, {
      historyMessages: shortSessions[0]!.messages,
      methodResponses: {
        "chat.history": {
          cases: [
            {
              match: { offset: 100, sessionKey: "agent:main:session-b" },
              response: {
                hasMore: false,
                messages: olderMessages,
                sessionId: "retained-history-session",
                thinkingLevel: null,
                totalMessages: 140,
              },
            },
            recentHistory,
            ...shortSessionHistoryCases,
          ],
        },
        "chat.startup": {
          cases: [recentHistory, ...shortSessionHistoryCases],
        },
        "sessions.list": chatSessionListResponse([
          ...shortSessions.map(({ key, label, updatedAt, sessionId }) =>
            sessionRow(key, label, updatedAt, { sessionId }),
          ),
          sessionRow("agent:main:session-b", "Session B", 3, {
            sessionId: "retained-history-session",
          }),
        ]),
      },
      sessionKey: "agent:main:session-a",
    });

    await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:session-a"));
    await page.getByText(/^short session 2\n/).waitFor(wait);

    const sessionB = sessionLink(page, "agent:main:session-b");
    const sessionA = sessionLink(page, "agent:main:session-a");
    const sessionC = sessionLink(page, "agent:main:session-c");
    const sessionD = sessionLink(page, "agent:main:session-d");
    await sessionB.click();
    await page.getByText(/^recent retained message 140\n/).waitFor(wait);
    const activePane = page.locator('openclaw-chat-pane[aria-hidden="false"]');
    const thread = activePane.locator(".chat-thread");
    await thread.hover();
    const previousScrollHeight = await thread.evaluate((element) => element.scrollHeight);
    await page.mouse.wheel(0, -1_000_000);
    await expect
      .poll(() =>
        activePane.evaluate(
          (element) =>
            (element as HTMLElement & { state: { chatMessages: unknown[] } }).state.chatMessages
              .length,
        ),
      )
      .toBe(140);
    await expect
      .poll(() =>
        thread.evaluate(
          (element, previousHeight) =>
            element.scrollHeight > previousHeight && element.scrollTop > 0,
          previousScrollHeight,
        ),
      )
      .toBe(true);
    await waitForChatScrollIdle(page);
    // Prepending preserves the visible anchor. A renewed upward gesture
    // reaches the newly loaded start instead of teleporting the reader.
    await page.mouse.wheel(0, -1_000_000);
    await page.getByText(/^older retained message 1\n/).waitFor(wait);

    for (const [link, text] of [
      [sessionA, /^short session 2\n/],
      [sessionC, /^session c 202\n/],
      [sessionD, /^session d 302\n/],
    ] as const) {
      await link.click();
      await page.getByText(text).waitFor(wait);
    }
    const historyRequestsBeforeReturn = (await gateway.getRequests("chat.history")).length;
    await page.evaluate(() => {
      const samples: FrameSample[] = [];
      (globalThis as FrameWindow).chatSessionReturnSamples = samples;
      const deadline = performance.now() + 750;
      const sample = () => {
        const pane = document.querySelector('openclaw-chat-pane[aria-hidden="false"]') as
          | (HTMLElement & {
              state?: { chatMessages?: unknown[]; sessionKey?: string };
            })
          | null;
        const rows = Array.from(pane?.querySelectorAll<HTMLElement>("[data-chat-row-key]") ?? []);
        samples.push({
          hiddenNotice: pane?.textContent?.includes("Showing last") ?? false,
          loading: pane?.querySelector('.chat-history-boundary__action[aria-busy="true"]') !== null,
          messageCount: pane?.state?.chatMessages?.length ?? 0,
          minOpacity: rows.reduce(
            (minimum, row) => Math.min(minimum, Number.parseFloat(getComputedStyle(row).opacity)),
            1,
          ),
          sessionKey: pane?.state?.sessionKey ?? "",
        });
        if (performance.now() < deadline) {
          requestAnimationFrame(sample);
        }
      };
      requestAnimationFrame(sample);
    });

    await sessionB.click();
    // Returning preserves the reading position at the loaded-history start;
    // the user can still use the normal jump-to-end control for message 140.
    await page.getByText(/^older retained message 1\n/).waitFor(wait);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 800);
    });
    const samples = await page.evaluate(() => (globalThis as FrameWindow).chatSessionReturnSamples);
    const returnedSamples = samples.filter(
      (sample) => sample.sessionKey === "agent:main:session-b",
    );
    const restoredIndex = returnedSamples.findIndex((sample) => sample.messageCount === 140);
    expect(restoredIndex).toBeGreaterThanOrEqual(0);
    expect(
      returnedSamples.slice(restoredIndex).every((sample) => sample.messageCount === 140),
    ).toBe(true);
    for (const sample of returnedSamples) {
      expect(sample).toMatchObject({ minOpacity: 1, hiddenNotice: false, loading: false });
    }
    await expectRequestCountStable(gateway, "chat.history", historyRequestsBeforeReturn);
  });

  it("stores new input while offline and sends it after reconnect", async () => {
    const page = await newChatPage(suite);
    const gateway = await installMockGateway(page, {
      sessionScope: "global",
      mainSessionKey: "global",
      methodResponses: {
        "chat.history": {
          messages: [],
          sessionId: "session:global",
          sessionInfo: { hasActiveRun: false, status: "done" },
          thinkingLevel: null,
        },
      },
    });

    await page.goto(controlUiSessionUrl(suite.server.baseUrl, "global"));
    const composer = page.locator(".agent-chat__composer-combobox textarea");
    await composer.waitFor({ state: "visible", timeout: 10_000 });

    await gateway.setOnline(false);
    await page.locator(".agent-chat__input--offline").waitFor(wait);

    const prompt = "send this when the Gateway returns";
    const attachmentName = "offline-proof.txt";
    const attachmentMimeType = "text/plain";
    const attachmentText = "offline attachment proof";
    const attachmentBase64 = Buffer.from(attachmentText).toString("base64");
    const attachmentDataUrl = `data:${attachmentMimeType};base64,${attachmentBase64}`;
    expect(await composer.isEnabled()).toBe(true);
    await composer.fill(prompt);
    await page.locator(".agent-chat__file-input").setInputFiles({
      name: attachmentName,
      mimeType: attachmentMimeType,
      buffer: Buffer.from(attachmentText),
    });
    await page.locator(".chat-attachment-file__name", { hasText: attachmentName }).waitFor(wait);
    const send = page.getByRole("button", { name: "Send message" });
    expect(await send.isEnabled()).toBe(true);
    await send.click();

    const queue = page.locator(".chat-queue");
    await queue.getByText("Waiting for reconnect").waitFor(wait);
    await queue.getByText(prompt).waitFor(wait);
    expect(await gateway.getRequests("chat.send")).toHaveLength(0);
    const readStoredProof = async () => {
      const item = await page.evaluate(
        (expectedPrompt) =>
          Object.entries(sessionStorage)
            .filter(([key]) => key.startsWith("openclaw.control.chatComposer.v4:"))
            .flatMap(([, value]) => {
              const parsed = JSON.parse(value) as {
                sessions: Record<string, { queue?: ChatQueueItem[] }>;
              };
              return Object.values(parsed.sessions).flatMap((session) => session.queue ?? []);
            })
            .find((entry) => entry.text === expectedPrompt),
        prompt,
      );
      const attachment = item?.attachments?.find((entry) => entry.fileName === attachmentName);
      const payload = item?.attachmentPayload
        ? await readOutboxPayloadAttachments(page, item.attachmentPayload.key)
        : null;
      const storedAttachment = payload?.find((entry) => entry.fileName === attachmentName);
      return {
        attachment: Boolean(
          attachment &&
          storedAttachment &&
          attachment.dataUrl === undefined &&
          `data:${storedAttachment.mimeType};base64,${storedAttachment.base64}` ===
            attachmentDataUrl,
        ),
        prompt: item !== undefined,
        runId: item?.sendRunId ?? null,
        waitingReconnect: item?.sendState === "waiting-reconnect",
      };
    };
    await expect.poll(readStoredProof).toEqual({
      attachment: true,
      prompt: true,
      runId: expect.any(String),
      waitingReconnect: true,
    });
    const storedProof = await readStoredProof();
    const storedRunId = requireString(storedProof.runId, "stored offline send idempotency key");

    await page.reload();
    await expect.poll(readStoredProof).toEqual({
      attachment: true,
      prompt: true,
      runId: storedRunId,
      waitingReconnect: true,
    });
    // A cold reload waits for initial Gateway bootstrap before rebuilding the
    // UI. Storage survival here plus replay below is the reload contract.
    expect(await gateway.getRequests("chat.send")).toHaveLength(0);

    await gateway.setOnline(true);
    await page.locator("openclaw-chat-pane").waitFor({ state: "attached", timeout: 10_000 });

    const request = await gateway.waitForRequest("chat.send");
    const params = requireRecord(request.params);
    const runId = requireString(params.idempotencyKey, "offline send idempotency key");
    expect(params.message).toBe(prompt);
    expect(runId).toBe(storedRunId);
    expect(params.attachments).toEqual([
      {
        content: attachmentBase64,
        fileName: attachmentName,
        origin: "file",
        mimeType: attachmentMimeType,
        type: "file",
      },
    ]);
    await page.getByRole("button", { name: "Stop generating" }).waitFor(wait);
    await page.locator(".chat-thread").getByText(prompt).waitFor(wait);
    await expectRequestCountStable(gateway, "chat.send", 1);
    await gateway.emitChatFinal({ runId, text: "Delivered after reconnect." });
    await queue.waitFor({ state: "detached", timeout: 10_000 });
    await page.locator(".chat-thread").getByText(prompt).waitFor(wait);
    await expect
      .poll(async () => {
        const proof = await readStoredProof();
        return proof.attachment || proof.prompt || proof.runId === runId;
      })
      .toBe(false);
    await page.locator(".agent-chat__input--offline").waitFor({ state: "detached" });
    await expectRequestCountStable(gateway, "chat.send", 1);
  });
});
