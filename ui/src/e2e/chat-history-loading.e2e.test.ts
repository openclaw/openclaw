import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { newChatPage } from "./chat-flow.test-support.ts";
import { expectHistoryBoundaryState } from "./chat-history-boundary.test-support.ts";
import { expectTranscriptLayoutCommitted } from "./claude-sessions.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

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
    nextOffset,
    totalMessages: 22,
    sessionId: "native-underfill-pagination",
    thinkingLevel: null,
  };
}

suite.define(() => {
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
      deferredRequests: [{ method: "chat.history", match: { offset: 40 } }],
      // A landed page stages the next one in the background; holding it keeps
      // the post-load boundary state independent of that prefetch.
      heldRequests: [{ method: "chat.history", match: { offset: 60 } }],
      featureMethods: ["chat.metadata", "chat.startup"],
      methodResponses: {
        "chat.startup": historyPage(messages(41, 40), true, 40),
        "chat.history": {
          cases: [
            { match: { offset: 40 }, response: historyPage(messages(21, 20), true, 60) },
            { match: { offset: 60 }, response: historyPage(messages(1, 20), false) },
          ],
        },
      },
    });
    const offsets = async () =>
      (await gateway.getRequests("chat.history")).map(
        (request) => (request.params as { offset?: number } | undefined)?.offset,
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
    expect(await offsets()).toEqual([40]);

    await gateway.resolveDeferred("chat.history", undefined, { match: { offset: 40 } });
    await expect.poll(offsets).toEqual([40, 60]);
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
      ...(nextOffset === undefined ? {} : { nextOffset }),
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
                { match: { offset: 80 }, response: emptyTailPage([], 160) },
                { match: { offset: 160 }, response: emptyTailPage(olderMessages) },
              ],
            },
          },
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        const thread = page.locator(".chat-pane-cache__pane--active .chat-thread");
        await gateway.waitForRequest("chat.startup");
        await gateway.waitForRequest("chat.history");
        await expectHistoryBoundaryState(page, false);
        await expectTranscriptLayoutCommitted(thread);
        expect(await gateway.getRequests("chat.history")).toMatchObject([
          { params: { offset: 80 } },
        ]);
        await thread.hover();
        await page.mouse.wheel(0, -100);
        for (const { content } of olderMessages) {
          await page.locator(".chat-text").getByText(content, { exact: true }).waitFor();
        }
        expect(await page.locator(".agent-chat__welcome").count()).toBe(0);
        expect(await gateway.getRequests("chat.history")).toMatchObject([
          { params: { offset: 80 } },
          { params: { offset: 160 } },
        ]);
      });
    });
  }
});
