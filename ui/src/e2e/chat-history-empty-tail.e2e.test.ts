import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { expectHistoryBoundaryState } from "./chat-history-boundary.test-support.ts";
import { expectTranscriptLayoutCommitted } from "./claude-sessions.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Empty history tail" });
const sessionId = "empty-tail-session";
const sessionInfo = { key: "agent:main:main", kind: "direct" as const, sessionId };
const historyPage = (messages: unknown[], nextOffset?: number) => ({
  messages,
  hasMore: nextOffset !== undefined,
  ...(nextOffset === undefined ? {} : { nextOffset }),
  totalMessages: 200,
  sessionId,
  sessionInfo,
});
const olderMessages = [
  {
    role: "user",
    content: "Can you check the report?",
    __openclaw: { id: "earlier-user", seq: 1 },
  },
  {
    role: "assistant",
    content: "The report is ready for review.",
    __openclaw: { id: "earlier-assistant", seq: 2 },
  },
];
const hiddenActivity = Array.from({ length: 80 }, (_, index) => ({
  role: "toolResult",
  toolName: "read",
  toolCallId: `read-${index}`,
  content: [{ type: "text", text: "Synthetic tool result" }],
  __openclaw: { id: `activity-${index}`, seq: 121 + index },
}));

suite.define(() => {
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
            "chat.startup": historyPage(messages, 80),
            "chat.history": {
              cases: [
                { match: { offset: 80 }, response: historyPage([], 160) },
                { match: { offset: 160 }, response: historyPage(olderMessages) },
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
});
