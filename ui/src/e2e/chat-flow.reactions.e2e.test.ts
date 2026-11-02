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
  it.each([560, 1024])("keeps earlier own actions reachable by touch at %ipx", async (width) => {
    await suite.withPage(
      {
        ...createControlUiE2eContextOptions(),
        viewport: { width, height: 900 },
        hasTouch: true,
        isMobile: true,
      },
      async ({ page }) => {
        await installMockGateway(page, {
          sessionKey: "agent:main:main",
          historyMessages: ["First note.", "Second note."].map((text, index) =>
            chatMessage("user", text, { __openclaw: { id: "touch-" + index, seq: index + 1 } }),
          ),
        });
        await page.goto(suite.server.baseUrl + "chat");
        await page.locator(".chat-bubble").filter({ hasText: "First note." }).tap();
        const earlier = page.locator('[data-message-actions-for="msg:id:touch-0:0"]');
        await earlier.getByRole("button", { name: "Reply to message", exact: true }).click();
        await expect
          .poll(() => page.locator(".chat-reply-preview__text").textContent())
          .toBe("First note.");
      },
    );
  });

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

  it("keeps message actions scoped while toggling reactions and receiving a peer reaction", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const sessionKey = "agent:main:main";
      const sessionId = "reaction-session";
      const messageId = "riley-prompt";
      const prompt = "Keep the launch checklist short.";
      const identity = { type: "profile", id: "profile-avery" } as const;
      const gateway = await installMockGateway(page, {
        sessionKey,
        authMethod: "trusted-proxy",
        authMode: "trusted-proxy",
        presenceUsers: [{ self: true, id: identity.id, identity, name: "Avery" }],
        sessions: [{ key: sessionKey, sessionId, visibility: "shared", sharingRole: "owner" }],
        historyMessages: [
          ...["First own note.", "Second own note.", "Last own note."].map((text, index) =>
            chatMessage("user", text, {
              timestamp: 1700000000000 + index * 60_000,
              __openclaw: {
                id: `own-note-${index}`,
                seq: index + 1,
                senderName: "Avery",
                senderId: identity.id,
                senderIdentity: identity,
              },
            }),
          ),
          ...["First checklist note.", prompt, "Last checklist note."].map((text, index) =>
            chatMessage("user", text, {
              timestamp: 1700000300000 + index * 60_000,
              __openclaw: {
                id: index === 1 ? messageId : `riley-note-${index}`,
                seq: index + 4,
                senderName: "Riley",
                senderId: "profile-riley",
                senderIdentity: { type: "profile", id: "profile-riley" },
              },
            }),
          ),
        ],
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      const message = page.locator(".chat-group.user", { hasText: prompt });
      const reactions = page.locator(`.chat-message-reactions[data-message-id="${messageId}"]`);
      const chip = (emoji: string, pressed: boolean) =>
        reactions.locator(
          `.chat-reaction-chip[aria-pressed="${pressed}"][aria-label="${emoji} 1"]`,
        );
      await message.locator(".chat-bubble").filter({ hasText: prompt }).hover();
      const visibleMetadata = (group: Locator = message) =>
        group.evaluate((element) => ({
          actions: [...element.querySelectorAll("[data-message-actions-for]")]
            .filter((row) =>
              [...row.querySelectorAll("button")].some((button) =>
                button.checkVisibility({ checkOpacity: true }),
              ),
            )
            .map((row) => row.getAttribute("data-message-actions-for")),
          times: [...element.querySelectorAll("time")]
            .filter((time) => time.checkVisibility({ checkOpacity: true }))
            .map((time) => time.getAttribute("datetime")),
        }));
      const middleMetadata = {
        actions: [`msg:id:${messageId}:0`],
        times: [new Date(1700000360000).toISOString()],
      };
      await expect.poll(() => visibleMetadata()).toEqual(middleMetadata);

      const ownedActions = message.locator(`[data-message-actions-for="msg:id:${messageId}:0"]`);
      await ownedActions.getByRole("button", { name: "Copy as markdown", exact: true }).focus();
      await page.mouse.move(0, 0);
      await expect.poll(() => visibleMetadata()).toEqual(middleMetadata);
      await message.locator(".chat-bubble").filter({ hasText: "Last checklist note." }).hover();
      await page.locator("textarea").first().focus();
      await expect
        .poll(() => visibleMetadata())
        .toEqual({
          actions: ["msg:id:riley-note-2:0"],
          times: [new Date(1700000420000).toISOString()],
        });

      const desktopViewport = page.viewportSize()!;
      await page.setViewportSize({ width: 560, height: 1000 });
      await page.mouse.move(0, 0);
      await expect
        .poll(() =>
          message.locator(".chat-sender-name.person-activity-link").evaluateAll((names) =>
            names.map((name) => {
              const box = name.getBoundingClientRect();
              return name.contains(
                document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2),
              );
            }),
          ),
        )
        .toEqual([false, false, true]);
      const ownGroup = page.locator(".chat-group.user", { hasText: "First own note." });
      await ownGroup.locator(".chat-bubble").filter({ hasText: "First own note." }).hover();
      await expect
        .poll(async () => (await visibleMetadata(ownGroup)).actions)
        .toEqual(["msg:id:own-note-0:0"]);
      await ownGroup
        .locator('[data-message-actions-for="msg:id:own-note-0:0"]')
        .getByRole("button", { name: "Copy as markdown", exact: true })
        .focus();
      await page.mouse.move(0, 0);
      await expect
        .poll(async () => (await visibleMetadata(ownGroup)).actions)
        .toEqual(["msg:id:own-note-0:0"]);
      await page.setViewportSize(desktopViewport);
      await message.locator(".chat-bubble").filter({ hasText: prompt }).hover();
      // Without reactions the hover row carries the picker; once reacted, the chip row owns it.
      const footerPicker = ownedActions.locator(".chat-reaction-action");
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

      await message.locator(".chat-bubble").filter({ hasText: prompt }).hover();
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

      await page.getByRole("textbox", { name: "Chat composer" }).focus();
      await ownGroup.locator(".chat-bubble").filter({ hasText: "Last own note." }).hover();
      const finalReply = ownGroup.locator(":scope > .chat-group-footer .chat-reply-btn");
      const replyBounds = await finalReply.boundingBox();
      await finalReply.hover();
      expect(await finalReply.boundingBox()).toEqual(replyBounds);
      await finalReply.click();
      const replyPreview = page.locator(".chat-reply-preview");
      await expect
        .poll(() => replyPreview.locator(".chat-reply-preview__text").textContent())
        .toBe("Last own note.");
      await replyPreview.getByRole("button", { name: "Cancel reply" }).click();
      await page.getByRole("textbox", { name: "Chat composer" }).focus();
      await page.mouse.move(0, 0);
      await message.getByRole("link", { name: "Riley", exact: true }).click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/activity/profile-riley");
    });
  });
});
