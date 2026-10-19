import { readFileSync } from "node:fs";
import type { BrowserContextOptions, Locator, Page } from "playwright";
import { expect as browserExpect } from "playwright/test";
import { expect, it } from "vitest";
import type { UsersListResult } from "../../../packages/gateway-protocol/src/schema/users.js";
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
    return route.fulfill({
      contentType: "image/png",
      body: readFileSync("ui/public/apple-touch-icon.png"),
    });
  });
}
const referenceBounds = (references: Locator) =>
  references.evaluateAll((elements) =>
    elements.map((element) => element.getBoundingClientRect().toJSON()),
  );
const cardLinks = (card: Locator) =>
  card.locator("a").evaluateAll((links) => links.map((link) => link.getAttribute("href")));
const cardText = async (card: Locator) => (await card.textContent())?.replace(/\s+/gu, " ");
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
  expect(await references.nth(1).locator("img").count()).toBe(0);
  expect(avatarRequests.map((url) => new URL(url).pathname + new URL(url).search)).toEqual([
    "/api/users/profile-photo/avatar?v=2",
  ]);
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
  await page.locator('[data-navigation-view="online"]').click();
  const sidebarPerson = page.locator('[data-online-user-id="profile-ada"]');
  await sidebarPerson.hover();
  await card.getByRole("link", { name: /Release checklist/ }).waitFor();
  const sidebarText = await cardText(card);
  const sidebarLinks = await cardLinks(card);
  await page.keyboard.press("Escape");
  await reference.focus();
  await card.locator("h2").waitFor();
  expect(await cardText(card)).toBe(sidebarText);
  expect(await cardLinks(card)).toEqual(sidebarLinks);
  expect(await card.textContent()).not.toMatch(/Unqualified identity|hidden/);
  await gateway.emitGatewayEvent("presence", {
    presence: [
      {
        user,
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

  it("shares live person details and visible sessions with the sidebar", () =>
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
