import type { BrowserContextOptions, Locator, Page } from "playwright";
import { expect as browserExpect } from "playwright/test";
import { expect, it } from "vitest";
import type { UsersListResult } from "../../../packages/gateway-protocol/src/schema/users.js";
import { defaultControlUiFeatureMethods } from "../test-helpers/control-ui-e2e-defaults.ts";
import {
  chatSessionListResponse,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
const withPage = (run: (page: Page) => Promise<void>, options: BrowserContextOptions = {}) =>
  suite.withPage(options, ({ page }) => run(page));
const label = "@Former Name";
const text = label + " cc " + label;
const mentionMessage = (...profileIds: string[]) => ({
  role: "user",
  content: text,
  timestamp: 1,
  __openclaw: {
    id: "mention-message",
    humanMentions: profileIds.map((profileId, index) => ({
      profileId,
      start: index * (label.length + 4),
      end: index * (label.length + 4) + label.length,
    })),
  },
});
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

async function routeAvatars(page: Page, requests: string[]) {
  await page.route("**/api/users/**/avatar*", (route) => {
    requests.push(route.request().url());
    if (new URL(route.request().url()).pathname === "/api/users/profile-missing/avatar") {
      return route.fulfill({ status: 404 });
    }
    return route.fulfill({ path: "ui/public/apple-touch-icon.png" });
  });
}
const referenceBounds = (references: Locator) =>
  references.evaluateAll((elements) =>
    elements.map((element) => element.getBoundingClientRect().toJSON()),
  );
async function personPage(page: Page, scenario: Parameters<typeof installMockGateway>[1] = {}) {
  const gateway = await installMockGateway(page, {
    historyMessages: [mentionMessage("profile-old")],
    ...scenario,
  });
  await page.goto(suite.server.baseUrl + "chat");
  const reference = page.locator(".markdown-person-reference");
  const card = page.locator(".person-activity-hovercard[role=dialog]");
  return {
    gateway,
    reference,
    card,
    heading: card.locator("h2"),
    avatar: reference.locator(".markdown-person-reference__avatar"),
    composer: page.locator(".agent-chat__composer-combobox textarea"),
  };
}

const welcomeText = "@josh invited you, @Sam.";
/** The restricted role Visitor Access grants: session scopes, no people directory. */
const guestWelcome = {
  operatorScopes: ["operator.sessions.write"],
  presenceUsers: [
    {
      self: true,
      id: "profile-sam",
      identity: { type: "profile" as const, id: "profile-sam" },
      name: "Sam",
    },
  ],
  featureMethods: [...defaultControlUiFeatureMethods, "users.mentionable"],
  historyMessages: [
    {
      role: "assistant",
      content: welcomeText,
      timestamp: 1,
      __openclaw: {
        id: "welcome-message",
        humanMentions: [
          { profileId: "profile-josh", start: 0, end: 5 },
          { profileId: "profile-sam", start: 19, end: 23 },
        ],
      },
    },
  ],
  methodResponses: {
    "users.mentionable": {
      users: [
        { profileId: "profile-joshua", displayName: "Joshua", online: false },
        {
          profileId: "profile-josh",
          displayName: "Josh",
          avatarUrl: "/api/users/profile-josh/avatar?v=4",
          online: true,
        },
      ],
      truncated: false,
    },
  },
} satisfies Parameters<typeof installMockGateway>[1];

async function alignMentions(page: Page, viewport: { scale: number; font: string }) {
  const avatarRequests: string[] = [];
  await routeAvatars(page, avatarRequests);
  const { gateway, reference: references } = await personPage(page, {
    deferredMethods: ["users.list"],
    historyMessages: [mentionMessage("profile-photo", "profile-missing")],
  });
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
        const textBox = range.getClientRects()[0]!;
        const box = avatar.getBoundingClientRect();
        const css = getComputedStyle(element);
        const size = Number.parseFloat(css.fontSize) + 2;
        const checks = {
          aligned: Math.abs(box.top + box.height / 2 - (textBox.top + textBox.height / 2)) <= 1,
          sized: box.width > 0 && box.width === size && box.height === size,
          fitsLine: box.height <= Number.parseFloat(css.lineHeight),
          borderless: css.borderWidth === "0px",
          hidden: avatar.getAttribute("aria-hidden") === "true",
          zeroWidthPrefix:
            element.querySelector(".markdown-person-reference__prefix")!.getBoundingClientRect()
              .width === 0,
        };
        return Object.entries(checks)
          .filter(([, passes]) => !passes)
          .map(([check]) => check);
      }),
    );
  await gateway.waitForRequest("users.list");
  await expect.poll(() => references.locator('[data-avatar-state="none"]').count()).toBe(2);
  expect(await references.locator("img").count()).toBe(0);
  expect(avatarRequests).toEqual([]);
  const before = await referenceBounds(references);
  await gateway.resolveDeferred("users.list", {
    profiles: [
      { ...profile, id: "profile-photo", displayName: "Photo Person", hasAvatar: true },
      { ...profile, id: "profile-missing", displayName: "Missing Person" },
    ],
  });
  await browserExpect(references.first().locator('[data-avatar-state="loaded"]')).toHaveCount(1);
  const image = references.first().locator("img");
  await expect
    .poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBeGreaterThan(0);
  const missingAvatar = references.nth(1).locator(".markdown-person-reference__avatar.is-fallback");
  await browserExpect(missingAvatar).toHaveAttribute("data-initials", "FN");
  await browserExpect(missingAvatar.locator("img")).toBeHidden();
  expect(
    avatarRequests.map((url) => new URL(url).pathname + new URL(url).search).toSorted(),
  ).toEqual(["/api/users/profile-missing/avatar?v=2", "/api/users/profile-photo/avatar?v=2"]);
  expect(await referenceBounds(references)).toEqual(before);
  expect(await geometry()).toEqual([[], []]);
  expect(await references.allTextContents()).toEqual([label, label]);
}

async function sharePersonActivity(page: Page) {
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
  const row = (key: string, title: string, updatedAt = now) => ({
    key,
    label: title,
    updatedAt,
    kind: "direct",
  });
  const user = { id: person.id, identity: person.identity, name: person.name };
  const { gateway, reference, card } = await personPage(page, {
    presenceUsers: [person],
    methodResponses: {
      "users.list": directory,
      "sessions.list": chatSessionListResponse([
        row("agent:main:main", "Card comparison"),
        {
          ...row(watched, "Release checklist", now - 60_000),
          boardFace: "dashboard",
        },
        {
          ...row(recent, "Review launch notes", now - 120_000),
          createdActor: { type: "human", id: person.id, identity: person.identity },
        },
        {
          ...row("agent:main:raw-id", "Unqualified identity must not match"),
          createdActor: { type: "human", id: person.id },
        },
      ]),
    },
  });
  await reference.focus();
  await card.getByRole("link", { name: /Release checklist/ }).waitFor();
  expect(await card.textContent()).not.toMatch(/Unqualified identity|hidden/);
  await gateway.emitGatewayEvent("presence", {
    presence: [
      {
        user,
        deviceFamily: "iPad",
        platform: "iPadOS",
        timeZone: "Pacific/Chatham",
        onlineSince: person.onlineSince,
        lastActivityAt: now,
        watchedSessions: [watched],
      },
    ],
  });
  await expect
    .poll(() => card.locator(".person-activity-card__clock").getAttribute("title"))
    .toBe("Pacific/Chatham");
  await card.getByRole("link", { name: /Release checklist/ }).focus();
  await gateway.emitGatewayEvent("presence", { presence: [] });
  await expect.poll(() => card.textContent()).toContain("Offline");
  expect(await card.textContent()).not.toContain("Viewing now");
  expect(await card.textContent()).toContain("Review launch notes");
  await browserExpect(reference).toBeFocused();
  await gateway.emitGatewayEvent("presence", {
    presence: [{ user, watchedSessions: [watched] }],
  });
  await card.getByRole("link", { name: /Release checklist/ }).click();
  await expect.poll(() => new URL(page.url()).pathname).toBe("/dashboard/main/person-watching");
  await card.waitFor({ state: "detached" });
}

async function openPersonCard(page: Page, input: "keyboard" | "mouse" | "touch") {
  const avatarRequests: string[] = [];
  await routeAvatars(page, avatarRequests);
  const { gateway, reference, avatar, card, heading, composer } = await personPage(page, {
    methodResponses: { "users.list": directory },
  });
  await page.locator(".chat-bubble").filter({ hasText: text }).waitFor();
  await reference.waitFor();
  expect(await reference.count()).toBe(1);
  await expect.poll(() => avatar.locator("img").count()).toBe(1);
  expect(
    await reference.evaluate((node) => {
      const selection = window.getSelection()!;
      selection.selectAllChildren(node);
      const copiedText = selection.toString();
      selection.removeAllRanges();
      return {
        text: node.textContent,
        copiedText,
        message: node.closest(".chat-bubble")!.getAttribute("data-message-text"),
      };
    }),
  ).toEqual({ text: label, copiedText: label, message: text });
  const avatarPaths = () => avatarRequests.map((url) => new URL(url).pathname);
  expect(avatarPaths()).not.toContain("/api/users/profile-old/avatar");
  expect(await gateway.getRequests("users.list")).toHaveLength(1);
  if (input === "keyboard") {
    await reference.focus();
  } else if (input === "mouse") {
    await reference.hover();
  } else {
    await reference.tap();
  }
  await browserExpect(heading).toHaveText("Ada Lovelace");
  const activity = card.getByRole("link", { name: "View activity" });
  expect(await activity.getAttribute("href")).toBe("/activity/profile-ada");
  const image = card.locator("img");
  await expect
    .poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0))
    .toBe(true);
  expect(avatarPaths()).toContain("/api/users/profile-ada/avatar");
  expect(await reference.getAttribute("aria-expanded")).toBe("true");
  expect(await gateway.getRequests("users.list")).toHaveLength(2);
  expect(await gateway.getRequests("chat.send")).toHaveLength(0);
  if (input === "keyboard") {
    await reference.press("Tab");
    await browserExpect(activity).toBeFocused();
    await activity.press("Escape");
    await browserExpect(reference).toBeFocused();
  } else if (input === "touch") {
    await reference.tap();
  } else {
    await composer.hover();
  }
  await card.waitFor({ state: "detached" });
  expect(await reference.getAttribute("aria-expanded")).toBe("false");
  await gateway.setMethodResponse("users.list", {
    profiles: directory.profiles.map((entry) =>
      entry.id === "profile-ada" ? { ...entry, displayName: "Ada Byron", updatedAt: 3 } : entry,
    ),
  });
  await reference.click();
  await browserExpect(heading).toHaveText("Ada Byron");
  expect(await reference.textContent()).toBe(label);
  await activity.click();
  await expect.poll(() => new URL(page.url()).pathname).toBe("/activity/profile-ada");
  await card.waitFor({ state: "detached" });
}

suite.define(() => {
  it("renders the inviter photo in a fresh guest welcome before opening a person card", () =>
    withPage(
      async (page) => {
        const avatarRequests: string[] = [];
        let photoWidth = 64;
        await page.route("**/api/users/**/avatar*", (route) => {
          const url = route.request().url();
          avatarRequests.push(url);
          if (new URL(url).pathname !== "/api/users/profile-avery/avatar") {
            return route.fulfill({ status: url.includes("missing") ? 404 : 503 });
          }
          return route.fulfill({
            contentType: "image/svg+xml",
            body:
              '<svg xmlns="http://www.w3.org/2000/svg" width="' +
              photoWidth +
              '" height="64" viewBox="0 0 64 64"><rect width="64" height="64" rx="32" fill="#527866"/><circle cx="32" cy="24" r="12" fill="#f5d6b5"/><path d="M10 64c0-30 44-30 44 0" fill="#e3b367"/></svg>',
          });
        });
        const welcome =
          "Welcome to OpenClaw, Sam.\n\n@Avery Chen invited you. Your guest access does not expire.\n\nThis is your own session with Main.";
        const { gateway, reference: references } = await personPage(page, {
          ...guestWelcome,
          historyMessages: [
            {
              role: "assistant",
              content: welcome,
              timestamp: 1,
              __openclaw: {
                id: "guest-welcome",
                humanMentions: [{ profileId: "profile-avery", start: 27, end: 38 }],
              },
            },
            ...["missing", "error"].map((kind) => ({
              role: "assistant",
              content: "@Avery Chen can also help with your review.",
              timestamp: 2,
              __openclaw: {
                id: kind,
                humanMentions: [{ profileId: "profile-" + kind, start: 0, end: 11 }],
              },
            })),
          ],
        });
        const reference = references.first();
        await browserExpect(reference).toHaveText("@Avery Chen");
        const image = reference.locator("img");
        await expect
          .poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth))
          .toBeGreaterThan(0);
        await browserExpect(image).toHaveCount(1);
        expect(avatarRequests.map((url) => new URL(url).pathname)).toContain(
          "/api/users/profile-avery/avatar",
        );
        expect(await gateway.getRequests("users.list")).toHaveLength(0);
        expect(await gateway.getRequests("users.mentionable")).toHaveLength(0);
        photoWidth = 65;
        await page.reload();
        await expect
          .poll(() =>
            reference
              .first()
              .locator("img")
              .evaluate((img: HTMLImageElement) => img.naturalWidth),
          )
          .toBe(65);
        for (const index of [1, 2]) {
          await browserExpect(
            references.nth(index).locator(".markdown-person-reference__avatar"),
          ).toHaveAttribute("data-avatar-state", "failed");
          await browserExpect(
            references.nth(index).locator(".markdown-person-reference__avatar"),
          ).toHaveAttribute("data-initials", "AC");
          await browserExpect(references.nth(index).locator("img")).toBeHidden();
        }
        expect(await gateway.getRequests("users.list")).toHaveLength(0);
        expect(await gateway.getRequests("users.mentionable")).toHaveLength(0);
      },
      { viewport: { width: 1180, height: 800 }, colorScheme: "dark" },
    ));

  it.each([
    { width: 1280, colorScheme: "light" as const, scale: 1, font: "var(--font-body)" },
    { width: 390, colorScheme: "dark" as const, scale: 1.5, font: "Georgia, serif" },
  ])(
    "keeps advertised mention photos and absent-avatar initials aligned at $width px",
    (viewport) =>
      withPage((page) => alignMentions(page, viewport), {
        viewport: { width: viewport.width, height: 900 },
        colorScheme: viewport.colorScheme,
      }),
  );

  it("updates live person details and visible sessions through an open reference", () =>
    withPage(sharePersonActivity, {
      viewport: { width: 1280, height: 900 },
      colorScheme: "light",
    }));

  it.each(["keyboard", "mouse", "touch"] as const)(
    "opens explicit person cards with %s and keeps the original label",
    (input) =>
      withPage((page) => openPersonCard(page, input), {
        viewport: { width: input === "touch" ? 390 : 1180, height: 800 },
        hasTouch: input === "touch",
        colorScheme: "dark",
      }),
  );

  it.each(["failed", "missing"] as const)(
    "retries a %s initial directory lookup when a person card opens",
    (outcome) =>
      withPage(async (page) => {
        const { gateway, reference, heading } = await personPage(page, {
          deferredMethods: ["users.list"],
        });
        await reference.waitFor();
        await gateway.waitForRequest("users.list");
        if (outcome === "failed") {
          await gateway.rejectDeferred("users.list", {
            code: "UNAVAILABLE",
            message: "Directory temporarily unavailable",
          });
        } else {
          await gateway.resolveDeferred("users.list", { profiles: [] });
        }
        await gateway.deferNext("users.list");
        await reference.focus();
        await expect.poll(async () => (await gateway.getRequests("users.list")).length).toBe(2);
        await gateway.resolveDeferred("users.list", directory);
        await browserExpect(heading).toHaveText("Ada Lovelace");
      }),
  );

  it("does not revive a dismissed or disconnected card when an old directory reply arrives", () =>
    withPage(async (page) => {
      const { gateway, reference, card } = await personPage(page, {
        deferredMethods: ["users.list"],
      });
      await reference.focus();
      await gateway.waitForRequest("users.list");
      await card.waitFor();
      await reference.press("Escape");
      await gateway.resolveDeferred("users.list", directory);
      expect(await card.count()).toBe(0);
      await gateway.setOnline(false);
      await gateway.deferNext("users.list");
      await gateway.setOnline(true);
      await expect.poll(async () => (await gateway.getRequests("users.list")).length).toBe(2);
      await reference.click();
      await gateway.setOnline(false);
      await card.waitFor({ state: "detached" });
      await gateway.resolveDeferred("users.list", directory);
      expect(await card.count()).toBe(0);
    }));

  it("resolves a guest's mentions from the session roster without the people directory", () =>
    withPage(async (page) => {
      const avatarRequests: string[] = [];
      await routeAvatars(page, avatarRequests);
      const { gateway, reference, card, heading } = await personPage(page, guestWelcome);
      await page.locator(".chat-bubble").filter({ hasText: welcomeText }).waitFor();
      await browserExpect(reference).toHaveCount(2);
      await reference.first().focus();
      await browserExpect(heading).toHaveText("Josh");
      await expect
        .poll(() => card.locator("img").evaluate((img: HTMLImageElement) => img.naturalWidth))
        .toBeGreaterThan(0);
      expect(await card.textContent()).not.toContain("Could not load people");
      const roster = await gateway.getRequests("users.mentionable");
      expect(roster.map((request) => request.params)).toEqual([
        { sessionKey: "agent:main:main", query: "josh" },
      ]);
      await reference.first().press("Escape");
      await card.waitFor({ state: "detached" });

      await reference.nth(1).focus();
      await browserExpect(heading).toHaveText("Sam");
      expect(await card.textContent()).not.toContain("Could not load people");
      expect(await card.getByRole("link", { name: "View activity" }).count()).toBe(1);
      await reference.nth(1).press("Escape");
      await reference.first().focus();
      await browserExpect(heading).toHaveText("Josh");
      expect(await gateway.getRequests("users.mentionable")).toHaveLength(1);
      expect(await gateway.getRequests("users.list")).toHaveLength(0);
    }));

  it("keeps missing identities unresolved without guessing from labels", () =>
    withPage(async (page) => {
      await page.route("**/api/users/**/avatar*", (route) => route.fulfill({ status: 404 }));
      const { reference, card, composer } = await personPage(page, {
        methodResponses: { "users.list": { profiles: [] } },
      });
      const avatar = reference.locator(".markdown-person-reference__avatar.is-fallback");
      await avatar.waitFor();
      expect(await reference.textContent()).toBe(label);
      expect(await avatar.evaluate((node) => getComputedStyle(node, "::after").content)).toBe(
        '"FN"',
      );
      expect(await avatar.locator("img").isVisible()).toBe(false);
      await reference.focus();
      await expect.poll(() => card.textContent()).toContain("Could not load people");
      expect(await card.locator("a, openclaw-viewer-avatar").count()).toBe(0);
      await composer.click();
      await card.waitFor({ state: "detached" });
    }));
});
