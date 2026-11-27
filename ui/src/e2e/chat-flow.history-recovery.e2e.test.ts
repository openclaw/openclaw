import type { Page } from "playwright";
import { expect, it } from "vitest";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { sessionRow } from "./chat-flow-fixtures.test-support.ts";
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
  it("keeps retained text, reasoning and tools after another tab deletes a session", async () => {
    const page = await newChatPage(suite);
    const sessionA = "agent:main:session-a";
    const sessionB = "agent:main:session-b";
    const deletedSession = "agent:main:session-c";
    const sessionAText = "Session A survives the peer deletion.";
    const sessionBText = "Session B keeps the first pane retained.";
    const traceMessages = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Checked the persisted session trace." },
          { type: "text", text: sessionAText },
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
    const historyCases = {
      cases: [
        historyCase(sessionA, traceMessages, "session-a", { thinkingLevel: "high" }),
        historyCase(sessionB, [chatMessage("assistant", sessionBText)], "session-b"),
      ],
    };
    const sessionListResponse = chatSessionListResponse([
      {
        key: sessionA,
        sessionId: "session-a",
        kind: "direct",
        label: "Session A",
        updatedAt: 3,
        reasoningLevel: "on",
      },
      { key: sessionB, sessionId: "session-b", kind: "direct", label: "Session B", updatedAt: 2 },
      { key: deletedSession, kind: "direct", label: "Session C", updatedAt: 1 },
    ]);
    const gateway = await installMockGateway(page, {
      subscriptionInitialHistory: false,
      methodResponses: {
        "chat.history": historyCases,
        "chat.startup": historyCases,
        "sessions.list": sessionListResponse,
      },
      sessionKey: sessionA,
    });

    await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionA));
    await page.getByText(sessionAText, { exact: true }).waitFor(wait);
    await expect
      .poll(() => page.locator(".chat-thinking").textContent())
      .toContain("Checked the persisted session trace.");
    await expect.poll(() => page.locator(".chat-tool-msg-summary").textContent()).toContain("Read");

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
    await expect
      .poll(() => page.locator(".chat-thinking").textContent())
      .toContain("Checked the persisted session trace.");
    await expect.poll(() => page.locator(".chat-tool-msg-summary").textContent()).toContain("Read");
    // Prefetch may warm C without reloading either retained pane. Request capture is
    // append-only, so checking history after the startup window covers the same interval.
    await expectRequestCountStable(gateway, "chat.startup", startupRequestsBeforePeerDelete);
    expect(await retainedHistoryRequests()).toHaveLength(historyRequestsBeforePeerDelete);
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
      subscriptionInitialHistory: false,
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
        olderCursor: "older-session-b",
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
              match: { cursor: "older-session-b", sessionKey: "agent:main:session-b" },
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
});
