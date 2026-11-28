import type { Locator } from "playwright";
import { expect, it } from "vitest";
import {
  chatMessage,
  chatThreadDistanceFromBottom,
  createChatFlowE2eSuite,
  installMockGateway,
  waitForTranscriptScrollIdle,
} from "./chat-flow.test-support.ts";
import { historyMessageCount } from "./chat-history-pagination-probe.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";

const suite = createChatFlowE2eSuite();
const historyMessages = Array.from({ length: 78 }, (_, index) => {
  const seq = index + 1;
  return chatMessage(
    seq % 2 ? "user" : "assistant",
    `Folio ${seq} · ${seq % 3 ? "meadow" : "orchard"}`,
    {
      __openclaw: { id: `folio-${seq}`, seq },
      timestamp: 1_800_000_000_000 + seq * 1000,
    },
  );
});

function firstVisibleMessage(thread: Locator) {
  return thread.evaluate((element) => {
    const viewport = element.getBoundingClientRect();
    for (const bubble of element.querySelectorAll<HTMLElement>(".chat-bubble[data-entry-id]")) {
      const rect = bubble.getBoundingClientRect();
      if (
        !bubble.closest('[data-prepared-row="true"]') &&
        rect.bottom > viewport.top &&
        rect.top < viewport.bottom
      ) {
        return { id: bubble.dataset.entryId, top: rect.top };
      }
    }
    throw new Error("No visible transcript message");
  });
}

suite.define(() => {
  it("finds a match beyond the next older page after a compact opening", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const history = (start: number, end: number) => ({
        sessionId: "find-session",
        messages: historyMessages.slice(start, end),
        totalMessages: historyMessages.length,
        hasMore: start > 0,
        ...(start > 0 ? { olderCursor: `before-${start}` } : {}),
      });
      const gateway = await installMockGateway(page, {
        sessions: [{ key: "agent:main:main", sessionId: "find-session" }],
        deferredRequests: [{ method: "chat.history", match: { cursor: "before-54" } }],
        methodResponses: {
          "chat.startup": history(54, 78),
          "chat.history": {
            cases: [
              { match: { cursor: "before-54" }, response: history(40, 54) },
              { match: { cursor: "before-40" }, response: history(24, 40) },
              { match: { cursor: "before-24" }, response: history(0, 24) },
            ],
          },
        },
      });
      await page.goto(suite.server.baseUrl + "chat");
      const pane = page.locator(".chat-pane-cache__pane--active");
      await pane.getByText("Folio 78 · orchard", { exact: true }).waitFor();
      await pane.locator(".agent-chat__composer-combobox textarea").press("ControlOrMeta+f");
      const search = pane.getByRole("textbox", { name: "Search loaded messages" });
      await search.waitFor();
      expect(await gateway.getRequests("chat.history")).toHaveLength(0);
      await search.fill("Folio 1 · meadow");
      await gateway.waitForRequest("chat.history", { match: { cursor: "before-54" } });
      await search.press("Escape");
      await gateway.resolveDeferred("chat.history");
      await expect.poll(() => historyMessageCount(pane)).toBe(38);
      await waitForTranscriptScrollIdle(pane.locator(".chat-thread"));
      expect(await gateway.getRequests("chat.history")).toHaveLength(1);
      await pane.locator(".agent-chat__composer-combobox textarea").press("ControlOrMeta+f");
      await search.fill("Folio 1 · meadow");
      await pane.locator('.chat-bubble[data-entry-id="folio-1"]').waitFor();
    });
  });

  it.each(["close", "clear after reading results", "close from latest"] as const)(
    "restores the last reading position after a search with no matches (%s)",
    async (action) => {
      await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
        await installMockGateway(page, { historyMessages });
        await page.goto(suite.server.baseUrl + "chat");
        const pane = page.locator(".chat-pane-cache__pane--active");
        const thread = pane.locator(".chat-thread");
        await thread.locator('[data-entry-id="folio-78"]').waitFor();
        const composer = pane.locator(".agent-chat__composer-combobox textarea");
        await composer.fill("Unsent field notes");
        const following = action === "close from latest";
        if (following) {
          await expect.poll(() => chatThreadDistanceFromBottom(page)).toBeLessThanOrEqual(2);
        } else {
          await thread.hover();
          await page.mouse.wheel(0, -2300);
        }
        await waitForTranscriptScrollIdle(thread);
        let mark = await firstVisibleMessage(thread);

        await composer.press("ControlOrMeta+f");
        const search = pane.getByRole("textbox", { name: "Search loaded messages" });
        if (action !== "close") {
          await search.fill("orchard");
          await waitForTranscriptScrollIdle(thread);
          expect(await thread.evaluate((el) => el.scrollTop)).toBe(0);
        }
        if (action === "clear after reading results") {
          await thread.hover();
          const delta = await thread.evaluate(
            (el) => (el.scrollHeight - el.clientHeight) / 2 - el.scrollTop,
          );
          await page.mouse.wheel(0, delta);
          await waitForTranscriptScrollIdle(thread);
          const result = await firstVisibleMessage(thread);
          expect(result.id).not.toBe(mark.id);
          mark = result;
        }
        await search.fill("absent-from-the-transcript");
        await thread.getByText("No matches in the messages loaded so far.").waitFor();
        if (action === "clear after reading results") {
          await search.fill("");
        } else {
          await pane.getByRole("button", { name: "Close search" }).click();
        }
        await thread.locator(".chat-bubble").first().waitFor();
        await waitForTranscriptScrollIdle(thread);
        if (following) {
          expect(await chatThreadDistanceFromBottom(page)).toBeLessThanOrEqual(2);
        } else {
          const restored = thread.locator(`.chat-bubble[data-entry-id="${mark.id}"]`);
          expect(await restored.count()).toBe(1);
          const top = await restored.evaluate((el) => el.getBoundingClientRect().top);
          expect(Math.abs(top - mark.top)).toBeLessThanOrEqual(2);
        }
        expect(await composer.inputValue()).toBe("Unsent field notes");
      });
    },
  );
});
