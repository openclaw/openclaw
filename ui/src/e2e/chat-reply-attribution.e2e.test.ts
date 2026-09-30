import { expect, it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Reply attribution" });
const sessionKey = "agent:main:reply-attribution";
const self = {
  senderId: "alice",
  senderName: "Alice Chen",
  senderIdentity: { type: "profile", id: "alice" },
};
const peer = {
  senderId: "jordan",
  senderName: "Jordan Lee",
  senderIdentity: { type: "profile", id: "jordan" },
};
const history = [
  {
    role: "assistant",
    content: "Review the release checklist before sharing it.",
    __openclaw: { id: "agent-source" },
  },
  {
    role: "user",
    content: "OK",
    __openclaw: { id: "self-reply", ...self, replyToId: "agent-source" },
  },
  {
    role: "user",
    content: "The checklist is ready.",
    __openclaw: { id: "peer-reply", ...peer, replyToId: "self-reply" },
  },
  { role: "assistant", content: "The first answer.", __openclaw: { id: "answer-one" } },
  { role: "assistant", content: "The second answer.", __openclaw: { id: "answer-two" } },
  ...Array.from({ length: 8 }, (_, index) => ({
    role: index % 2 ? "assistant" : "user",
    content: "Conversation entry " + index,
    __openclaw: { id: "filler-" + index },
  })),
  {
    role: "assistant",
    content: "Returning to the checklist.",
    __openclaw: { id: "explicit-answer", replyToId: "peer-reply" },
  },
].map((message, index) =>
  Object.assign(message, {
    timestamp: 1_800_000_000_000 + index * 1000,
    __openclaw: Object.assign({}, message["__openclaw"], { seq: index + 1 }),
  }),
);

suite.define(() => {
  // Mobile targets and keyboard activation are owned by chat-reply-attribution.browser.
  it("navigates grouped and explicit agent replies through the pane", async () => {
    await suite.withPage(
      { viewport: { width: 1440, height: 900 }, locale: "en-US" },
      async ({ page }) => {
        await installMockGateway(page, { sessionKey, historyMessages: history });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        const thread = page.locator(".chat-thread");
        const grouped = page.locator('.chat-group:has([data-entry-id="answer-one"])');
        await grouped.waitFor();
        expect(await grouped.locator(".chat-bubble").count()).toBe(2);
        expect(await grouped.locator(".chat-reply-attribution--reply").count()).toBe(1);
        expect(await grouped.locator(".chat-reply-attribution__name").textContent()).toBe(
          "Jordan Lee",
        );
        const target = page
          .locator(
            '.chat-group:has([data-entry-id="explicit-answer"]) .chat-reply-attribution--reply',
          )
          .getByRole("button", { name: "Replying to Jordan Lee", exact: true });
        await thread.evaluate((element) => element.scrollTo({ top: element.scrollHeight }));
        await target.scrollIntoViewIfNeeded();
        const before = await thread.evaluate((element) => element.scrollTop);
        await target.click();
        await expect
          .poll(() => page.locator('[data-entry-id="peer-reply"]').getAttribute("class"))
          .toContain("chat-bubble--reply-target");
        await expect
          .poll(() => thread.evaluate((element) => element.scrollTop))
          .toBeLessThan(before);
      },
    );
  });
});
