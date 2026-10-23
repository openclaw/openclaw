import { expect, it } from "vitest";
import type { SessionSnapshotStore } from "../pages/chat/session-snapshot-store.ts";
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
  it.each(["cold", "warm"])(
    "fills once on %s reload, then pages to the beginning on upward input",
    async (temperature) => {
      const page = await newChatPage(suite);
      const historyMessage = (seq: number, role: "assistant" | "user", text: string) => ({
        __openclaw: { seq },
        content: [{ type: role === "assistant" ? "output_text" : "input_text", text }],
        role,
        timestamp: 1_800_000_000_000 + seq,
      });
      const recent = [
        historyMessage(21, "user", "Recent question"),
        historyMessage(22, "assistant", "Recent answer"),
      ];
      // Consecutive assistant records collapse into one rendered group, so this
      // page advances the raw offset without filling the real transcript viewport.
      const firstOlderPage = Array.from({ length: 4 }, (_, index) =>
        historyMessage(index + 17, "assistant", `Short older answer ${index + 17}`),
      );
      const secondOlderPage = Array.from({ length: 16 }, (_, index) => {
        const seq = index + 1;
        const role = seq % 2 === 0 ? "assistant" : "user";
        return historyMessage(
          seq,
          role,
          `Scrollable older ${role} message ${seq}\n${"Transcript detail line\n".repeat(3)}`,
        );
      });
      const gateway = await installMockGateway(page, {
        deferredMethods: ["chat.history"],
        featureMethods: ["chat.metadata", "chat.startup"],
        methodResponses: {
          "chat.startup": historyPage(recent, true, 2),
          "chat.history": {
            cases: [
              { match: { offset: 2 }, response: historyPage(firstOlderPage, true, 6) },
              { match: { offset: 6 }, response: historyPage(secondOlderPage, false) },
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
      const thread = pane.locator(".chat-thread");
      await page.getByText("Recent answer", { exact: true }).waitFor();
      if (temperature === "warm") {
        await gateway.waitForRequest("chat.history");
        // Persist only the startup tail; accepting the first page would warm a deeper cursor.
        await pane.evaluate(async (element) => {
          const snapshotPane = element as HTMLElement & {
            sessionSnapshotStore?: SessionSnapshotStore;
          };
          if (!snapshotPane.sessionSnapshotStore) {
            throw new Error("Missing transcript snapshot owner");
          }
          await snapshotPane.sessionSnapshotStore.flush();
        });
        await page.reload();
        await page.getByText("Recent answer", { exact: true }).waitFor();
      }
      await expectTranscriptLayoutCommitted(thread);
      await expect.poll(offsets).toEqual([2]);
      await expectHistoryBoundaryState(pane, true);
      const underfilled = () =>
        thread.evaluate((element) => element.scrollHeight <= element.clientHeight);
      expect(await underfilled()).toBe(true);

      await gateway.deferNext("chat.history", { offset: 6 });
      await gateway.resolveDeferred("chat.history");
      await expectHistoryBoundaryState(pane, false);
      await expectTranscriptLayoutCommitted(thread);
      expect((await gateway.getRequests("chat.history")).length).toBe(1);
      expect(await underfilled()).toBe(true);

      await thread.hover();
      await page.mouse.wheel(0, -100);
      await expect.poll(offsets).toEqual([2, 6]);
      await expectHistoryBoundaryState(pane, true);
      expect(await underfilled()).toBe(true);

      await gateway.resolveDeferred("chat.history");
      await expect
        .poll(() => thread.evaluate((element) => element.scrollHeight > element.clientHeight))
        .toBe(true);
      await expect
        .poll(() => pane.locator('.chat-history-boundary__action[aria-busy="true"]').count())
        .toBe(0);
      await pane.locator(".chat-history-sentinel").waitFor({ state: "detached" });
      // Exhausting history also stops reader prefetch.
      await expect
        .poll(() => gateway.getRequests("chat.history").then((requests) => requests.length))
        .toBe(2);
      expect(await offsets()).toEqual([2, 6]);
      for (const request of await gateway.getRequests("chat.history")) {
        expect(request.params).toMatchObject({ limit: 1000, maxBytes: 3 * 1024 * 1024 });
      }
    },
  );

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

    it.each([
      { name: "empty projection", messages: [], height: 720 },
      {
        name: "short visible tail",
        messages: [
          { role: "assistant", content: "Latest update", __openclaw: { id: "latest", seq: 200 } },
        ],
        height: 720,
      },
      { name: "hidden activity in a short viewport", messages: hiddenActivity, height: 480 },
    ])(
      "requires upward input after one empty automatic page through a $name",
      async ({ messages, height }) => {
        await suite.withPage({ viewport: { width: 1280, height } }, async ({ page }) => {
          const gateway = await installMockGateway(page, {
            sessions: [sessionInfo],
            methodResponses: {
              "config.get": { config: { ui: { prefs: { chatShowToolCalls: false } } } },
              "chat.startup": emptyTailPage(messages, 80),
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
      },
    );

    it("still welcomes a genuinely empty conversation without requesting older history", async () => {
      await suite.withPage({ viewport: { width: 1280, height: 720 } }, async ({ page }) => {
        const gateway = await installMockGateway(page, {
          sessions: [sessionInfo],
          historyMessages: [],
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        await page.locator(".agent-chat__welcome").waitFor();
        expect(await gateway.getRequests("chat.history")).toEqual([]);
      });
    });
  }
});
