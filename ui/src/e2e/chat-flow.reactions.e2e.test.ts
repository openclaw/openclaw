import { expect, it } from "vitest";
import { createChatFlowE2eSuite, installMockGateway } from "./chat-flow.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("toggles reactions through both picker modes and receives a peer reaction live", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const sessionKey = "agent:main:main";
      const sessionId = "reaction-session";
      const messageId = "riley-prompt";
      const gateway = await installMockGateway(page, {
        sessionKey,
        presenceUsers: [
          {
            self: true,
            id: "profile-avery",
            identity: { type: "profile", id: "profile-avery" },
            name: "Avery",
          },
        ],
        sessions: [{ key: sessionKey, sessionId, visibility: "shared", sharingRole: "owner" }],
        methodResponses: {
          "session.members.listEvidence": {
            sessionKey,
            owner: { type: "human", id: "profile-avery", label: "Avery" },
            members: [],
            identities: [],
            role: "owner",
            allowedVisibilities: ["shared", "read-only", "suggest", "draft"],
          },
        },
        historyMessages: [
          {
            role: "user",
            content: [{ type: "text", text: "Let's keep the launch checklist short." }],
            __openclaw: { id: messageId, seq: 1, senderName: "Riley", senderId: "profile-riley" },
          },
        ],
        sessionReactions: {
          [sessionKey]: {
            [messageId]: [
              { emoji: "👍", count: 1, identities: [{ id: "profile-sam", label: "Sam" }] },
            ],
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      const message = page.locator(".chat-group.user", {
        hasText: "Let's keep the launch checklist short.",
      });
      const reactions = page.locator(`.chat-message-reactions[data-message-id="${messageId}"]`);
      await reactions
        .locator('.chat-reaction-chip[aria-pressed="false"][aria-label="👍 1"]')
        .waitFor();
      await message.hover();
      // The hover row and the chip row each carry a picker; the footer one first.
      const footerPicker = message.locator(
        ".chat-group-footer-actions openclaw-message-reaction-picker",
      );
      const rowPicker = reactions.locator("openclaw-message-reaction-picker");
      await footerPicker.getByRole("button", { name: "Add reaction", exact: true }).click();
      // Each picker owns its popover; an unscoped lookup can match a sibling
      // popover that is still animating closed.
      await footerPicker
        .locator(".chat-reaction-picker")
        .getByRole("button", { name: "🎉", exact: true })
        .click();
      expect((await gateway.waitForRequest("session.reactions.set")).params).toMatchObject({
        sessionKey,
        messageId,
        emoji: "🎉",
      });
      await reactions
        .locator('.chat-reaction-chip[aria-pressed="true"][aria-label="🎉 1"]')
        .waitFor();

      await message.hover();
      await rowPicker.getByRole("button", { name: "Add reaction", exact: true }).click();
      await rowPicker
        .locator(".chat-reaction-picker")
        .getByRole("button", { name: "More…", exact: true })
        .click();
      // A complete emoji applies on input, so the OS picker needs no extra keystroke.
      await rowPicker.getByRole("textbox", { name: "Emoji", exact: true }).fill("🦞");
      expect(
        (await gateway.waitForRequest("session.reactions.set", { after: 1 })).params,
      ).toMatchObject({
        messageId,
        emoji: "🦞",
      });
      const ownChip = reactions.locator(
        '.chat-reaction-chip[aria-pressed="true"][aria-label="🦞 1"]',
      );
      await ownChip.waitFor();
      await ownChip.click();
      expect(
        (await gateway.waitForRequest("session.reactions.set", { after: 2 })).params,
      ).toMatchObject({
        messageId,
        emoji: "🦞",
        remove: true,
      });
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
      await reactions
        .locator('.chat-reaction-chip[aria-pressed="false"][aria-label="👀 1"]')
        .waitFor();
      expect(await gateway.getRequests("session.reactions.list")).toHaveLength(listRequests);
    });
  });
});
