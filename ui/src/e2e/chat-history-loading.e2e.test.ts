import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { newChatPage } from "./chat-flow.test-support.ts";
import { expectHistoryBoundaryState } from "./chat-history-boundary.test-support.ts";
import { expectTranscriptLayoutCommitted } from "./claude-sessions.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { captureFrame } from "./sidebar-assertions.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Chat history loading",
  startServerBeforeBrowser: true,
  trackBrowserContexts: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

function historyPage(messages: unknown[], hasMore: boolean, nextOffset?: number) {
  return {
    messages,
    hasMore,
    ...(hasMore && nextOffset !== undefined ? { olderCursor: `older-${nextOffset}` } : {}),
    nextOffset,
    totalMessages: 22,
    sessionId: "native-underfill-pagination",
    thinkingLevel: null,
  };
}

suite.define(() => {
  it("does not offer earlier history for unanchored tool-only activity", async () => {
    const page = await newChatPage(suite);
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "chat.startup": historyPage(
          [
            {
              role: "assistant",
              content: [
                {
                  type: "toolCall",
                  id: "read-1",
                  name: "read",
                  arguments: { path: "synthetic.txt" },
                },
              ],
            },
            {
              role: "toolResult",
              toolName: "read",
              toolCallId: "read-1",
              content: "Synthetic tool result",
            },
          ],
          true,
        ),
      },
    });
    await page.goto(`${suite.server.baseUrl}chat`);
    const pane = page.locator('openclaw-chat-pane[aria-hidden="false"]');
    const activity = pane.locator(".chat-tool-row, .chat-activity-group__summary").first();
    await activity.waitFor();
    await expectTranscriptLayoutCommitted(pane.locator(".chat-thread"));
    await captureFrame(suite.artifactDir, "boundary.png", pane, [activity]);
    expect(await pane.locator(".chat-history-boundary").count()).toBe(0);
    expect(
      await page
        .getByText(/Couldn't load earlier messages|History has no usable older boundary/)
        .count(),
    ).toBe(0);
    expect(await gateway.getRequests("chat.history")).toEqual([]);
  });

  it("shows an inline retry after earlier history fails on mobile and recovers in place", async () => {
    await suite.withPage(
      { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
      async ({ page }) => {
        const recent = {
          role: "assistant",
          content:
            "I found a better option for the report. I’m checking the details before sharing the final recommendation.",
          __openclaw: { id: "recent", seq: 22 },
        };
        const gateway = await installMockGateway(page, {
          deferredRequests: [{ method: "chat.history", match: { cursor: "older-1" } }],
          methodResponses: {
            "chat.startup": historyPage([recent], true, 1),
            "chat.history": historyPage(
              [
                {
                  role: "user",
                  content: "Please check the report and compare the available options.",
                  __openclaw: { id: "earlier", seq: 1 },
                },
              ],
              false,
            ),
          },
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        const pane = page.locator('openclaw-chat-pane[aria-hidden="false"]');
        await gateway.waitForRequest("chat.history");
        await gateway.rejectDeferred(
          "chat.history",
          { code: "UNAVAILABLE", message: "The connection was interrupted. Try again." },
          { match: { cursor: "older-1" } },
        );
        const retry = pane.getByRole("button", { name: "Retry earlier messages", exact: true });
        await expect.poll(() => retry.count()).toBe(1);
        await retry.click();
        await pane
          .getByText("Please check the report and compare the available options.", { exact: true })
          .waitFor();
        expect(await pane.locator(".chat-history-boundary").count()).toBe(0);
        expect(await pane.getByText(recent.content, { exact: true }).count()).toBe(1);
        expect(await gateway.getRequests("chat.history")).toMatchObject([
          { params: { cursor: "older-1" } },
          { params: { cursor: "older-1" } },
        ]);
      },
    );
  });

  it("keeps keyboard focus on the earlier-history action while older history loads", async () => {
    const page = await newChatPage(suite);
    const message = (seq: number) => ({
      __openclaw: { seq },
      role: seq % 2 ? "user" : "assistant",
      content: [{ type: "text", text: `Conversation message ${seq}` }],
      timestamp: 1_800_000_000_000 + seq,
    });
    const messages = (first: number, count: number) =>
      Array.from({ length: count }, (_, index) => message(first + index));
    const gateway = await installMockGateway(page, {
      deferredRequests: [{ method: "chat.history", match: { cursor: "older-40" } }],
      // A landed page stages the next one in the background; holding it keeps
      // the post-load boundary state independent of that prefetch.
      heldRequests: [{ method: "chat.history", match: { cursor: "older-60" } }],
      featureMethods: ["chat.metadata", "chat.startup"],
      methodResponses: {
        "chat.startup": historyPage(messages(41, 40), true, 40),
        "chat.history": {
          cases: [
            { match: { cursor: "older-40" }, response: historyPage(messages(21, 20), true, 60) },
            { match: { cursor: "older-60" }, response: historyPage(messages(1, 20), false) },
          ],
        },
      },
    });
    const cursors = async () =>
      (await gateway.getRequests("chat.history")).map(
        (request) => (request.params as { cursor?: string } | undefined)?.cursor,
      );
    await page.goto(`${suite.server.baseUrl}chat`);
    const pane = page.locator('openclaw-chat-pane[aria-hidden="false"]');
    await page.getByText("Conversation message 80", { exact: true }).waitFor();
    await expectHistoryBoundaryState(pane, false);
    const action = pane.locator(".chat-history-boundary__action");
    // Chromium keeps reporting a control that turns disabled as focused until its
    // next rendering step; without two frames the busy check passes on the old code.
    const actionFocused = async () => {
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          }),
      );
      return action.evaluate((element) => element === document.activeElement);
    };
    // Scrolling the control into view is reader intent: it starts the automatic
    // load and arms the next one. Focus without scrolling so Enter is the trigger.
    await action.evaluate((element) => (element as HTMLElement).focus({ preventScroll: true }));
    await page.keyboard.press("Enter");
    await gateway.waitForRequest("chat.history");
    await expectHistoryBoundaryState(pane, true);
    expect(await actionFocused()).toBe(true);
    await page.keyboard.press("Enter");
    await page.keyboard.press("Space");
    expect(await cursors()).toEqual(["older-40"]);

    await gateway.resolveDeferred("chat.history", undefined, { match: { cursor: "older-40" } });
    await expect.poll(cursors).toEqual(["older-40", "older-60"]);
    await expectHistoryBoundaryState(pane, false);
    expect(await actionFocused()).toBe(true);
    await page.close();
  });

  {
    const sessionId = "empty-tail-session";
    const sessionInfo = { key: "agent:main:main", kind: "direct" as const, sessionId };
    const emptyTailPage = (messages: unknown[], nextOffset?: number) => ({
      messages,
      hasMore: nextOffset !== undefined,
      ...(nextOffset === undefined ? {} : { nextOffset, olderCursor: `older-${nextOffset}` }),
      totalMessages: 200,
      sessionId,
      sessionInfo,
    });
    const olderMessages = ["Can you check the report?", "The report is ready for review."].map(
      (content, index) => ({
        role: index ? "assistant" : "user",
        content,
        __openclaw: { id: index ? "earlier-assistant" : "earlier-user", seq: index + 1 },
      }),
    );
    const hiddenActivity = Array.from({ length: 80 }, (_, index) => ({
      role: "toolResult",
      toolName: "read",
      toolCallId: `read-${index}`,
      content: [{ type: "text", text: "Synthetic tool result" }],
      __openclaw: { id: `activity-${index}`, seq: 121 + index },
    }));

    it("requires upward input after one empty automatic page through hidden activity", async () => {
      await suite.withPage({ viewport: { width: 1280, height: 480 } }, async ({ page }) => {
        const gateway = await installMockGateway(page, {
          sessions: [sessionInfo],
          methodResponses: {
            "config.get": { config: { ui: { prefs: { chatShowToolCalls: false } } } },
            "chat.startup": emptyTailPage(hiddenActivity, 80),
            "chat.history": {
              cases: [
                { match: { cursor: "older-80" }, response: emptyTailPage([], 160) },
                {
                  match: { cursor: "older-160" },
                  response: emptyTailPage(
                    [
                      {
                        ...hiddenActivity[0],
                        __openclaw: { id: "older-hidden-activity", seq: 100 },
                      },
                    ],
                    180,
                  ),
                },
                { match: { cursor: "older-180" }, response: emptyTailPage(olderMessages) },
              ],
            },
          },
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        const thread = page.locator(".chat-pane-cache__pane--active .chat-thread");
        await gateway.waitForRequest("sessions.messages.subscribe");
        await gateway.waitForRequest("chat.history");
        expect(await gateway.getRequests("chat.startup")).toEqual([]);
        await expectHistoryBoundaryState(page, false);
        await expectTranscriptLayoutCommitted(thread);
        expect(await gateway.getRequests("chat.history")).toMatchObject([
          { params: { cursor: "older-80" } },
        ]);
        await thread.hover();
        await page.mouse.wheel(0, -100);
        for (const { content } of olderMessages) {
          await page.locator(".chat-text").getByText(content, { exact: true }).waitFor();
        }
        expect(await page.locator(".agent-chat__welcome").count()).toBe(0);
        expect(await gateway.getRequests("chat.history")).toMatchObject([
          { params: { cursor: "older-80" } },
          { params: { cursor: "older-160" } },
          { params: { cursor: "older-180" } },
        ]);
      });
    });
  }
});
