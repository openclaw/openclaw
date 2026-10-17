import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { beforeEach, expect, it } from "vitest";
import type { GatewaySessionRow } from "../api/types.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  defaultControlUiFeatureMethods,
  reconnectMockGateway,
  type MockGatewayControls,
} from "../test-helpers/control-ui-e2e.ts";
import {
  captureUiProofEnabled,
  chatSessionListResponse,
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
const selected = "agent:main:card-selected";
const watched = "agent:main:card-viewing";
let proofDirectory: string;
beforeEach(() => {
  if (captureUiProofEnabled) {
    proofDirectory = createControlUiE2eArtifactDir("presence-namespaces");
  }
});
const recentLabel = "Review the complete cross-platform launch readiness checklist before release";
const updatedRecentLabel = `${recentLabel} with every regional owner`;
const focusUpdatedRecentLabel = `${updatedRecentLabel} and final approval`;

const id = "synthetic-shared-id";
const rawSession = "agent:main:raw-watch";
const profileSession = "agent:main:profile-watch";
const profile = { id, identity: { type: "profile" as const, id }, name: "Profile person" };
const raw = { id, name: "Unqualified sender" };
const focused = (target: Locator) =>
  target.evaluate((element) => document.activeElement === element);
const shift = (title: Locator) =>
  title.evaluate((element) => element.style.getPropertyValue("--hover-marquee-shift"));
const pollScrolling = (title: Locator) =>
  expect.poll(() =>
    title.evaluate((element) => element.classList.contains("hover-marquee--scrolling")),
  );
const onlinePerson = (page: Page, personId: string) =>
  page.locator(`[data-online-user-id="${personId}"]`);
const activityCard = (page: Page) => page.getByRole("dialog", { name: "Activity for Alice" });
const pollCount = (target: Locator) => expect.poll(() => target.count());
function sessionRow(
  key: string,
  label: string,
  updatedAt: number,
  extra: Partial<Omit<GatewaySessionRow, "key" | "kind" | "label" | "updatedAt">> = {},
) {
  return { key, kind: "direct" as const, label, updatedAt, ...extra };
}

async function updateRecent(gateway: MockGatewayControls, title: Locator, label: string) {
  const reads = (await gateway.getRequests("sessions.list")).length;
  await gateway.setSessionsListResponse(scenario(label).methodResponses["sessions.list"]);
  await gateway.emitGatewayEvent("sessions.changed", {
    reason: "update",
    sessionKey: "agent:main:card-recent",
  });
  await expect
    .poll(async () => (await gateway.getRequests("sessions.list")).length)
    .toBeGreaterThan(reads);
  await expect.poll(() => title.textContent()).toBe(label);
}

function scenario(recentSessionLabel = recentLabel) {
  const now = Date.now();
  return {
    sessionKey: selected,
    presenceUsers: [
      {
        id: "alice",
        identity: { type: "profile" as const, id: "alice" },
        name: "Alice",
        onlineSince: now - 2_700_000,
        lastActivityAt: now - 60_000,
        deviceFamily: "Mac",
        platform: "macOS",
        timeZone: "Europe/Paris",
        watchedSessions: [watched, "agent:main:main", "agent:private:hidden"],
      },
    ],
    methodResponses: {
      "sessions.list": chatSessionListResponse([
        sessionRow("agent:main:main", "", now - 90_000),
        sessionRow(selected, "Selected session", now),
        sessionRow(watched, "Release checklist", now - 60_000, {
          boardFace: "dashboard",
        }),
        sessionRow("agent:main:card-recent", recentSessionLabel, now - 120_000, {
          createdActor: { type: "human", id: "alice", identity: { type: "profile", id: "alice" } },
        }),
      ]),
    },
  };
}

async function expectInlineLastActivity(card: Locator) {
  const positions = await card
    .locator(".person-activity-card__facts dd")
    .last()
    .evaluate((value) => {
      const time = value.querySelector("time");
      const text = document.createTreeWalker(value, NodeFilter.SHOW_TEXT);
      let suffix = text.nextNode();
      while (suffix && suffix.textContent?.trim() !== "ago") {
        suffix = text.nextNode();
      }
      if (!time || !suffix) {
        throw new Error("Expected last activity duration and suffix");
      }
      const range = document.createRange();
      range.selectNodeContents(suffix);
      return { time: time.getBoundingClientRect().top, suffix: range.getBoundingClientRect().top };
    });
  expect(Math.abs(positions.time - positions.suffix)).toBeLessThan(2);
}

async function expectMultilineTitle(title: Locator) {
  const layout = await title.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      lineClamp: style.getPropertyValue("-webkit-line-clamp"),
      renderedLines: element.getBoundingClientRect().height / Number.parseFloat(style.lineHeight),
      whiteSpace: style.whiteSpace,
    };
  });
  expect(layout.lineClamp).toBe("2");
  expect(layout.renderedLines).toBeGreaterThan(1.5);
  expect(layout.whiteSpace).toBe("normal");
}

async function selectOnlineView(page: Page, touch = false) {
  const online = page.locator(".sidebar-rail").getByRole("button", { name: "Users", exact: true });
  if (touch) {
    await online.tap();
  } else {
    await online.click();
  }
}

async function capturePeopleCard(page: Page, filename: string, fullPage = true) {
  if (!captureUiProofEnabled) {
    return;
  }
  await page.screenshot({
    path: path.join(proofDirectory, filename),
    fullPage,
    animations: "disabled",
  });
}

suite.define(() => {
  it("reports native browser interaction but not automatic reconnection", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, scenario());
      await page.clock.install();
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, selected));
      await gateway.waitForRequest("presence.activity");
      const initial = await gateway.getRequests("presence.activity");
      expect(initial).toHaveLength(1);
      expect(initial[0]?.params).toEqual({});
      await page.clock.fastForward(31_000);
      await page.keyboard.press("Shift");
      await expect
        .poll(async () => (await gateway.getRequests("presence.activity")).length)
        .toBe(2);
      await page.keyboard.press("Shift");
      expect(await gateway.getRequests("presence.activity")).toHaveLength(2);
      await page.clock.resume();
      await reconnectMockGateway(page, gateway);
      expect(await gateway.getRequests("presence.activity")).toHaveLength(2);
    });
  });
  it("separates connection duration from active, idle, and unavailable activity", async () => {
    await suite.withPage(
      { viewport: { width: 1280, height: 900 }, colorScheme: "dark", locale: "en-US" },
      async ({ page }) => {
        const now = Date.now();
        const data = scenario();
        const gateway = await installMockGateway(page, {
          ...data,
          presenceUsers: [
            { ...data.presenceUsers[0]!, lastActivityAt: now - 600_000 },
            { id: "bob", name: "Bob", lastActivityAt: now, onlineSince: now - 900_000 },
            { id: "charlie", name: "Charlie", onlineSince: now - 300_000 },
          ],
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, selected));
        await selectOnlineView(page);
        const person = onlinePerson(page, "alice");
        await person.hover();
        const card = activityCard(page);
        await card.waitFor({ state: "visible" });
        await capturePeopleCard(page, "online-idle-desktop.png");
        expect(await card.locator(".person-activity-card__status").textContent()).toContain("Idle");
        expect(await card.textContent()).toContain("Online for");
        expect(await card.textContent()).toContain("Last interaction");
        expect(await person.getAttribute("data-presence-activity")).toBe("idle");
        expect(await onlinePerson(page, "bob").getAttribute("data-presence-activity")).toBe(
          "active",
        );
        expect(await onlinePerson(page, "charlie").getAttribute("data-presence-activity")).toBe(
          "unknown",
        );
        await gateway.emitGatewayEvent("presence", {
          presence: [
            {
              ...data.presenceUsers[0]!,
              user: { id: "alice", identity: { type: "profile", id: "alice" }, name: "Alice" },
              lastActivityAt: Date.now(),
            },
          ],
        });
        await expect.poll(() => person.getAttribute("data-presence-activity")).toBe("active");
        expect(await card.locator(".person-activity-card__status").textContent()).toContain(
          "Active",
        );
      },
    );
  });
  it("labels shared owner presence separately from a personal sign-in", async () => {
    await suite.withPage(
      { viewport: { width: 1280, height: 900 }, colorScheme: "light", locale: "en-US" },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          sessionKey: selected,
          methodResponses: {
            "sessions.list": chatSessionListResponse([
              sessionRow(selected, "Synthetic audit session", 1),
            ]),
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, selected));
        await gateway.waitForRequest("connect");
        await selectOnlineView(page);
        await gateway.emitGatewayEvent("presence", {
          presence: [
            {
              user: { id: "gateway-owner", identity: { type: "profile", id: "gateway-owner" } },
              platform: "macOS 27.0.0",
              deviceFamily: "Mac",
              clientId: "openclaw-macos",
              mode: "ui",
              onlineSince: Date.now() - 720_000,
              watchedSessions: [selected],
            },
            { user: { id: "example-person", name: "Example person" } },
          ],
        });
        const owner = onlinePerson(page, "gateway-owner");
        await owner.hover();
        const card = page.locator(".person-activity-hovercard");
        await card.waitFor({ state: "visible" });
        await capturePeopleCard(page, "shared-owner.png");
        expect(await owner.textContent()).toContain("Shared owner");
        expect(await card.getAttribute("aria-label")).toBe("Activity for Shared owner");
        expect(await card.locator("h2").textContent()).toBe("Shared owner");
        expect(await card.textContent()).toContain(
          "Connected with the Gateway token or over a tunnel, not a personal sign-in.",
        );
        expect(await card.textContent()).toContain("Mac · macOS 27.0.0 · App");
        expect(await card.textContent()).toContain("Activity unavailable");
        expect(await card.getByRole("link", { name: "View activity" }).getAttribute("href")).toBe(
          "/activity/gateway-owner",
        );
        expect(await onlinePerson(page, "example-person").textContent()).toContain(
          "Example person",
        );
        expect(
          await page
            .locator('.chat-pane__presence [data-viewer-id="gateway-owner"]')
            .getAttribute("aria-label"),
        ).toBe("Shared owner");
      },
    );
  });

  it.each(["click", "Enter", "tap", "tap with loaded preview"] as const)(
    "opens a person's Activity page directly on %s",
    async (action) => {
      const touch = action.startsWith("tap");
      await suite.withPage(
        {
          hasTouch: touch,
          isMobile: touch,
          viewport: touch ? { width: 390, height: 650 } : { width: 1280, height: 900 },
        },
        async ({ page }) => {
          const gateway = await installMockGateway(page, scenario());
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, selected));
          if (touch) {
            await page
              .locator(".topbar-nav-toggle:visible, .chat-pane__nav-toggle:visible")
              .first()
              .click();
          }
          await selectOnlineView(page, touch);
          const person = onlinePerson(page, "alice");
          if (action === "Enter") {
            await page.keyboard.press("Tab");
            await person.focus();
            await activityCard(page).waitFor({ state: "visible" });
            await person.press("Enter");
          } else if (touch) {
            if (action === "tap with loaded preview") {
              // Warm the real card before a fresh touch gesture, not during its click.
              await page.keyboard.press("Tab");
              await person.focus();
              const card = activityCard(page);
              await card.waitFor({ state: "visible" });
              await page.keyboard.press("Shift+Tab");
              await pollCount(card).toBe(0);
            }
            await person.tap();
          } else {
            await person.click();
          }
          await expect.poll(() => new URL(page.url()).pathname).toBe("/activity/alice");
          await pollCount(activityCard(page)).toBe(0);
          await expect
            .poll(
              async () =>
                (await gateway.getRequests("sessions.list", { involvingProfileId: "alice" }))
                  .length,
            )
            .toBeGreaterThan(0);
        },
      );
    },
  );

  it("opens person details on hover, preserves focus on updates, and follows the card activity link", async () => {
    await suite.withPage(
      {
        hasTouch: false,
        colorScheme: "light",
        locale: "en-US",
        recordVideo: captureUiProofEnabled
          ? { dir: proofDirectory, size: { width: 1280, height: 900 } }
          : undefined,
        serviceWorkers: "block",
        viewport: { width: 1280, height: 900 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, scenario());
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, selected));
        await selectOnlineView(page);
        const row = page
          .locator(".sidebar-online__row")
          .filter({ has: onlinePerson(page, "alice") });
        const person = row.getByRole("link", { name: "Activity for Alice" });
        const card = activityCard(page);
        await person.waitFor({ state: "visible" });
        expect(await card.count()).toBe(0);
        expect(await row.locator("a, button").count()).toBe(2);
        expect(await row.getByRole("button", { name: "Pin", exact: true }).count()).toBe(1);
        await person.hover();
        await card.waitFor({ state: "visible" });
        expect(await card.textContent()).toContain("Reported time zone: Europe/Paris");
        await expect
          .poll(() => card.locator("a").allTextContents())
          .toEqual(
            expect.arrayContaining([
              expect.stringContaining("Release checklist"),
              expect.stringContaining("Main Session"),
              expect.stringContaining(recentLabel),
              expect.stringContaining("View activity"),
            ]),
          );
        expect(await card.innerHTML()).not.toContain("agent:private:hidden");
        await expectInlineLastActivity(card);
        if (captureUiProofEnabled) {
          await writeFile(
            path.join(proofDirectory, "desktop-light-open.png"),
            await takeControlUiViewportScreenshot(page, card, [
              card.getByRole("link", { name: "View activity", exact: true }),
            ]),
          );
        }
        const bounds = await row.boundingBox();
        const cardBounds = await card.boundingBox();
        if (!bounds || !cardBounds) {
          throw new Error("Expected person row and card bounds");
        }
        await page.mouse.move(bounds.x + bounds.width + 4, bounds.y + bounds.height / 2);
        await page.mouse.move(cardBounds.x + 8, cardBounds.y + 20);
        expect(await card.count()).toBe(1);
        const recent = card
          .getByRole("heading", { name: "Recent sessions" })
          .locator("..")
          .getByRole("link");
        const recentTitle = recent.locator(".person-activity-card__session-name");
        await recent.hover();
        const initialShift = await shift(recentTitle);
        expect(initialShift).not.toBe("");
        await updateRecent(gateway, recentTitle, updatedRecentLabel);
        await expect.poll(() => shift(recentTitle)).not.toBe(initialShift);
        await page.mouse.move(cardBounds.x + 8, cardBounds.y + 20);
        await pollScrolling(recentTitle).toBe(false);
        await person.focus();
        await page.keyboard.press("Tab");
        const session = card.getByRole("link", { name: "Release checklist" });
        await expect.poll(() => focused(session)).toBe(true);
        expect(await session.getAttribute("href")).toContain("/dashboard/");
        const current = scenario().presenceUsers[0]!;
        await gateway.emitGatewayEvent("presence", {
          presence: [
            {
              ...current,
              user: { id: "alice", identity: { type: "profile", id: "alice" }, name: "Alice" },
              ts: Date.now(),
              lastActivityAt: Date.now() - 600_000,
            },
            { user: { id: "bob", name: "Bob" }, ts: Date.now(), lastActivityAt: Date.now() },
          ],
        });
        await expect
          .poll(() =>
            page.locator(".sidebar-online__person").first().getAttribute("data-online-user-id"),
          )
          .toBe("bob");
        expect(await focused(session)).toBe(true);
        await page.keyboard.press("Tab");
        await page.keyboard.press("Tab");
        await expect.poll(() => focused(recent)).toBe(true);
        await pollScrolling(recentTitle).toBe(true);
        const focusedShift = await shift(recentTitle);
        await updateRecent(gateway, recentTitle, focusUpdatedRecentLabel);
        await expect.poll(() => shift(recentTitle)).not.toBe(focusedShift);
        await pollScrolling(recentTitle).toBe(true);
        await page.keyboard.press("Tab");
        await page.emulateMedia({ reducedMotion: "reduce" });
        await expectMultilineTitle(recentTitle);
        await page.emulateMedia({ reducedMotion: "no-preference" });
        await page.keyboard.press("Escape");
        await pollCount(card).toBe(0);
        expect(await focused(person)).toBe(true);
        await page.mouse.click(1100, 200);
        await person.hover();
        await card.waitFor({ state: "visible" });
        await page.mouse.click(1100, 200);
        await pollCount(card).toBe(0);
        await person.hover();
        await card.waitFor({ state: "visible" });
        await card.getByRole("link", { name: "View activity", exact: true }).click();
        await expect.poll(() => new URL(page.url()).pathname).toBe("/activity/alice");
        await pollCount(card).toBe(0);
      },
    );
  });

  it("opens focused details inside a narrow touch viewport and follows the session's saved face", async () => {
    await suite.withPage(
      {
        hasTouch: true,
        isMobile: true,
        colorScheme: "dark",
        reducedMotion: "no-preference",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { width: 390, height: 650 },
      },
      async ({ page }) => {
        await installMockGateway(page, scenario());
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, selected));
        // A mouse click parks a hover pointer where the sliding drawer's header
        // buttons pass; their tooltips then consume the card's Escape.
        await page
          .locator(".topbar-nav-toggle:visible, .chat-pane__nav-toggle:visible")
          .first()
          .tap();
        await selectOnlineView(page, true);
        const person = page.getByRole("link", { name: "Activity for Alice" });
        await page.keyboard.press("Tab");
        await person.focus();
        const card = activityCard(page);
        await card.waitFor({ state: "visible" });
        await page.keyboard.press("Tab");
        await expect
          .poll(() => card.evaluate((element) => element.contains(document.activeElement)))
          .toBe(true);
        await page.keyboard.press("Escape");
        await pollCount(card).toBe(0);
        expect(await person.isVisible()).toBe(true);
        expect(await focused(person)).toBe(true);
        await page.keyboard.press("Shift+Tab");
        await person.focus();
        await card.waitFor({ state: "visible" });
        expect(await card.evaluate((element) => getComputedStyle(element).pointerEvents)).toBe(
          "auto",
        );
        const bounds = await card.boundingBox();
        expect(bounds).not.toBeNull();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.y).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
        expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(650);
        const session = card.getByRole("link", { name: "Release checklist" });
        await session.click({ trial: true });
        const recent = card.getByRole("link", { name: recentLabel });
        const recentTitle = recent.locator(".person-activity-card__session-name");
        await expectMultilineTitle(recentTitle);
        await recent.focus();
        expect(await recentTitle.evaluate((element) => getComputedStyle(element).textIndent)).toBe(
          "0px",
        );
        await expectMultilineTitle(recentTitle);
        await expectInlineLastActivity(card);
        await capturePeopleCard(page, "touch-dark-open.png");
        await session.tap();
        await expect.poll(() => page.url()).toContain("/dashboard/");
        await pollCount(card).toBe(0);
      },
    );
  });
  it("keeps colliding people, watches, owner exclusion and open cards separate through updates", async () => {
    await suite.withPage(
      {
        viewport: { width: 1280, height: 900 },
        colorScheme: "light",
        locale: "en-US",
        serviceWorkers: "block",
      },
      async ({ page }) => {
        const actor = {
          type: "human" as const,
          id,
          identity: profile.identity,
          label: profile.name,
        };
        const sessions = chatSessionListResponse([
          sessionRow(selected, "Namespace isolation", 3, {
            owner: { actor },
            participantCount: 1,
          }),
          sessionRow(profileSession, "Profile watch", 2, {
            createdActor: actor,
          }),
          sessionRow(rawSession, "Raw watch", 1),
        ]);
        const gateway = await installMockGateway(page, {
          sessionKey: selected,
          presenceUsers: [
            { self: true, id: "self", identity: { type: "profile", id: "self" }, name: "Self" },
            { ...profile, watchedSessions: [selected, profileSession] },
            { ...raw, watchedSessions: [selected, rawSession] },
          ],
          methodResponses: { "sessions.list": sessions },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, selected));
        await selectOnlineView(page);
        const profileButton = page.getByRole("link", {
          name: "Activity for Profile person",
          exact: true,
        });
        await profileButton.waitFor({ state: "visible" });
        await capturePeopleCard(page, "initial.png", false);
        expect(await page.locator(".sidebar-online__person").count()).toBe(3);
        const rawButton = page.getByRole("button", {
          name: "Details for Unqualified sender",
          exact: true,
        });
        await rawButton.click();
        const rawCard = page.getByRole("dialog", {
          name: "Activity for Unqualified sender",
          exact: true,
        });
        await rawCard.waitFor({ state: "visible" });
        expect(await rawCard.getByRole("link", { name: /^Raw watch(?:\s|$)/ }).count()).toBe(1);
        expect(await rawCard.getByRole("link", { name: /^Profile watch(?:\s|$)/ }).count()).toBe(0);
        expect(
          await rawCard.getByRole("link", { name: "View activity", exact: true }).count(),
        ).toBe(0);
        const headerFaces = page.locator(".chat-pane__presence [data-viewer-id]");
        await expect.poll(() => headerFaces.getAttribute("aria-label")).toBe(raw.name);
        await capturePeopleCard(page, "raw-card.png", false);
        const rawLink = rawCard.getByRole("link", { name: /^Raw watch(?:\s|$)/ });
        await rawLink.focus();
        await gateway.emitGatewayEvent("presence", {
          presence: [
            {
              user: raw,
              watchedSessions: [rawSession, selected],
              lastActivityAt: Date.now() - 600000,
            },
            {
              user: profile,
              watchedSessions: [profileSession, selected],
              lastActivityAt: Date.now(),
            },
          ],
        });
        await expect.poll(() => focused(rawLink)).toBe(true);
        await gateway.emitGatewayEvent("presence", {
          presence: [{ user: raw, watchedSessions: [rawSession, selected] }],
        });
        await expect.poll(() => page.locator(".sidebar-online__person").count()).toBe(1);
        expect(await focused(rawLink)).toBe(true);
        expect(await rawCard.count()).toBe(1);
        await gateway.emitGatewayEvent("presence", {
          presence: [
            { user: raw, reason: "disconnect", watchedSessions: [rawSession] },
            { user: profile, watchedSessions: [profileSession] },
          ],
        });
        await expect.poll(() => rawCard.count()).toBe(0);
        await profileButton.hover();
        const profileCard = page.getByRole("dialog", {
          name: "Activity for Profile person",
          exact: true,
        });
        await profileCard.waitFor({ state: "visible" });
        expect(await profileCard.getByRole("link", { name: /^Raw watch(?:\s|$)/ }).count()).toBe(0);
        const activity = profileCard.getByRole("link", { name: "View activity", exact: true });
        expect(await activity.getAttribute("href")).toBe(`/activity/${id}`);
        await capturePeopleCard(page, "profile-card.png", false);
        expect((await gateway.getRequests("connect")).length).toBeGreaterThan(0);
        expect((await gateway.getRequests("sessions.list")).length).toBeGreaterThan(0);
      },
    );
  });
  it.each([true, false])(
    "keeps a same-ID peer visible and typing enabled for profile self: %s",
    async (qualified) => {
      await suite.withPage(
        { viewport: { width: 1280, height: 900 }, locale: "en-US" },
        async ({ page }) => {
          const self = qualified ? profile : raw;
          const peer = qualified ? raw : profile;
          const gateway = await installMockGateway(page, {
            sessionKey: selected,
            featureMethods: [...defaultControlUiFeatureMethods, "session.typing"],
            presenceUsers: [
              { ...self, self: true, watchedSessions: [selected] },
              { ...peer, watchedSessions: [selected] },
            ],
            methodResponses: {
              "session.typing": { ok: true, broadcast: true },
              "sessions.list": chatSessionListResponse([
                sessionRow(selected, "Namespace isolation", 1, {
                  sessionId: "namespace-session",
                }),
              ]),
            },
          });
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, selected));
          await selectOnlineView(page);
          await page
            .getByRole(qualified ? "button" : "link", {
              name: `${qualified ? "Details" : "Activity"} for ${peer.name}`,
              exact: true,
            })
            .waitFor({ state: "visible" });
          expect(await page.locator(".sidebar-online__person").count()).toBe(2);
          await expect
            .poll(() =>
              page.locator(".chat-pane__presence [data-viewer-id]").getAttribute("aria-label"),
            )
            .toBe(peer.name);
          await page
            .locator(".agent-chat__composer-combobox textarea")
            .fill("A synthetic typing draft");
          const typing = await gateway.waitForRequest("session.typing");
          expect(typing.params).toMatchObject({ sessionKey: selected, typing: true });
        },
      );
    },
  );
});
