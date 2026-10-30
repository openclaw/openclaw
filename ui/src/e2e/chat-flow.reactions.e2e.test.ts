import type { Locator } from "playwright";
import { expect, it } from "vitest";
import {
  chatMessage,
  createChatFlowE2eSuite,
  exactButton,
  installMockGateway,
} from "./chat-flow.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("paints saved reactions with cached messages and reconciles changes made while away", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const sessionKey = "agent:main:main";
      const sessionId = "cached-reaction-session";
      const messageId = "cached-prompt";
      const prompt = "This message keeps its reactions across reload.";
      const saved = [{ emoji: "👍", count: 1, identities: [{ id: "peer", label: "Peer" }] }];
      const gateway = await installMockGateway(page, {
        sessionKey,
        authMethod: "trusted-proxy",
        authMode: "trusted-proxy",
        subscriptionInitialHistory: false,
        sessions: [
          {
            key: sessionKey,
            sessionId,
            kind: "direct",
            visibility: "shared",
            sharingRole: "owner",
          },
        ],
        heldMethods: ["chat.startup", "session.reactions.list"],
        historyMessages: [chatMessage("user", prompt, { __openclaw: { id: messageId, seq: 1 } })],
        sessionReactions: { [sessionKey]: { [messageId]: saved } },
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");
      await gateway.resolveDeferred("chat.startup");
      await gateway.waitForRequest("session.reactions.list");
      await gateway.resolveDeferred("session.reactions.list");
      const message = page.locator(".chat-group.user", { hasText: prompt });
      const reactions = page.locator(`.chat-message-reactions[data-message-id="${messageId}"]`);
      await reactions.getByRole("button", { name: "👍 1", exact: true }).waitFor();
      await page.evaluate(async () => {
        const pane = document.querySelector(".chat-pane-cache__pane--active");
        await Reflect.get(pane!, "sessionSnapshotStore").flush();
      });
      await page.reload();
      await message.waitFor();
      // Both authoritative reads are held: the message and chip must share the saved paint.
      expect(await reactions.getByRole("button", { name: "👍 1", exact: true }).count()).toBe(1);
      await gateway.waitForRequest("session.reactions.list");
      await gateway.resolveDeferred("session.reactions.list", { sessionId, reactions: {} });
      await reactions.waitFor({ state: "detached" });
      await gateway.resolveDeferred("chat.startup");
      await message.waitFor();
      expect(await reactions.count()).toBe(0);
    });
  });

  it("toggles reactions through both picker modes and receives a peer reaction live", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const sessionKey = "agent:main:main";
      const sessionId = "reaction-session";
      const messageId = "riley-prompt";
      const prompt = "Keep the launch checklist short.";
      const identity = { type: "profile", id: "profile-avery" } as const;
      const gateway = await installMockGateway(page, {
        sessionKey,
        presenceUsers: [{ self: true, id: identity.id, identity, name: "Avery" }],
        sessions: [{ key: sessionKey, sessionId, visibility: "shared", sharingRole: "owner" }],
        historyMessages: [
          chatMessage("user", prompt, {
            __openclaw: { id: messageId, seq: 1, senderName: "Riley", senderId: "profile-riley" },
          }),
        ],
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      const message = page.locator(".chat-group.user", { hasText: prompt });
      const reactions = page.locator(`.chat-message-reactions[data-message-id="${messageId}"]`);
      const chip = (emoji: string, pressed: boolean) =>
        reactions.locator(
          `.chat-reaction-chip[aria-pressed="${pressed}"][aria-label="${emoji} 1"]`,
        );
      await message.hover();
      // Without reactions the hover row carries the picker; once reacted, the chip row owns it.
      const footerPicker = message.locator(
        ".chat-group-footer-actions openclaw-message-reaction-picker",
      );
      const rowPicker = reactions.locator("openclaw-message-reaction-picker");
      // Each picker owns its popover; an unscoped lookup can match a sibling
      // popover that is still animating closed.
      const pick = async (picker: Locator, name: string) => {
        await exactButton(picker, "Add reaction").click();
        await exactButton(picker.locator(".chat-reaction-picker"), name).click();
      };
      const expectSet = async (after: number, fields: Record<string, unknown>) =>
        expect(
          (await gateway.waitForRequest("session.reactions.set", { after })).params,
        ).toMatchObject({ messageId, ...fields });
      await pick(footerPicker, "🎉");
      await expectSet(0, { sessionKey, emoji: "🎉" });
      await chip("🎉", true).waitFor();
      await footerPicker.waitFor({ state: "detached" });

      await message.hover();
      await pick(rowPicker, "More…");
      // A complete emoji applies on input, so the OS picker needs no extra keystroke.
      await rowPicker.getByRole("searchbox", { name: "Search emoji…", exact: true }).fill("🦞");
      await expectSet(1, { emoji: "🦞" });
      const ownChip = chip("🦞", true);
      await ownChip.click();
      await expectSet(2, { emoji: "🦞", remove: true });
      await ownChip.waitFor({ state: "detached" });

      const listRequests = (await gateway.getRequests("session.reactions.list")).length;
      await gateway.emitGatewayEvent("session.reaction", {
        sessionKey,
        sessionId,
        agentId: "main",
        messageId,
        emoji: "👀",
        action: "added",
        actor: { type: "human", id: "profile-riley", label: "Riley" },
        reactions: [
          { emoji: "👍", count: 1, identities: [{ id: "profile-sam", label: "Sam" }] },
          { emoji: "🎉", count: 1, identities: [{ id: "profile-avery", label: "Avery" }] },
          { emoji: "👀", count: 1, identities: [{ id: "profile-riley", label: "Riley" }] },
        ],
      });
      await chip("👀", false).waitFor();
      expect(await gateway.getRequests("session.reactions.list")).toHaveLength(listRequests);
    });
  });
});
