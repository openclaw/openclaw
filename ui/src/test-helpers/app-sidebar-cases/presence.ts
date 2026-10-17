import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { PresenceEntry } from "../../api/types.ts";
import * as presenceUsers from "../../lib/presence-users.ts";
import { selectSessionMenuValue } from "../app-sidebar-menu.ts";
import { focusSidebarPersonWithKeyboard, selectSidebarView } from "../app-sidebar-setup.ts";
import {
  createGatewayHarness,
  createSessions,
  createSessionsHarness,
  mountSidebar,
} from "../app-sidebar.ts";
import { domProbe } from "../dom-probe.ts";
import { createTestGatewayClient } from "../gateway-client.ts";
import { settleLitElement } from "../lit-settle.ts";
import { flush } from "../solid-settle.ts";
import "../../components/app-sidebar.tsx";

await import("../../components/viewer-facepile.ts");

type PresenceFixture = Omit<PresenceEntry, "ts"> & { ts?: number };

async function mountPresence(
  sessions = createSessions("main", ["agent:main:work"]),
  view: "online" | "sessions" = "online",
  instanceId = "self-instance",
) {
  const gateway = createGatewayHarness({ instanceId } as GatewayBrowserClient);
  const mounted = await mountSidebar(gateway.gateway, sessions);
  mounted.sidebar.connected = true;
  if (view === "online") {
    await selectSidebarView(mounted.sidebar, view);
  }
  return {
    ...mounted,
    gateway,
    dom: domProbe(mounted.sidebar),
    publishPresence(presence: PresenceFixture[]) {
      gateway.publishEvent("presence", { presence });
      return settleLitElement(mounted.sidebar);
    },
  };
}

function viewer(
  id: string,
  extra: Omit<PresenceFixture, "user"> = {},
  user: Partial<NonNullable<PresenceEntry["user"]>> = {},
): PresenceFixture {
  return { ...extra, user: { id, name: id[0]!.toUpperCase() + id.slice(1), ...user } };
}

const activityCard = () => document.querySelector<HTMLElement>(".person-activity-hovercard");
const cardName = () => activityCard()?.querySelector("h2")?.textContent;
const aliceIdentity = { type: "profile", id: "alice" } as const;
const aliceUser = { id: "alice", identity: aliceIdentity, name: "Alice" };
async function settledCard(name?: string) {
  await vi.dynamicImportSettled();
  await vi.waitFor(() =>
    name === undefined ? expect(activityCard()).not.toBeNull() : expect(cardName()).toBe(name),
  );
  return domProbe(activityCard()!);
}

describe("AppSidebar viewer presence", () => {
  it.each([
    ["profile-bob", "bob"],
    ["gateway-owner", "Shared owner"],
  ])("shows presence and offline owner %s while excluding self", async (ownerId, ownerName) => {
    const owners = ["self", "ada", "bob"].map((name) => ({
      type: "human" as const,
      id: name === "bob" ? ownerId : `profile-${name}`,
      identity: { type: "profile" as const, id: name === "bob" ? ownerId : `profile-${name}` },
      label: name,
    }));
    const sessions = createSessionsHarness(
      "main",
      owners.map((owner) => `agent:main:${owner.id}`),
    );
    const result = sessions.sessions.state.result!;
    result.owners = owners;
    result.sessions.forEach((row, index) => {
      row.owner = { actor: owners[index]! };
    });
    sessions.publishList({ result });
    const { sidebar, dom, publishPresence } = await mountPresence(sessions.sessions, "sessions");
    await selectSessionMenuValue(sidebar, "grouping:person");
    const section = (id: string) =>
      domProbe(
        dom.query(
          `[data-session-section="person:profile:${id === "bob" ? ownerId : `profile-${id}`}"]`,
        )!,
      );
    expect(section("bob").text(".sidebar-recent-sessions__label-text")).toBe(ownerName);
    expect(section("bob").attr("[data-person-card]", "aria-label")).toBe(
      `Details for ${ownerName}`,
    );
    const self = {
      instanceId: "self-instance",
      user: { id: "profile-self", identity: owners[0]!.identity, name: "Self" },
      lastActivityAt: Date.now(),
    };
    const ada = {
      instanceId: "ada-instance",
      user: { id: "profile-ada", identity: owners[1]!.identity, name: "Ada" },
      lastActivityAt: Date.now() - 5000,
    };
    await publishPresence([self, ada]);
    const dot = () => section("ada").query(".sidebar-session-group-presence");
    const personButton = section("ada").query<HTMLButtonElement>("[data-person-card]")!;
    expect(dot()?.getAttribute("aria-label")).toBe("Online · Active");
    expect(dot()?.classList.contains("sidebar-session-group-presence--idle")).toBe(false);
    expect(dot()!.id).toBeTruthy();
    expect(personButton.getAttribute("aria-describedby")).toBe(dot()!.id);
    expect(section("bob").query(".sidebar-session-group-presence")).toBeNull();
    expect(section("self").query(".sidebar-session-group-presence, [data-person-card]")).toBeNull();
    expect(
      section("self").text(".sidebar-session-group-toggle .sidebar-recent-sessions__label-text"),
    ).toBe("self");

    const toggle = section("ada").query<HTMLButtonElement>(".sidebar-session-group-toggle")!;
    expect(personButton).toMatchObject({
      tagName: "BUTTON",
      ariaHasPopup: "dialog",
      ariaLabel: "Details for ada",
    });
    expect(personButton.previousElementSibling).toBe(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    personButton.click();
    const card = await settledCard("Ada");
    expect(card.text(".person-activity-card__status")?.trim()).toBe("Online · Active");
    expect(personButton.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    card.query<HTMLAnchorElement>("a")!.focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(activityCard()).toBeNull();
    expect(document.activeElement).toBe(personButton);
    expect(personButton.getAttribute("aria-expanded")).toBe("false");
    // The chevron press also dismisses the card through outside-pointer handling.
    personButton.click();
    await vi.waitFor(() => expect(activityCard()).not.toBeNull());
    toggle.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    toggle.click();
    await settleLitElement(sidebar);
    expect(section("ada").query("[data-session-key]")).toBeNull();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(activityCard()).toBeNull();

    const bobButton = section("bob").query<HTMLButtonElement>("[data-person-card]")!;
    bobButton.click();
    const offlineCard = await settledCard(ownerName);
    await settleLitElement(sidebar);
    await vi.waitFor(() =>
      expect(offlineCard.attr("section a", "href")).toBe(`/chat/main/${ownerId}`),
    );
    expect(offlineCard.text(".person-activity-card__status--offline")?.trim()).toBe("Offline");
    expect(offlineCard.query("dl")).toBeNull();
    expect(offlineCard.text("section h3")).toBe("Recent sessions");
    expect(offlineCard.attr("footer a", "href")).toBe(`/activity/${ownerId}`);
    bobButton.click();
    expect(activityCard()).toBeNull();
    bobButton.focus();
    await vi.waitFor(() => expect(cardName()).toBe(ownerName));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    await publishPresence([self, { ...ada, lastActivityAt: Date.now() - 600000 }]);
    expect(dot()?.classList.contains("sidebar-session-group-presence--idle")).toBe(true);
    expect(dot()?.getAttribute("aria-label")).toBe("Online · Idle");
    expect(personButton.getAttribute("aria-describedby")).toBe(dot()!.id);

    await publishPresence([self, { ...ada, reason: "disconnect" }]);
    expect(dot()).toBeNull();
    expect(personButton.hasAttribute("aria-describedby")).toBe(false);
    expect(
      section("ada").query(".sidebar-session-group-toggle__person")?.hasAttribute("title"),
    ).toBe(false);
  });

  it("shows all online identities with active-first ordering and idle dimming", async () => {
    const { sidebar, gateway, dom, publishPresence } = await mountPresence(
      createSessions("main", ["agent:main:main"]),
    );
    const onNavigate = vi.fn();
    sidebar.onNavigate = onNavigate;
    const online = (id: string, lastActivityAt?: number) =>
      viewer(
        id,
        { instanceId: `${id}-instance`, lastActivityAt, ts: 1 },
        id === "alice" ? aliceUser : {},
      );

    expect(dom.query(".sidebar-online__person")).toBeNull();
    await publishPresence([online("self", Date.now())]);
    expect(dom.all(".sidebar-online__person")).toHaveLength(1);
    expect(dom.query('[data-online-user-id="self"]')).not.toBeNull();

    gateway.publishEvent("presence", {
      presence: [
        online("self", Date.now()),
        online("zed", Date.now() - 20000),
        online("alice", Date.now() - 600000),
        online("bob"),
      ],
    });

    await vi.waitFor(() => {
      const rows = [...dom.all<HTMLElement>(".sidebar-online__person")];
      expect(
        rows.map((row) => [
          domProbe(row).text(".sidebar-online__person-name")?.trim(),
          row.dataset.presenceActivity,
        ]),
      ).toEqual([
        ["Self", "active"],
        ["Zed", "active"],
        ["Alice", "idle"],
        ["Bob", "unknown"],
      ]);
    });
    expect(dom.query('[data-online-user-id="self"]')).not.toBeNull();

    await selectSidebarView(sidebar, "sessions");
    expect(dom.all(".sidebar-online__person")).toHaveLength(0);
    await selectSidebarView(sidebar, "online");
    expect(dom.all(".sidebar-online__person")).toHaveLength(4);

    const aliceRow = dom.query<HTMLAnchorElement>('[data-online-user-id="alice"]')!;
    aliceRow.click();
    await vi.dynamicImportSettled();
    expect(onNavigate).toHaveBeenCalledWith("activity", {
      href: "/activity/alice",
      pathname: "/activity/alice",
      search: "",
    });
    expect(aliceRow).toMatchObject({ tagName: "A", pathname: "/activity/alice" });
    expect(aliceRow.getAttribute("href")).toBe("/activity/alice");
    const row = domProbe(aliceRow.closest(".sidebar-online__row")!);
    expect(row.all("a")).toHaveLength(1);
    expect(row.query('button[aria-label="Pin"]')).not.toBeNull();
    expect(activityCard()).toBeNull();

    focusSidebarPersonWithKeyboard(aliceRow);
    await settledCard();
    aliceRow.querySelector<HTMLElement>(".sidebar-online__person-name")!.click();
    await vi.dynamicImportSettled();
    expect(onNavigate).toHaveBeenCalledTimes(2);
    expect(activityCard()).toBeNull();

    const bobRow = dom.query<HTMLButtonElement>('[data-online-user-id="bob"]')!;
    expect(bobRow.tagName).toBe("BUTTON");
    bobRow.click();
    await vi.waitFor(() => expect(cardName()).toBe("Bob"));
    expect(onNavigate).toHaveBeenCalledTimes(2);
  });

  it("keeps the active identity and focused session link across presence reordering", async () => {
    const sessions = createSessionsHarness("main", ["agent:main:work"]);
    const result = sessions.sessions.state.result!;
    result.sessions[0]!.createdActor = { type: "human", id: "alice", identity: aliceIdentity };
    sessions.publishList({ result });
    const { sidebar, dom, publishPresence } = await mountPresence(sessions.sessions);
    const now = Date.now();
    const alice = {
      user: aliceUser,
      ts: now,
      watchedSessions: ["agent:main:work"],
      onlineSince: now - 60_000,
      lastActivityAt: now - 10_000,
    };
    const bob = viewer("bob", { ts: now, lastActivityAt: Date.now() });
    await publishPresence([alice, bob]);
    const button = dom.query<HTMLAnchorElement>('[data-online-user-id="alice"]')!;
    focusSidebarPersonWithKeyboard(button);
    const card = await settledCard();
    await vi.waitFor(() =>
      expect(card.text(".person-activity-card__status")?.trim()).toBe("Online for 1m · Active"),
    );
    const sessionLink = card.query<HTMLAnchorElement>(".person-activity-card__session")!;
    sessionLink.focus();
    await publishPresence([{ ...alice, lastActivityAt: now - 600_000 }, bob]);
    expect(dom.query('[data-online-user-id="alice"]')).toBe(button);
    expect(dom.attr(".sidebar-online__person", "data-online-user-id")).toBe("bob");
    expect(card.text("h2")).toBe("Alice");
    expect(document.activeElement).toBe(sessionLink);
    expect(card.attr("time", "datetime")).toBe(new Date(alice.onlineSince).toISOString());
    await publishPresence([{ ...alice, watchedSessions: [] }, bob]);
    expect([...card.all("h3")].map((heading) => heading.textContent)).toEqual(["Recent sessions"]);
    // The initially empty recent selection cannot admit a new link mid-open,
    // even when it leaves Viewing now. Reopening takes a fresh selection.
    expect(card.query(".person-activity-card__session")).toBeNull();
    expect(document.activeElement).toBe(button);
    button.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    button.blur();
    button.focus();
    await settleLitElement(sidebar);
    const recentLink = document.querySelector<HTMLAnchorElement>(".person-activity-card__session")!;
    expect(recentLink.getAttribute("href")).toBe(sessionLink.getAttribute("href"));
    expect(recentLink.closest("section")?.querySelector("h3")?.textContent).toBe("Recent sessions");
  });

  it.each([true, false])(
    "expires activity without another event (deadline crosses during render: %s)",
    async (duringRender) => {
      const { sidebar, provider, gateway, dom, publishPresence } = await mountPresence();
      vi.useFakeTimers();
      const now = Date.now();
      const person = viewer("alice", {
        lastActivityAt: now - (duringRender ? 119_999 : 119_000),
        ...(duringRender ? { ts: now } : { onlineSince: now - 300_000 }),
      });
      gateway.publishEvent("presence", { presence: [person] });
      if (duringRender) {
        const project = presenceUsers.presenceViewerActivity;
        // Advance only in the queued render, after event admission's activity read.
        vi.spyOn(presenceUsers, "presenceViewerActivity").mockImplementationOnce((user) => {
          const state = project(user);
          vi.setSystemTime(now + 2);
          return state;
        });
        await sidebar.updateComplete;
      } else {
        await settleLitElement(sidebar);
      }
      const row = dom.query<HTMLElement>('[data-online-user-id="alice"]')!;
      if (!duringRender) {
        row.click();
        await vi.dynamicImportSettled();
      }
      const card = activityCard();
      expect(row.dataset.presenceActivity).toBe("active");
      await vi.advanceTimersByTimeAsync(duringRender ? 2 : 1_000);
      await settleLitElement(sidebar);
      expect(row.dataset.presenceActivity).toBe("idle");
      if (!duringRender) {
        expect(domProbe(card!).text(".person-activity-card__status")).toContain("Idle");
        expect(card?.textContent).toContain("Online for");
      }
      await publishPresence([
        { ...person, lastActivityAt: Date.now(), ...(duringRender ? { ts: Date.now() } : {}) },
      ]);
      expect(row.dataset.presenceActivity).toBe("active");
      if (!duringRender) {
        provider.remove();
        await Promise.resolve();
        flush();
        expect(vi.getTimerCount()).toBe(0);
      }
    },
  );

  it.each(["disconnect", "switch", "route", "collapse", "shell", "remove", "teardown"] as const)(
    "dismisses and releases card timers on %s",
    async (reason) => {
      const { sidebar, provider, gateway, dom, publishPresence } = await mountPresence();
      const person = { user: aliceUser, ts: Date.now(), onlineSince: Date.now() - 90_000 };
      await publishPresence([person]);
      vi.useFakeTimers();
      const scheduleInterval = vi.spyOn(globalThis, "setInterval");
      const clearInterval = vi.spyOn(globalThis, "clearInterval");
      focusSidebarPersonWithKeyboard(dom.query<HTMLElement>(".sidebar-online__person")!);
      await vi.dynamicImportSettled();
      await vi.waitFor(() =>
        expect(document.querySelector("openclaw-elapsed-time")?.textContent).toBeTruthy(),
      );
      const elapsed = document.querySelector("openclaw-elapsed-time")!;
      await elapsed.updateComplete;
      const cardIntervals = scheduleInterval.mock.results
        .filter((result) => result.type === "return")
        .map((result) => result.value);
      expect(cardIntervals.length).toBeGreaterThan(0);
      const dismiss = {
        disconnect: () => gateway.publish({ phase: "reconnecting" }),
        switch: () =>
          gateway.publish({ client: createTestGatewayClient(async () => ({ profiles: [] })) }),
        route: () => {
          sidebar.activeRouteId = "activity";
        },
        shell: () => sidebar.dismissTransientMenus(),
        collapse: () => selectSidebarView(sidebar, "sessions"),
        remove: () =>
          gateway.publishEvent("presence", { presence: [{ ...person, reason: "disconnect" }] }),
        teardown: () => provider.remove(),
      };
      await dismiss[reason]();
      await settleLitElement(sidebar);
      await vi.waitFor(() => expect(activityCard()).toBeNull());
      // The bridge waits one microtask before disposing a disconnected view.
      await Promise.resolve();
      expect(elapsed.isConnected).toBe(false);
      for (const interval of cardIntervals) {
        expect(clearInterval).toHaveBeenCalledWith(interval);
      }
      await vi.advanceTimersByTimeAsync(1_000);
      expect(activityCard()).toBeNull();
      if (reason === "remove") {
        expect(dom.query(".sidebar-online__person")).toBeNull();
        const returned = { ...person, ts: Date.now(), onlineSince: Date.now() };
        await publishPresence([{ ...person, reason: "disconnect" }, returned]);
        focusSidebarPersonWithKeyboard(dom.query<HTMLElement>(".sidebar-online__person")!);
        await vi.waitFor(() =>
          expect(
            document.querySelector(".person-activity-hovercard time")?.getAttribute("datetime"),
          ).toBe(new Date(returned.onlineSince).toISOString()),
        );
        expect(cardName()).toBe("Alice");
      }
    },
  );

  it("keeps explicitly selected Online expanded despite a legacy collapsed-section preference", async () => {
    const collapsedKey = "openclaw:sidebar:sessions:collapsed-sections";
    localStorage.setItem(collapsedKey, JSON.stringify(["online"]));
    const { sidebar, dom, publishPresence } = await mountPresence(
      createSessions("main", ["agent:main:main"]),
    );

    await publishPresence(
      ["self", "alice", "bob", "carol", "dave"].map((id) =>
        viewer(id, { instanceId: `${id}-instance` }, id === "alice" ? aliceUser : {}),
      ),
    );

    expect(dom.attr('[data-navigation-view="online"]', "aria-pressed")).toBe("true");
    expect(dom.query(".sidebar-online__list")).not.toBeNull();
    expect(dom.all(".sidebar-online__person")).toHaveLength(5);
    expect(localStorage.getItem(collapsedKey)).toBe(JSON.stringify(["online"]));
    await selectSidebarView(sidebar, "sessions");
    expect(dom.query(".sidebar-online")).toBeNull();
    await selectSidebarView(sidebar, "online");
    expect(dom.all(".sidebar-online__person")).toHaveLength(5);
  });

  it("groups identified viewers for session rows and keeps the footer identity-only", async () => {
    const { sidebar, gateway, dom, publishPresence } = await mountPresence(
      createSessions("main", ["agent:main:main", "agent:main:work"]),
      "sessions",
    );
    const selfUser = {
      id: "00-self",
      name: "Self User",
      avatarUrl: "/api/users/00-self/avatar?v=1",
    };
    const watchedSessions = ["agent:main:work"];
    const watching = (
      id: string,
      instanceId = `${id}-1`,
      user: Parameters<typeof viewer>[2] = {},
      keys = watchedSessions,
    ) => viewer(id, { instanceId, watchedSessions: keys }, user);
    await publishPresence([
      watching("00-self", "self-instance", selfUser),
      watching("alice", "alice-1", {
        identity: aliceIdentity,
        avatarUrl: "/api/users/alice/avatar",
      }),
      watching("alice", "alice-2", { identity: aliceIdentity }, ["agent:main:main"]),
      watching("bob", "bob-1", { name: undefined, email: "bob@example.test" }),
      ...["carol", "dave", "erin", "frank"].map((id) => watching(id)),
      { instanceId: "anonymous-1", watchedSessions },
      { ...watching("offline", "offline-1", { name: "Offline User" }), reason: "disconnect" },
    ]);
    gateway.publish({ selfUser });
    sidebar.setSessionOwnerFilter(null);
    await settleLitElement(sidebar);

    const sessionFacepile = dom.query<HTMLElementTagNameMap["openclaw-viewer-facepile"]>(
      '[data-session-key="agent:main:work"] openclaw-viewer-facepile',
    )!;
    await sessionFacepile.updateComplete;
    const facepile = domProbe(sessionFacepile);
    expect(facepile.attr(".viewer-facepile", "data-viewer-count")).toBe("6");
    const ids = [...facepile.all<HTMLElement>("[data-viewer-id]")].map(
      ({ dataset }) => dataset.viewerId,
    );
    expect(ids).toEqual(["alice", "bob", "carol"]);
    expect(facepile.text(".viewer-avatar--overflow")).toContain("+3");
    expect(facepile.query('[data-viewer-id="alice"] img')).not.toBeNull();
    const labels = [...facepile.all("openclaw-tooltip")].map((tooltip) => tooltip.content);
    expect(labels).toEqual(["Alice", "bob@example.test", "Carol", "Dave\nErin\nFrank"]);

    const identityCard = domProbe(dom.query(".sidebar-identity-card")!);
    expect(identityCard.text(".sidebar-identity-card__name")?.trim()).toBe("Self User");
    expect(identityCard.query('[data-viewer-id="00-self"]')).not.toBeNull();

    const avatar = identityCard.query<HTMLImageElement>("openclaw-viewer-avatar img");
    expect(avatar?.getAttribute("src")).toBe("/api/users/00-self/avatar?v=1");
    const footer = domProbe(dom.query(".sidebar-footer-bar")!);
    expect(footer.query("openclaw-viewer-facepile")).toBeNull();
    expect(footer.query("openclaw-sidebar-build-chip")).toBeNull();
    expect(footer.query(".sidebar-brand__logo-slot")).toBeNull();
    gateway.gateway.updateSelfUser?.({
      name: "Augusta Ada",
      avatarUrl: "/api/users/00-self/avatar?v=4",
    });
    await settleLitElement(sidebar);

    expect(identityCard.text(".sidebar-identity-card__name")?.trim()).toBe("Augusta Ada");
    expect(avatar?.getAttribute("src")).toBe("/api/users/00-self/avatar?v=4");

    sidebar.connected = false;
    await settleLitElement(sidebar);
    expect(dom.text(".sidebar-identity-card__name")?.trim()).toBe("Augusta Ada");
  });

  it.each([
    undefined,
    { id: "owner-profile", identity: { type: "profile" as const, id: "owner-profile" } },
  ])("renders an Owner fallback without a name or email (%j)", async (user) => {
    const { gateway, dom, publishPresence } = await mountPresence(
      createSessions("main", ["agent:main:main"]),
      "sessions",
      "anonymous-self",
    );

    gateway.publish({ selfUser: user ?? null });
    await publishPresence([
      { instanceId: "anonymous-self", user, watchedSessions: ["agent:main:main"] },
      viewer("alice", { instanceId: "alice" }, { identity: aliceIdentity }),
    ]);

    const identityCard = domProbe(dom.query(".sidebar-identity-card")!);
    expect(identityCard.text(".sidebar-identity-card__name")?.trim()).toBe("Owner");
    expect(identityCard.text(`[data-viewer-id="${user?.id ?? "owner"}"]`)).toContain("O");
  });
});
