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
  {
    role: "user",
    content: "I checked the mobile controls too.",
    __openclaw: { id: "peer-last", ...peer },
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
const viewports = [
  { width: 1440, theme: "light" },
  { width: 390, theme: "dark" },
];

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

  it.each(viewports)(
    "keeps participant actions owned by their message at $width px",
    async ({ width, theme }) => {
      const mobile = width < 768;
      await suite.withPage(
        { viewport: { width, height: 1000 }, locale: "en-US", hasTouch: mobile },
        async ({ page }) => {
          await installMockGateway(page, {
            sessionKey,
            historyMessages: history.slice(0, 6),
            presenceUsers: [
              {
                self: true,
                id: "alice",
                identity: { type: "profile", id: "alice" },
                name: "Alice Chen",
              },
            ],
          });
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
          await page.evaluate(async (value) => {
            document.documentElement.dataset.theme = value;
            document.documentElement.dataset.themeMode = value;
            await document.fonts.ready;
          }, theme);
          const own = page.locator('[data-entry-id="self-reply"]');
          const reply = page.locator('[data-entry-id="peer-reply"]');
          const last = page.locator('[data-entry-id="peer-last"]');
          await reply.waitFor();
          expect(await own.locator(":scope > .chat-reply-attribution--inline").count()).toBe(1);
          expect(await reply.locator(".chat-reply-attribution").count()).toBe(0);
          expect(
            await reply
              .locator("..")
              .getByRole("button", { name: "Replying to You", exact: true })
              .count(),
          ).toBe(1);
          const group = page.locator('.chat-group--peer:has([data-entry-id="peer-reply"])');
          const actionFor = async (id: string) => {
            const key = await page
              .locator('[data-entry-id="' + id + '"]')
              .getAttribute("data-message-id");
            const owner = group.locator('[data-message-actions-for="' + key + '"]');
            expect(await owner.count()).toBe(1);
            return owner.getByRole("button", { name: "Reply to message", exact: true });
          };
          const geometry = () =>
            group.evaluate((element) => {
              const thread = element.closest(".chat-thread")!;
              return [...element.querySelectorAll(".chat-bubble")].map((bubble) => {
                const bounds = bubble.getBoundingClientRect();
                return {
                  top: bounds.top + thread.scrollTop,
                  height: bounds.height,
                  width: bounds.width,
                };
              });
            });
          const interactiveOwners = () =>
            group
              .locator("[data-message-actions-for]")
              .evaluateAll((owners) =>
                owners
                  .filter((owner) =>
                    [...owner.querySelectorAll("button")].some(
                      (button) => getComputedStyle(button).pointerEvents !== "none",
                    ),
                  )
                  .map((owner) => owner.getAttribute("data-message-actions-for")),
              );
          await reply.scrollIntoViewIfNeeded();
          const resting = await geometry();
          for (const [id, bubble] of [
            ["peer-reply", reply],
            ["peer-last", last],
          ] as const) {
            const action = await actionFor(id);
            const key = await bubble.getAttribute("data-message-id");
            if (mobile) {
              await bubble.locator(".chat-text").tap();
            } else {
              await bubble.hover();
            }
            await expect
              .poll(() => action.evaluate((button) => Number(getComputedStyle(button).opacity)))
              .toBeGreaterThan(0.5);
            await expect.poll(interactiveOwners).toEqual([key]);
            expect(await geometry()).toEqual(resting);
            // Earlier message rows align to their bubble; the final group footer
            // keeps its native metadata/action layout.
            if (!mobile && id === "peer-reply") {
              const actionBounds = await action.boundingBox();
              const bubbleBounds = await bubble.boundingBox();
              expect(actionBounds).not.toBeNull();
              expect(bubbleBounds).not.toBeNull();
              expect(Math.abs(actionBounds!.x - bubbleBounds!.x)).toBeLessThanOrEqual(1);
            }
            await action.focus();
            await expect.poll(interactiveOwners).toEqual([key]);
            expect(await geometry()).toEqual(resting);
            if (mobile) {
              expect(
                await action.evaluate((button) => {
                  const bounds = button.getBoundingClientRect();
                  // The 44px tap area grows up from the button's bottom edge.
                  return [1, 43].map((offset) =>
                    button.contains(
                      document.elementFromPoint(
                        bounds.left + bounds.width / 2,
                        bounds.bottom - offset,
                      ),
                    ),
                  );
                }),
              ).toEqual([true, true]);
            }
            await action.press("Enter");
            const preview = page
              .locator(".chat-reply-preview")
              .filter({ has: page.getByRole("button", { name: "Cancel reply" }) });
            await expect
              .poll(() => preview.locator(".chat-reply-preview__text").textContent())
              .toBe(
                id === "peer-reply"
                  ? "The checklist is ready."
                  : "I checked the mobile controls too.",
              );
            await preview.getByRole("button", { name: "Cancel reply" }).click();
            await action.evaluate((button) => button.blur());
            if (mobile) {
              await bubble.locator(".chat-text").tap();
            }
            await page.mouse.move(0, 0);
          }
        },
      );
    },
  );
});
