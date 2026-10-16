import type { Page } from "playwright";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Reply attribution" });
const sessionKey = "agent:main:reply-attribution";
const self = {
  senderId: "alice",
  senderName: "Alice Chen",
  senderIdentity: { type: "profile", id: "alice" },
} as const;
const peer = {
  senderId: "jordan",
  senderName: "Jordan Lee",
  senderIdentity: { type: "profile", id: "jordan" },
} as const;
function message(
  id: string,
  role: string,
  content: string,
  metadata: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
) {
  return { role, content, __openclaw: { id, ...metadata }, ...extra };
}
function sequence<T extends { __openclaw: object }>(messages: T[]) {
  return messages.map((entry, index) =>
    Object.assign(entry, {
      timestamp: 1_800_000_000_000 + index * 1000,
      __openclaw: Object.assign({}, entry["__openclaw"], { seq: index + 1 }),
    }),
  );
}
const history = sequence([
  message("agent-source", "assistant", "Review the release checklist before sharing it."),
  message("self-reply", "user", "OK", { ...self, replyToId: "agent-source" }),
  message("peer-first", "user", "The desktop controls work.", peer),
  message("peer-reply", "user", "The checklist is ready.", { ...peer, replyToId: "self-reply" }),
  message("peer-last", "user", "I checked the mobile controls too.", peer),
  message("answer-one", "assistant", "The first answer."),
  message("answer-two", "assistant", "The second answer."),
]);
const selfPresence = {
  self: true,
  id: "alice",
  identity: self.senderIdentity,
  name: self.senderName,
};
async function preparePage(
  page: Page,
  key: string,
  historyMessages: unknown[],
  theme: string,
  includePeer = false,
) {
  await installMockGateway(page, {
    sessionKey: key,
    historyMessages,
    presenceUsers: [
      selfPresence,
      ...(includePeer
        ? [{ id: "jordan", identity: peer.senderIdentity, name: peer.senderName }]
        : []),
    ],
  });
  await page.goto(controlUiSessionUrl(suite.server.baseUrl, key));
  await page.evaluate(async (value) => {
    document.documentElement.dataset.theme = value;
    document.documentElement.dataset.themeMode = value;
    await document.fonts.ready;
  }, theme);
}
const viewports = [
  { width: 1440, height: 1000, touch: false, theme: "light" },
  { width: 390, height: 1000, touch: true, theme: "dark" },
  { width: 820, height: 1180, touch: true, theme: "light" },
];

suite.define(() => {
  it("keeps the reply line above completed work across an automatic resumption", async () => {
    const resumedSession = "agent:main:dashboard:reply-strip-resumed-work";
    const messages = sequence([
      message("earlier-prompt", "user", "Please review the release checklist.", self),
      message(
        "review-prompt",
        "user",
        "Check the release notes and test results before we share it.",
        { idempotencyKey: "review-run:user", ...peer },
      ),
      message(
        "first-run-work",
        "toolResult",
        "The release notes describe the updated controls.",
        { runId: "review-run" },
        { toolName: "read", toolCallId: "read-release-notes" },
      ),
      message(
        "resumed-work",
        "toolResult",
        "The focused tests passed.",
        { runId: "announce:review-complete" },
        { toolName: "exec", toolCallId: "check-test-results" },
      ),
      message(
        "resumed-answer",
        "assistant",
        "The release checklist is ready. I checked the notes and test results; the controls are consistent across desktop and mobile.",
        { runId: "announce:review-complete" },
        { phase: "final_answer", stopReason: "stop" },
      ),
    ]);
    await suite.withPage(
      { viewport: { width: 1440, height: 900 }, locale: "en-US" },
      async ({ page }) => {
        await preparePage(page, resumedSession, messages, "dark", true);
        await page.locator('[data-entry-id="resumed-answer"]').waitFor();
        const answerGroup = page.locator(
          '.chat-group.assistant:has([data-entry-id="resumed-answer"])',
        );
        const line = answerGroup.getByRole("button", {
          name: "Replying to Jordan Lee",
          exact: true,
        });
        const work = page.locator(".chat-work-group");
        await line.waitFor();
        await work.waitFor();
        await answerGroup.locator(".chat-avatar:visible").waitFor();
        await page
          .locator('.chat-group--peer:has([data-entry-id="review-prompt"]) .chat-avatar:visible')
          .waitFor();
        const artifactRoot = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
        if (artifactRoot) {
          const artifactDir = createControlUiE2eArtifactDir(
            "reply-strip-resumed-work",
            artifactRoot,
          );
          await page.screenshot({ path: `${artifactDir}/reply-strip.png`, animations: "disabled" });
        }
        expect(await answerGroup.locator(".chat-work-group").count()).toBe(1);
        const lineBounds = await line.boundingBox();
        const workBounds = await work.boundingBox();
        expect(lineBounds).not.toBeNull();
        expect(workBounds).not.toBeNull();
        expect(lineBounds!.y + lineBounds!.height).toBeLessThanOrEqual(workBounds!.y);
        await work.getByRole("button").click();
        await answerGroup.locator(".chat-tool-msg-summary").filter({ hasText: "exec" }).click();
        await page.getByText("The focused tests passed.", { exact: true }).waitFor();
        expect(await answerGroup.locator(".chat-reply-attribution--reply").count()).toBe(1);
      },
    );
  });

  it.each(viewports)(
    "keeps participant actions owned by their message at $width px",
    async ({ width, height, touch, theme }) => {
      await suite.withPage(
        { viewport: { width, height }, locale: "en-US", hasTouch: touch },
        async ({ page }) => {
          await preparePage(page, sessionKey, history, theme);
          expect(await page.evaluate(() => matchMedia("(hover: none)").matches)).toBe(touch);
          const own = page.locator('[data-entry-id="self-reply"]');
          const first = page.locator('[data-entry-id="peer-first"]');
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
          await first.scrollIntoViewIfNeeded();
          const resting = await geometry();
          const messages = [
            ["peer-first", first, "The desktop controls work."],
            ["peer-reply", reply, "The checklist is ready."],
            ["peer-last", last, "I checked the mobile controls too."],
          ] as const;
          // Focus must reveal every native owner without a preceding hover/tap.
          for (const [id, bubble, content] of messages) {
            const action = await actionFor(id);
            const key = await bubble.getAttribute("data-message-id");
            await action.focus();
            await expect
              .poll(() => action.evaluate((button) => Number(getComputedStyle(button).opacity)))
              .toBeGreaterThan(0.5);
            await expect.poll(interactiveOwners).toEqual([key]);
            expect(await geometry()).toEqual(resting);
            // Earlier message rows align to their bubble; the final group footer
            // keeps its native metadata/action layout.
            if (!touch && id !== "peer-last") {
              const actionBounds = await action.boundingBox();
              const bubbleBounds = await bubble.boundingBox();
              expect(actionBounds).not.toBeNull();
              expect(bubbleBounds).not.toBeNull();
              expect(Math.abs(actionBounds!.x - bubbleBounds!.x)).toBeLessThanOrEqual(1);
            }
            if (touch) {
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
              .toBe(content);
            await preview.getByRole("button", { name: "Cancel reply" }).click();
            await action.evaluate((button) => button.blur());
            await page.mouse.move(0, 0);
          }
          await expect.poll(interactiveOwners).toEqual([]);
          // Transfer directly between ordinary, reply-wrapped, and final bubbles.
          // No intervening dismiss or action may reset the previous reveal.
          for (const [id, bubble] of messages) {
            const action = await actionFor(id);
            const key = await bubble.getAttribute("data-message-id");
            if (touch) {
              await bubble.locator(".chat-text").tap();
            } else {
              await bubble.hover();
            }
            await expect
              .poll(() => action.evaluate((button) => Number(getComputedStyle(button).opacity)))
              .toBeGreaterThan(0.5);
            await expect.poll(interactiveOwners).toEqual([key]);
            expect(await geometry()).toEqual(resting);
          }
          if (touch) {
            // Tapping the same final message still dismisses its controls.
            await last.locator(".chat-text").tap();
          } else {
            await page.mouse.move(0, 0);
          }
          await expect.poll(interactiveOwners).toEqual([]);
        },
      );
    },
  );
});
