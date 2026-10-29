import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import type { GatewaySessionRow } from "../api/types.ts";
import {
  defaultControlUiFeatureMethods,
  reconnectMockGateway,
  type MockGatewayControls,
} from "../test-helpers/control-ui-e2e.ts";
import { navigationDrawerToggle } from "../test-helpers/control-ui-navigation.ts";
import {
  chatSessionListResponse,
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
const desktop = { width: 1280, height: 900 };
const phone = { width: 390, height: 650 };
const withPage = async (
  options: Parameters<typeof suite.withPage>[0],
  run: Parameters<typeof suite.withPage>[1],
): Promise<void> => {
  await suite.withPage({ viewport: desktop, locale: "en-US", ...options }, run);
};
const selected = "agent:main:card-selected";
const watched = "agent:main:card-viewing";
const recentLabel = "Review the complete cross-platform launch readiness checklist before release";
const updatedRecentLabel = `${recentLabel} with every regional owner`;
const focusUpdatedRecentLabel = `${updatedRecentLabel} and final approval`;

const id = "synthetic-shared-id";
const rawSession = "agent:main:raw-watch";
const profileSession = "agent:main:profile-watch";
const profile = { id, identity: { type: "profile" as const, id }, name: "Profile person" };
const raw = { id, name: "Unqualified sender" };
const alice = { id: "alice", identity: { type: "profile" as const, id: "alice" }, name: "Alice" };
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
const activityCard = (page: Page, name = "Alice") =>
  page.getByRole("dialog", { name: `Activity for ${name}`, exact: name !== "Alice" });
const personLink = (page: Page, name: string) =>
  page.getByRole("link", { name: `Activity for ${name}`, exact: name !== "Alice" });
const pollCount = (target: Locator) => expect.poll(() => target.count());
const link = (scope: Locator, name: string | RegExp) =>
  scope.getByRole("link", { name, exact: name === "View activity" });
const expectText = async (target: Locator, text: string) =>
  expect(await target.textContent()).toContain(text);
const expectAttribute = async (target: Locator, name: string, value: string) =>
  expect(await target.getAttribute(name)).toBe(value);
const expectCount = async (target: Locator, count: number) =>
  expect(await target.count()).toBe(count);
const computedStyleProperty = (target: Locator, property: string) =>
  target.evaluate((element, key) => getComputedStyle(element).getPropertyValue(key), property);
const requestCount = async (gateway: MockGatewayControls, method: string) =>
  (await gateway.getRequests(method)).length;
const pollRequests = (gateway: MockGatewayControls, method: string) =>
  expect.poll(() => requestCount(gateway, method));
const emitPresence = (gateway: MockGatewayControls, presence: unknown[]) =>
  gateway.emitGatewayEvent("presence", { presence });
async function openPeople(
  page: Page,
  options: Parameters<typeof installMockGateway>[1] = scenario(),
  touch?: "tap" | "click",
) {
  const gateway = await installMockGateway(page, options);
  await page.goto(controlUiSessionUrl(suite.server.baseUrl, selected));
  if (touch) {
    const toggle = navigationDrawerToggle(page);
    await toggle[touch]();
  }
  const online = page.locator(".sidebar-rail").getByRole("button", { name: "Users", exact: true });
  await online[touch ? "tap" : "click"]();
  return gateway;
}
function sessionRow(
  key: string,
  label: string,
  updatedAt: number,
  extra: Partial<Omit<GatewaySessionRow, "key" | "kind" | "label" | "updatedAt">> = {},
) {
  return { key, kind: "direct" as const, label, updatedAt, ...extra };
}

async function updateRecent(gateway: MockGatewayControls, title: Locator, label: string) {
  const reads = await requestCount(gateway, "sessions.list");
  await gateway.setSessionsListResponse(scenario(label).methodResponses["sessions.list"]);
  await gateway.emitGatewayEvent("sessions.changed", {
    reason: "update",
    sessionKey: "agent:main:card-recent",
  });
  await pollRequests(gateway, "sessions.list").toBeGreaterThan(reads);
  await expect.poll(() => title.textContent()).toBe(label);
}

function scenario(recentSessionLabel = recentLabel) {
  const now = Date.now();
  return {
    sessionKey: selected,
    presenceUsers: [
      {
        ...alice,
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
  expect(layout).toMatchObject({ lineClamp: "2", whiteSpace: "normal" });
  expect(layout.renderedLines).toBeGreaterThan(1.5);
}

suite.define(() => {
  it("reports native browser interaction but not automatic reconnection", () =>
    withPage({}, async ({ page }) => {
      const gateway = await installMockGateway(page, scenario());
      await page.clock.install();
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, selected));
      await gateway.waitForRequest("presence.activity");
      const initial = await gateway.getRequests("presence.activity");
      expect(initial.map(({ params }) => params)).toEqual([{}]);
      await page.clock.fastForward(31_000);
      await page.keyboard.press("Shift");
      await pollRequests(gateway, "presence.activity").toBe(2);
      await page.keyboard.press("Shift");
      expect(await gateway.getRequests("presence.activity")).toHaveLength(2);
      await page.clock.resume();
      await reconnectMockGateway(page, gateway);
      expect(await gateway.getRequests("presence.activity")).toHaveLength(2);
    }));
  it("separates connection duration from active, idle, and unavailable activity", () =>
    withPage({ colorScheme: "dark" }, async ({ page }) => {
      const now = Date.now();
      const data = scenario();
      const gateway = await openPeople(page, {
        ...data,
        presenceUsers: [
          { ...data.presenceUsers[0]!, lastActivityAt: now - 600_000 },
          { id: "bob", name: "Bob", lastActivityAt: now, onlineSince: now - 900_000 },
          { id: "charlie", name: "Charlie", onlineSince: now - 300_000 },
        ],
      });
      const person = onlinePerson(page, "alice");
      await person.hover();
      const card = activityCard(page);
      await card.waitFor({ state: "visible" });
      // Presence reorders the row; keep focus in the card while its activity changes.
      await link(card, "View activity").focus();
      await expectText(card.locator(".person-activity-card__status"), "Idle");
      await expectText(card, "Online for");
      await expectText(card, "Last interaction");
      for (const [personId, activity] of [
        ["alice", "idle"],
        ["bob", "active"],
        ["charlie", "unknown"],
      ] as const) {
        await expectAttribute(onlinePerson(page, personId), "data-presence-activity", activity);
      }
      await emitPresence(gateway, [
        {
          ...data.presenceUsers[0]!,
          user: alice,
          lastActivityAt: Date.now(),
        },
      ]);
      await expect.poll(() => person.getAttribute("data-presence-activity")).toBe("active");
      await expectText(card.locator(".person-activity-card__status"), "Active");
    }));
  it("labels shared owner presence separately from a personal sign-in", () =>
    withPage({ colorScheme: "light" }, async ({ page }) => {
      const gateway = await openPeople(page, { sessionKey: selected });
      await gateway.waitForRequest("connect");
      await emitPresence(gateway, [
        {
          user: {
            id: "gateway-owner",
            identity: { type: "profile", id: "gateway-owner" },
            name: "Synthetic operator",
          },
          platform: "macOS 27.0.0",
          deviceFamily: "Mac",
          clientId: "openclaw-macos",
          mode: "ui",
          onlineSince: Date.now() - 720_000,
          watchedSessions: [selected],
        },
        { user: { id: "example-person", name: "Example person" } },
      ]);
      const owner = onlinePerson(page, "gateway-owner");
      await owner.hover();
      const card = page.locator(".person-activity-hovercard");
      await card.waitFor({ state: "visible" });
      await expectText(owner, "Synthetic operator · Shared owner");
      await expectAttribute(card, "aria-label", "Activity for Synthetic operator · Shared owner");
      expect(await card.locator("h2").textContent()).toBe("Synthetic operator · Shared owner");
      await expectText(
        card,
        "Connected with the Gateway token or over a tunnel, not a personal sign-in.",
      );
      await expectText(card, "Mac · macOS 27.0.0 · App");
      await expectText(card, "Activity unavailable");
      await expectAttribute(link(card, "View activity"), "href", "/activity/gateway-owner");
      await expectText(onlinePerson(page, "example-person"), "Example person");
      await expectAttribute(
        page.locator('.chat-pane__presence [data-viewer-id="gateway-owner"]'),
        "aria-label",
        "Synthetic operator · Shared owner",
      );
    }));

  it.each(["click", "Enter", "tap", "tap with loaded preview"] as const)(
    "opens a person's Activity page directly on %s",
    async (action) => {
      const touch = action.startsWith("tap");
      await withPage(
        { hasTouch: touch, isMobile: touch, viewport: touch ? phone : desktop },
        async ({ page }) => {
          const gateway = await openPeople(page, scenario(), touch ? "click" : undefined);
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

  it("opens person details on hover, preserves focus on updates, and follows the card activity link", () =>
    withPage(
      { hasTouch: false, colorScheme: "light", serviceWorkers: "block" },
      async ({ page }) => {
        const gateway = await openPeople(page);
        const row = page
          .locator(".sidebar-online__row")
          .filter({ has: onlinePerson(page, "alice") });
        const person = personLink(page, "Alice");
        const card = activityCard(page);
        await person.waitFor({ state: "visible" });
        await expectCount(card, 0);
        await expectCount(row.locator("a, button"), 2);
        await expectCount(row.getByRole("button", { name: "Actions for Alice", exact: true }), 1);
        await person.hover();
        await card.waitFor({ state: "visible" });
        await expectText(card, "Reported time zone: Europe/Paris");
        await expect
          .poll(() => card.locator("a").allTextContents())
          .toEqual(
            expect.arrayContaining(
              ["Release checklist", "Main Session", recentLabel, "View activity"].map((text) =>
                expect.stringContaining(text),
              ),
            ),
          );
        expect(await card.innerHTML()).not.toContain("agent:private:hidden");
        await expectInlineLastActivity(card);
        const bounds = await row.boundingBox();
        const cardBounds = await card.boundingBox();
        if (!bounds || !cardBounds) {
          throw new Error("Expected person row and card bounds");
        }
        await page.mouse.move(bounds.x + bounds.width + 4, bounds.y + bounds.height / 2);
        await page.mouse.move(cardBounds.x + 8, cardBounds.y + 20);
        await expectCount(card, 1);
        const recent = card
          .getByRole("heading", { name: "Recent sessions" })
          .locator("..")
          .getByRole("link");
        const recentTitle = recent.locator(".person-activity-card__session-name");
        await recent.hover();
        await pollScrolling(recentTitle).toBe(true);
        const initialShift = await shift(recentTitle);
        expect(initialShift).not.toBe("");
        await updateRecent(gateway, recentTitle, updatedRecentLabel);
        await expect.poll(() => shift(recentTitle)).not.toBe(initialShift);
        await page.mouse.move(cardBounds.x + 8, cardBounds.y + 20);
        await pollScrolling(recentTitle).toBe(false);
        await person.focus();
        await page.keyboard.press("Tab");
        const session = link(card, "Release checklist");
        await expect.poll(() => focused(session)).toBe(true);
        expect(await session.getAttribute("href")).toContain("/dashboard/");
        const current = scenario().presenceUsers[0]!;
        await emitPresence(gateway, [
          {
            ...current,
            user: alice,
            ts: Date.now(),
            lastActivityAt: Date.now() - 600_000,
          },
          { user: { id: "bob", name: "Bob" }, ts: Date.now(), lastActivityAt: Date.now() },
        ]);
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
        await link(card, "View activity").click();
        await expect.poll(() => new URL(page.url()).pathname).toBe("/activity/alice");
        await pollCount(card).toBe(0);
      },
    ));

  it("opens focused details inside a narrow touch viewport and follows the session's saved face", () =>
    withPage(
      {
        hasTouch: true,
        isMobile: true,
        colorScheme: "dark",
        reducedMotion: "no-preference",
        serviceWorkers: "block",
        viewport: phone,
      },
      async ({ page }) => {
        // A mouse click parks a hover pointer where the sliding drawer's header
        // buttons pass; their tooltips then consume the card's Escape.
        await openPeople(page, scenario(), "tap");
        const person = personLink(page, "Alice");
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
        expect(await computedStyleProperty(card, "pointer-events")).toBe("auto");
        const bounds = await card.boundingBox();
        expect(bounds).not.toBeNull();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.y).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
        expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(650);
        const session = link(card, "Release checklist");
        await session.click({ trial: true });
        const recent = link(card, recentLabel);
        const recentTitle = recent.locator(".person-activity-card__session-name");
        await expectMultilineTitle(recentTitle);
        await recent.focus();
        expect(await computedStyleProperty(recentTitle, "text-indent")).toBe("0px");
        await expectMultilineTitle(recentTitle);
        await expectInlineLastActivity(card);
        await session.tap();
        await expect.poll(() => page.url()).toContain("/dashboard/");
        await pollCount(card).toBe(0);
      },
    ));
  it("keeps colliding people, watches, owner presence and open cards separate through updates", () =>
    withPage({ colorScheme: "light", serviceWorkers: "block" }, async ({ page }) => {
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
      const gateway = await openPeople(page, {
        sessionKey: selected,
        presenceUsers: [
          { self: true, id: "self", identity: { type: "profile", id: "self" }, name: "Self" },
          { ...profile, watchedSessions: [selected, profileSession] },
          { ...raw, watchedSessions: [selected, rawSession] },
        ],
        methodResponses: { "sessions.list": sessions },
      });
      const profileButton = personLink(page, profile.name);
      await profileButton.waitFor({ state: "visible" });
      await expectCount(page.locator(".sidebar-online__person"), 3);
      const rawButton = page.getByRole("button", {
        name: "Details for Unqualified sender",
        exact: true,
      });
      await rawButton.click();
      const rawCard = activityCard(page, raw.name);
      await rawCard.waitFor({ state: "visible" });
      await expectCount(link(rawCard, /^Raw watch(?:\s|$)/), 1);
      await expectCount(link(rawCard, /^Profile watch(?:\s|$)/), 0);
      await expectCount(link(rawCard, "View activity"), 0);
      const headerFaces = page.locator(".chat-pane__presence [data-viewer-id]");
      await expect
        .poll(() =>
          headerFaces.evaluateAll((faces) =>
            faces
              .map((face) => face.getAttribute("aria-label") ?? "")
              .toSorted((a, b) => a.localeCompare(b)),
          ),
        )
        .toEqual([profile.name, raw.name].toSorted((a, b) => a.localeCompare(b)));
      const rawLink = link(rawCard, /^Raw watch(?:\s|$)/);
      await rawLink.focus();
      await emitPresence(gateway, [
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
      ]);
      await expect.poll(() => focused(rawLink)).toBe(true);
      await emitPresence(gateway, [{ user: raw, watchedSessions: [rawSession, selected] }]);
      await expect.poll(() => page.locator(".sidebar-online__person").count()).toBe(1);
      expect(await focused(rawLink)).toBe(true);
      await expectCount(rawCard, 1);
      await emitPresence(gateway, [
        { user: raw, reason: "disconnect", watchedSessions: [rawSession] },
        { user: profile, watchedSessions: [profileSession] },
      ]);
      await expect.poll(() => rawCard.count()).toBe(0);
      await profileButton.hover();
      const profileCard = activityCard(page, profile.name);
      await profileCard.waitFor({ state: "visible" });
      await expectCount(link(profileCard, /^Raw watch(?:\s|$)/), 0);
      await expectAttribute(link(profileCard, "View activity"), "href", `/activity/${id}`);
      expect(await requestCount(gateway, "connect")).toBeGreaterThan(0);
      expect(await requestCount(gateway, "sessions.list")).toBeGreaterThan(0);
    }));
  it.each([true, false])(
    "keeps a same-ID peer visible and typing enabled for profile self: %s",
    (qualified) =>
      withPage({}, async ({ page }) => {
        const self = qualified ? profile : raw;
        const peer = qualified ? raw : profile;
        const gateway = await openPeople(page, {
          sessionKey: selected,
          featureMethods: [...defaultControlUiFeatureMethods, "session.typing"],
          presenceUsers: [
            { ...self, self: true, watchedSessions: [selected] },
            { ...peer, watchedSessions: [selected] },
          ],
          sessions: [{ key: selected, kind: "direct", sessionId: "namespace-session" }],
          methodResponses: { "session.typing": { ok: true, broadcast: true } },
        });
        await page
          .getByRole(qualified ? "button" : "link", {
            name: `${qualified ? "Details" : "Activity"} for ${peer.name}`,
            exact: true,
          })
          .waitFor({ state: "visible" });
        await expectCount(page.locator(".sidebar-online__person"), 2);
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
      }),
  );
});
