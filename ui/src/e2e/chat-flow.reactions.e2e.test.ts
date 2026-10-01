import type { Locator } from "playwright";
import { expect, it } from "vitest";
import {
  createChatFlowE2eSuite,
  installMockGateway,
  pauseVirtualClock,
} from "./chat-flow.test-support.ts";
import {
  finalMessageId,
  ownMessageId,
  peerMessageId,
  peerReactions,
  people,
  reactionScenario,
  reactionSessionId,
  reactionSessionKey,
} from "./chat-reactions.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";

const suite = createChatFlowE2eSuite();

function reactionRow(page: Parameters<typeof installMockGateway>[0], messageId: string) {
  return page.locator(`openclaw-chat-message-reactions[data-message-id="${messageId}"]`);
}

async function expectActionRow(row: Locator) {
  await row.scrollIntoViewIfNeeded();
  const geometry = await row.evaluate((element) => {
    const actions = [
      ...element.querySelectorAll<HTMLElement>(
        ".chat-copy-btn, .chat-group-rewind, .chat-reply-btn, .chat-reaction-add",
      ),
    ];
    return actions.map((button) => {
      const box = button.getBoundingClientRect();
      return {
        label: button.getAttribute("aria-label"),
        left: box.left,
        right: box.right,
        centerY: box.top + box.height / 2,
      };
    });
  });
  expect(geometry[0]?.label).toBe("Copy as markdown");
  expect(geometry.slice(-2).map(({ label }) => label)).toEqual([
    "Reply to message",
    "Add reaction",
  ]);
  for (let index = 1; index < geometry.length; index += 1) {
    expect(geometry[index]!.left).toBeGreaterThanOrEqual(geometry[index - 1]!.right - 1);
    expect(Math.abs(geometry[index]!.centerY - geometry[0]!.centerY)).toBeLessThanOrEqual(1);
  }
}

async function expectOwnReaction(row: Locator, emoji: string) {
  // Saved reaction state arrives before width measurement can move its chip into +N.
  await row.page().waitForFunction(
    ({ messageId, emoji: targetEmoji }) => {
      const element = [
        ...document.querySelectorAll<
          import("../pages/chat/components/chat-message-reactions.ts").ChatMessageReactions
        >("openclaw-chat-message-reactions"),
      ].find((candidate) => candidate.messageId === messageId);
      return element?.reactions.some(
        (reaction) =>
          reaction.emoji === targetEmoji &&
          reaction.identities.some((identity) => identity.id === element.userId),
      );
    },
    { messageId: await row.getAttribute("data-message-id"), emoji },
  );
  await row.evaluate(async (element) => {
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    await (
      element as import("../pages/chat/components/chat-message-reactions.ts").ChatMessageReactions
    ).updateComplete;
  });
  const more = row.locator("button.chat-reaction-more");
  if ((await more.isVisible()) && (await more.getAttribute("aria-expanded")) !== "true") {
    await more.click();
  }
  await row
    .locator('.chat-reaction-toggle[data-emoji="' + emoji + '"][aria-pressed="true"]')
    .first()
    .waitFor();
}

async function expectUpstreamTraffic(gateway: Awaited<ReturnType<typeof installMockGateway>>) {
  const requests = await gateway.getRequests();
  expect(requests.some(({ method }) => method.startsWith("chat.reactions."))).toBe(false);
  expect(
    requests
      .filter(({ method }) => method.includes("reaction"))
      .every(
        ({ method }) => method === "session.reactions.list" || method === "session.reactions.set",
      ),
  ).toBe(true);
  expect(
    requests.some(
      ({ method }) => method === "tools.invoke" || method === "agent" || method === "chat.send",
    ),
  ).toBe(false);
  for (const { params } of await gateway.getRequests("session.reactions.list")) {
    expect(params).toEqual({ sessionKey: reactionSessionKey });
  }
}

suite.define(() => {
  it("adds, removes, and receives human reactions through the existing session API", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const gateway = await installMockGateway(page, reactionScenario());
      await page.goto(`${suite.server.baseUrl}chat`);
      const peer = reactionRow(page, peerMessageId);
      const own = reactionRow(page, ownMessageId);
      const final = reactionRow(page, finalMessageId);
      const thumb = peer.locator('.chat-reaction-strip [data-emoji="👍"]');
      await thumb.waitFor();
      await own.locator('[data-emoji="👀"][aria-pressed="true"]').waitFor();
      expect(await own.locator(".chat-reaction-count").count()).toBe(0);
      await final.locator('[data-emoji="✅"]').waitFor();
      expect(await reactionRow(page, "assistant-intermediate").count()).toBe(0);
      await expectActionRow(peer);
      await expectActionRow(own);
      await expectActionRow(final);
      for (const row of [peer, own]) {
        const layout = await row.evaluate((element) => {
          const bubble = element.closest(".chat-group")!.querySelector(".chat-bubble")!;
          return {
            insideBubble: bubble.contains(element),
            rowTop: element.getBoundingClientRect().top,
            bubbleBottom: bubble.getBoundingClientRect().bottom,
          };
        });
        expect(layout.insideBubble).toBe(false);
        expect(layout.rowTop).toBeGreaterThanOrEqual(layout.bubbleBottom - 1);
      }

      // Picker choices and searched choices use the same remove:boolean contract.
      const add = peer.getByRole("button", { name: "Add reaction", exact: true });
      await add.focus();
      await page.keyboard.press("Enter");
      const picker = peer.getByRole("dialog", { name: "Add reaction", exact: true });
      await picker.waitFor();
      expect(
        await picker
          .getByRole("button", { name: "thumbsup", exact: true })
          .evaluate((button) => document.activeElement === button),
      ).toBe(true);
      await page.keyboard.press("Escape");
      await picker.waitFor({ state: "hidden" });
      expect(await add.evaluate((button) => document.activeElement === button)).toBe(true);
      await add.click();
      await picker.getByRole("button", { name: "tada", exact: true }).click();
      expect((await gateway.waitForRequest("session.reactions.set")).params).toEqual({
        sessionKey: reactionSessionKey,
        messageId: peerMessageId,
        emoji: "🎉",
        remove: false,
      });
      await expectOwnReaction(peer, "🎉");
      await peer.locator(".chat-reaction-collapse").click();
      await peer.locator(".chat-reaction-overflow").waitFor({ state: "hidden" });
      await add.click();
      await picker.getByRole("searchbox", { name: "Search emoji" }).fill("lobster");
      await picker.getByRole("button", { name: "lobster", exact: true }).click();
      expect(
        (await gateway.waitForRequest("session.reactions.set", { after: 1 })).params,
      ).toMatchObject({ messageId: peerMessageId, emoji: "🦞", remove: false });
      await own.locator('[data-emoji="👀"]').click();
      expect(
        (await gateway.waitForRequest("session.reactions.set", { after: 2 })).params,
      ).toMatchObject({ messageId: ownMessageId, emoji: "👀", remove: true });
      await own.locator('[data-emoji="👀"]').waitFor({ state: "detached" });

      const reads = (await gateway.getRequests("session.reactions.list")).length;
      await gateway.emitGatewayEvent("session.reaction", {
        sessionKey: reactionSessionKey,
        sessionId: reactionSessionId,
        agentId: "main",
        messageId: peerMessageId,
        emoji: "👍",
        action: "added",
        actor: { type: "human", id: "profile-riley", label: "Riley" },
        reactions: [
          {
            emoji: "👍",
            count: people.length + 1,
            identities: [...people, { id: "profile-riley", label: "Riley" }],
          },
          ...peerReactions().slice(1),
        ],
      });
      await thumb.locator(".chat-reaction-count").filter({ hasText: "25" }).waitFor();
      expect(await gateway.getRequests("session.reactions.list")).toHaveLength(reads);
      expect(await thumb.getAttribute("aria-pressed")).toBe("false");

      // Delayed names use a virtual clock, never a sleep; details read the full
      // summary locally instead of a second people RPC or a server cursor.
      await page.mouse.move(0, 0);
      await page.clock.install();
      await pauseVirtualClock(page);
      await thumb.hover();
      const names = peer.getByRole("button", { name: "Who reacted with 👍", exact: true });
      await page.clock.runFor(399);
      expect(await names.isVisible()).toBe(false);
      await page.clock.runFor(51);
      await names.waitFor();
      await page.clock.resume();
      const writes = (await gateway.getRequests("session.reactions.set")).length;
      await names.click();
      const details = peer.locator(".chat-reaction-dialog");
      await details.waitFor();
      expect(await details.locator(".chat-reaction-people li").count()).toBe(25);
      await details.getByText("Person 24", { exact: true }).scrollIntoViewIfNeeded();
      await details.getByText("Riley", { exact: true }).waitFor();
      expect(await details.getByRole("button", { name: "Load more", exact: true }).count()).toBe(0);
      expect(await gateway.getRequests("session.reactions.set")).toHaveLength(writes);
      await page.keyboard.press("Escape");
      await details.waitFor({ state: "hidden" });
      expect(await thumb.evaluate((button) => document.activeElement === button)).toBe(true);

      const more = peer.locator("button.chat-reaction-more");
      await more.waitFor();
      const before = await peer.locator(".chat-reaction-actions").boundingBox();
      await more.click();
      const overflow = peer.locator(".chat-reaction-overflow");
      await overflow.waitFor();
      expect(await overflow.locator(".chat-reaction-toggle").count()).toBe(10);
      const after = await peer.locator(".chat-reaction-actions").boundingBox();
      expect(after?.x).toBe(before?.x);
      expect(after?.y).toBe(before?.y);
      await overflow.getByRole("button", { name: "Collapse", exact: true }).click();
      await overflow.waitFor({ state: "hidden" });
      expect(await more.evaluate((button) => document.activeElement === button)).toBe(true);
      await expectUpstreamTraffic(gateway);
    });
  });

  it("keeps short user footers and searchable picker usable on a narrow coarse-pointer screen", async () => {
    await suite.withPage(
      {
        ...createControlUiE2eContextOptions(),
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, reactionScenario());
        await page.goto(`${suite.server.baseUrl}chat`);
        const own = reactionRow(page, ownMessageId);
        const peer = reactionRow(page, peerMessageId);
        await own.locator('[data-emoji="👀"][aria-pressed="true"]').waitFor();
        await expectActionRow(own);
        await expectActionRow(peer);
        expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
        const add = own.getByRole("button", { name: "Add reaction", exact: true });
        await add.tap();
        const picker = own.getByRole("dialog", { name: "Add reaction", exact: true });
        await picker.waitFor();
        const bounds = await picker.boundingBox();
        expect(bounds!.x).toBeGreaterThanOrEqual(8);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(382);
        expect(
          await picker.locator("input").evaluate((input) => document.activeElement === input),
        ).toBe(false);
        await picker.getByRole("searchbox", { name: "Search emoji" }).fill("rocket");
        await picker.getByRole("button", { name: "rocket", exact: true }).tap();
        expect((await gateway.waitForRequest("session.reactions.set")).params).toMatchObject({
          messageId: ownMessageId,
          emoji: "🚀",
          remove: false,
        });
        await expectOwnReaction(own, "🚀");
        if (await own.locator(".chat-reaction-overflow").isVisible()) {
          await own.getByRole("button", { name: "Collapse", exact: true }).tap();
        }
        expect(await own.locator(".chat-reaction-count").count()).toBe(0);
        const peerOverflow = peer.locator("button.chat-reaction-more");
        if (await peerOverflow.isVisible()) {
          await peerOverflow.tap();
        }
        const thumb = peer.locator('.chat-reaction-toggle[data-emoji="👍"]').last();
        await thumb.tap();
        const names = peer.getByRole("button", { name: "Who reacted with 👍", exact: true });
        await names.waitFor();
        await names.tap();
        await peer.locator(".chat-reaction-dialog").waitFor();
        expect(await peer.locator(".chat-reaction-people li").count()).toBe(people.length);
        expect(await gateway.getRequests("session.reactions.set")).toHaveLength(1);
        await page.getByRole("button", { name: "Close", exact: true }).tap();
        await expectUpstreamTraffic(gateway);
      },
    );
  });
});
