import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import type { UsersListResult } from "../../../packages/gateway-protocol/src/schema/users.js";
import { createDeferredCore } from "../../../src/shared/deferred.js";
import { createControlUiMockSameOriginGatewayScript } from "../test-helpers/control-ui-e2e.ts";
import {
  captureUiProof,
  chatSessionListResponse,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
const label = "@Former Name";
const text = label + " cc " + label;
const historyMessages = [
  {
    role: "user",
    content: text,
    timestamp: 1,
    __openclaw: {
      id: "mention-message",
      humanMentions: [{ profileId: "profile-old", start: 0, end: label.length }],
    },
  },
];
const profile = {
  avatarMime: null,
  createdAt: 1,
  updatedAt: 2,
  emails: [],
  githubIdentity: null,
  hasAvatar: false,
  mergedInto: null,
};
const directory: UsersListResult = {
  profiles: [
    { ...profile, id: "same-name-not-selected", displayName: "Former Name" },
    { ...profile, id: "profile-old", displayName: "Former Name", mergedInto: "profile-ada" },
    { ...profile, id: "profile-ada", displayName: "Ada Lovelace", hasAvatar: true },
  ],
};

suite.define(() => {
  it.each([
    { width: 1280, colorScheme: "light" as const, scale: 1, font: "var(--font-body)" },
    { width: 390, colorScheme: "dark" as const, scale: 1.5, font: "Georgia, serif" },
  ])("keeps mention avatars aligned across image outcomes at $width px", async (viewport) => {
    await suite.withPage(
      { viewport: { width: viewport.width, height: 900 }, colorScheme: viewport.colorScheme },
      async ({ page }) => {
        const response = createDeferredCore();
        await page.addInitScript({ content: createControlUiMockSameOriginGatewayScript() });
        await page.route("**/api/users/**/avatar*", async (route) => {
          await response.promise;
          await route.fulfill(
            route.request().url().includes("profile-photo")
              ? { contentType: "image/png", body: readFileSync("ui/public/apple-touch-icon.png") }
              : { status: 404 },
          );
        });
        await installMockGateway(page, {
          historyMessages: [
            {
              ...historyMessages[0],
              __openclaw: {
                id: "mention-image-outcomes",
                humanMentions: [
                  { profileId: "profile-photo", start: 0, end: label.length },
                  { profileId: "profile-missing", start: label.length + 4, end: text.length },
                ],
              },
            },
          ],
        });
        try {
          await page.goto(suite.server.baseUrl + "chat");
          const references = page.locator(".markdown-person-reference");
          await expect.poll(() => references.count()).toBe(2);
          await page.evaluate(async ({ scale, font }) => {
            document.documentElement.style.setProperty("--control-ui-text-scale", String(scale));
            document.documentElement.style.setProperty("--font-chat", font);
            await document.fonts.ready;
          }, viewport);
          const geometry = () =>
            references.evaluateAll((elements) =>
              elements.map((element) => {
                const avatar = element.querySelector(".markdown-person-reference__avatar")!;
                const name = [...element.childNodes].find(
                  (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim(),
                )!;
                const range = document.createRange();
                range.selectNodeContents(name);
                const textBox = range.getClientRects()[0];
                if (!textBox) {
                  throw new Error("Expected a rendered mention label");
                }
                const box = avatar.getBoundingClientRect();
                return {
                  offset: box.top + box.height / 2 - (textBox.top + textBox.height / 2),
                  width: box.width,
                  height: box.height,
                };
              }),
            );
          await expect
            .poll(() => references.locator('[data-avatar-state="pending"]').count())
            .toBe(2);
          const pending = await geometry();
          response.resolve();
          await references.locator('[data-avatar-state="loaded"]').waitFor();
          await references.locator('[data-avatar-state="failed"]').waitFor();
          // Images and generated initials must not change the inline box's alignment.
          expect(await geometry()).toEqual(pending);
          for (const { offset } of pending) {
            // Stable image outcomes alone can all be equally misaligned with the name.
            expect(Math.abs(offset)).toBeLessThanOrEqual(1);
          }
          expect(await references.allTextContents()).toEqual([label, label]);
        } finally {
          response.resolve();
        }
      },
    );
  });

  it("shares live person details and visible sessions with the sidebar", async () => {
    await suite.withPage(
      { viewport: { width: 1280, height: 900 }, colorScheme: "light" },
      async ({ page }) => {
        const now = Date.now();
        await page.clock.setFixedTime(now);
        const watched = "agent:main:person-watching";
        const recent = "agent:main:person-recent";
        const person = {
          id: "profile-ada",
          identity: { type: "profile" as const, id: "profile-ada" },
          name: "Ada Lovelace",
          onlineSince: now - 900_000,
          lastActivityAt: now - 60_000,
          deviceFamily: "Mac",
          platform: "macOS",
          timeZone: "Europe/London",
          watchedSessions: [watched, "agent:private:hidden"],
        };
        const gateway = await installMockGateway(page, {
          historyMessages,
          presenceUsers: [person],
          methodResponses: {
            "users.list": directory,
            "sessions.list": chatSessionListResponse([
              { key: "agent:main:main", kind: "direct", label: "Card comparison", updatedAt: now },
              {
                key: watched,
                kind: "direct",
                label: "Release checklist",
                updatedAt: now - 60_000,
                boardFace: "dashboard",
              },
              {
                key: recent,
                kind: "direct",
                label: "Review launch notes",
                updatedAt: now - 120_000,
                createdActor: { type: "human", id: person.id, identity: person.identity },
              },
              {
                key: "agent:main:raw-id",
                kind: "direct",
                label: "Unqualified identity must not match",
                updatedAt: now,
                createdActor: { type: "human", id: person.id },
              },
            ]),
          },
        });
        await page.goto(suite.server.baseUrl + "chat");
        const sidebarPerson = page.locator('[data-online-user-id="profile-ada"]');
        await sidebarPerson.hover();
        const card = page.locator(".person-activity-hovercard[role=dialog]");
        await card.getByRole("link", { name: /Release checklist/ }).waitFor();
        const sidebarText = (await card.textContent())?.replace(/\s+/gu, " ");
        const sidebarLinks = await card
          .locator("a")
          .evaluateAll((links) => links.map((link) => link.getAttribute("href")));
        await captureUiProof(suite, page, "person-card-parity", "sidebar.png");
        await page.keyboard.press("Escape");
        const reference = page.locator(".markdown-person-reference");
        await reference.focus();
        await card.locator("h2").waitFor();
        await captureUiProof(suite, page, "person-card-parity", "chat.png");
        expect((await card.textContent())?.replace(/\s+/gu, " ")).toBe(sidebarText);
        expect(
          await card
            .locator("a")
            .evaluateAll((links) => links.map((link) => link.getAttribute("href"))),
        ).toEqual(sidebarLinks);
        expect(await card.textContent()).not.toContain("Unqualified identity");
        expect(await card.textContent()).not.toContain("hidden");
        await gateway.emitGatewayEvent("presence", {
          presence: [
            {
              user: { id: person.id, identity: person.identity, name: person.name },
              deviceFamily: "iPad",
              platform: "iPadOS",
              timeZone: "Europe/Paris",
              onlineSince: person.onlineSince,
              lastActivityAt: now,
              watchedSessions: [watched],
            },
          ],
        });
        await expect.poll(() => card.textContent()).toContain("Europe/Paris");
        expect(await card.textContent()).not.toContain("Europe/London");
        await card.getByRole("link", { name: /Release checklist/ }).focus();
        await gateway.emitGatewayEvent("presence", { presence: [] });
        await expect.poll(() => card.textContent()).toContain("Offline");
        expect(await card.textContent()).not.toContain("Viewing now");
        expect(await card.textContent()).toContain("Review launch notes");
        expect(await reference.evaluate((node) => node === document.activeElement)).toBe(true);
        await gateway.emitGatewayEvent("presence", {
          presence: [
            {
              user: { id: person.id, identity: person.identity, name: person.name },
              watchedSessions: [watched],
            },
          ],
        });
        await card.getByRole("link", { name: /Release checklist/ }).click();
        await expect
          .poll(() => new URL(page.url()).pathname)
          .toBe("/dashboard/main/person-watching");
        await card.waitFor({ state: "detached" });
      },
    );
  });

  it.each(["keyboard", "mouse", "touch"] as const)(
    "opens explicit person cards with %s and keeps the original label",
    async (input) => {
      await suite.withPage(
        {
          viewport: { width: input === "touch" ? 390 : 1180, height: 800 },
          hasTouch: input === "touch",
          colorScheme: "dark",
        },
        async ({ page }) => {
          const avatarRequests: string[] = [];
          await page.route("**/api/users/**/avatar*", (route) => {
            avatarRequests.push(new URL(route.request().url()).pathname);
            return route.fulfill({
              contentType: "image/png",
              body: readFileSync("ui/public/apple-touch-icon.png"),
            });
          });
          const gateway = await installMockGateway(page, {
            historyMessages,
            methodResponses: { "users.list": directory },
          });
          await page.goto(suite.server.baseUrl + "chat");
          await page.locator(".chat-bubble").filter({ hasText: text }).waitFor();
          const reference = page.locator(".markdown-person-reference");
          await reference.waitFor();
          expect(await reference.count()).toBe(1);
          expect(await reference.textContent()).toBe(label);
          expect(await reference.evaluate((node) => getComputedStyle(node).borderWidth)).toBe(
            "0px",
          );
          expect(
            await reference
              .locator(".markdown-person-reference__prefix")
              .evaluate((node) => node.getBoundingClientRect().width),
          ).toBe(0);
          const avatar = reference.locator(".markdown-person-reference__avatar");
          await expect
            .poll(() =>
              avatar
                .locator("img")
                .evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0),
            )
            .toBe(true);
          expect(await avatar.getAttribute("aria-hidden")).toBe("true");
          expect(
            await reference.evaluate((node) => {
              const range = document.createRange();
              range.selectNodeContents(node);
              const selection = window.getSelection()!;
              selection.removeAllRanges();
              selection.addRange(range);
              const copiedText = selection.toString();
              selection.removeAllRanges();
              return copiedText;
            }),
          ).toBe(label);
          expect(avatarRequests).toContain("/api/users/profile-old/avatar");
          const avatarSize = await avatar.boundingBox();
          expect(avatarSize?.width).toBeGreaterThan(0);
          expect(avatarSize?.width).toBe(avatarSize?.height);
          expect(avatarSize!.width).toBe(
            await reference.evaluate(
              (node) => Number.parseFloat(getComputedStyle(node).fontSize) + 2,
            ),
          );
          expect(avatarSize!.height).toBeLessThanOrEqual(
            await reference.evaluate((node) =>
              Number.parseFloat(getComputedStyle(node).lineHeight),
            ),
          );
          await captureUiProof(suite, page, "person-references", input + "-message.png");
          expect(
            await reference
              .locator("xpath=ancestor::*[contains(@class, 'chat-bubble')]")
              .getAttribute("data-message-text"),
          ).toBe(text);
          expect(await gateway.getRequests("users.list")).toHaveLength(0);
          if (input === "keyboard") {
            await reference.focus();
          } else if (input === "mouse") {
            await reference.hover();
          } else {
            await reference.tap();
          }
          const card = page.locator(".person-activity-hovercard[role=dialog]");
          await card.locator("h2").waitFor();
          expect(await card.locator("h2").textContent()).toBe("Ada Lovelace");
          const activity = card.getByRole("link", { name: "View activity" });
          expect(await activity.getAttribute("href")).toBe("/activity/profile-ada");
          await expect
            .poll(() =>
              card
                .locator("img")
                .evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0),
            )
            .toBe(true);
          expect(avatarRequests).toContain("/api/users/profile-ada/avatar");
          await captureUiProof(suite, page, "person-references", input + "-card.png");
          expect(await reference.getAttribute("aria-expanded")).toBe("true");
          expect(await gateway.getRequests("users.list")).toHaveLength(1);
          expect(await gateway.getRequests("chat.send")).toHaveLength(0);
          if (input === "keyboard") {
            await reference.press("Tab");
            expect(await activity.evaluate((node) => node === document.activeElement)).toBe(true);
            await activity.press("Escape");
            expect(await reference.evaluate((node) => node === document.activeElement)).toBe(true);
          } else if (input === "touch") {
            await reference.tap();
          } else {
            await page.locator(".agent-chat__composer-combobox textarea").hover();
          }
          await card.waitFor({ state: "detached" });
          expect(await reference.getAttribute("aria-expanded")).toBe("false");
          await reference.click();
          await activity.waitFor();
          await activity.click();
          await expect.poll(() => new URL(page.url()).pathname).toBe("/activity/profile-ada");
          await card.waitFor({ state: "detached" });
        },
      );
    },
  );

  it("preserves table copying and transcript actions on a mention avatar", async () => {
    await suite.withPage({}, async ({ page }) => {
      await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
        origin: new URL(suite.server.baseUrl).origin,
      });
      await page.route("**/api/users/**/avatar*", (route) =>
        route.fulfill({
          contentType: "image/png",
          body: readFileSync("ui/public/apple-touch-icon.png"),
        }),
      );
      const table = `| Request | Status |\n| --- | --- |\n| Ask ${label} today | Open |`;
      const start = table.indexOf(label);
      await installMockGateway(page, {
        historyMessages: [
          {
            role: "user",
            content: table,
            timestamp: 1,
            __openclaw: {
              id: "mention-table",
              humanMentions: [{ profileId: "profile-old", start, end: start + label.length }],
            },
          },
        ],
        methodResponses: { "users.list": directory },
      });
      await page.goto(suite.server.baseUrl + "chat");
      const reference = page.locator(".markdown-person-reference");
      const image = reference.locator("img");
      await expect
        .poll(() =>
          image.evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth > 0),
        )
        .toBe(true);
      const copied = `Request\tStatus\nAsk ${label} today\tOpen`;
      await page.getByRole("button", { name: "Copy table", exact: true }).click();
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(copied);
      const avatar = await image.boundingBox();
      expect(avatar).not.toBeNull();
      await page.mouse.click(avatar!.x + avatar!.width / 2, avatar!.y + avatar!.height / 2, {
        button: "right",
      });
      await page.getByRole("menuitem", { name: "Copy table", exact: true }).click();
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(copied);
    });
  });

  it("does not revive a dismissed or disconnected card when an old directory reply arrives", async () => {
    await suite.withPage({}, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        historyMessages,
        deferredMethods: ["users.list"],
      });
      await page.goto(suite.server.baseUrl + "chat");
      const reference = page.locator(".markdown-person-reference");
      await reference.focus();
      await gateway.waitForRequest("users.list");
      const card = page.locator(".person-activity-hovercard");
      await card.waitFor();
      await reference.press("Escape");
      await gateway.resolveDeferred("users.list", directory);
      expect(await card.count()).toBe(0);
      await gateway.deferNext("users.list");
      await reference.click();
      await expect.poll(async () => (await gateway.getRequests("users.list")).length).toBe(2);
      await gateway.setOnline(false);
      await card.waitFor({ state: "detached" });
      await gateway.resolveDeferred("users.list", directory);
      expect(await card.count()).toBe(0);
    });
  });

  it.each([
    { profiles: [] },
    {
      profiles: [
        { ...profile, id: "profile-old", displayName: "Former Name", mergedInto: "profile-old" },
      ],
    },
  ])(
    "keeps missing and cyclic identities unresolved without guessing from labels",
    async (response) => {
      await suite.withPage({}, async ({ page }) => {
        await page.route("**/api/users/**/avatar*", (route) => route.fulfill({ status: 404 }));
        await installMockGateway(page, {
          historyMessages,
          methodResponses: { "users.list": response },
        });
        await page.goto(suite.server.baseUrl + "chat");
        const reference = page.locator(".markdown-person-reference");
        const avatar = reference.locator(".markdown-person-reference__avatar.is-fallback");
        await avatar.waitFor();
        expect(await reference.textContent()).toBe(label);
        expect(await avatar.evaluate((node) => getComputedStyle(node, "::after").content)).toBe(
          '"FN"',
        );
        expect(await avatar.locator("img").isVisible()).toBe(false);
        await reference.focus();
        const card = page.locator(".person-activity-hovercard");
        await expect.poll(() => card.textContent()).toContain("Could not load people");
        expect(await card.locator("a").count()).toBe(0);
        expect(await card.locator("openclaw-viewer-avatar").count()).toBe(0);
        await page.locator(".agent-chat__composer-combobox textarea").click();
        await card.waitFor({ state: "detached" });
      });
    },
  );
});
