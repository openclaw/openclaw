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
  type SidebarLifecycleState,
} from "../app-sidebar.ts";
import { domProbe } from "../dom-probe.ts";
import { createTestGatewayClient } from "../gateway-client.ts";
import { settleLitElement } from "../lit-settle.ts";
import { flush } from "../solid-settle.ts";
import "../../components/app-sidebar.tsx";

await import("../../components/viewer-facepile.ts");

type PresenceFixture = Omit<PresenceEntry, "ts"> & { ts?: number };

async function mountOnlineSidebar(
  gateway = createGatewayHarness({ instanceId: "self" } as GatewayBrowserClient),
  sessions = createSessions("main", ["agent:main:work"]),
) {
  const mounted = await mountSidebar(gateway.gateway, sessions);
  await selectSidebarView(mounted.sidebar, "online");
  return {
    ...mounted,
    gateway,
    dom: domProbe(mounted.sidebar),
    publishPresence: presencePublisher(mounted.sidebar, gateway),
  };
}
function presencePublisher(
  sidebar: SidebarLifecycleState,
  gateway: ReturnType<typeof createGatewayHarness>,
) {
  return (presence: PresenceFixture[]) => {
    gateway.publishEvent("presence", { presence });
    return settleLitElement(sidebar);
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
const aliceIdentity = { type: "profile", id: "alice" } as const;

describe("AppSidebar viewer presence", () => {
  it.each([
    ["profile-bob", "bob"],
    ["gateway-owner", "Shared owner"],
  ])("shows presence and offline owner %s while excluding self", async (ownerId, ownerName) => {
    const client = { instanceId: "self-instance" } as GatewayBrowserClient;
    const gateway = createGatewayHarness(client);
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
    const observeList = sessions.sessions.observeList;
    let activityReady = Promise.resolve();
    vi.spyOn(sessions.sessions, "observeList").mockImplementation((query, listener) => {
      const observation = observeList(query, listener);
      return query.source === "activity"
        ? { ...observation, refresh: () => (activityReady = observation.refresh()) }
        : observation;
    });
    const result = sessions.sessions.state.result!;
    result.owners = owners;
    result.sessions.forEach((row, index) => {
      row.owner = { actor: owners[index]! };
    });
    sessions.publishList({ result });
    const { sidebar } = await mountSidebar(gateway.gateway, sessions.sessions);
    const dom = domProbe(sidebar);
    const publishPresence = presencePublisher(sidebar, gateway);
    sidebar.connected = true;
    await selectSessionMenuValue(sidebar, "grouping:person");
    const section = (id: string) =>
      dom.query(
        `[data-session-section="person:profile:${id === "bob" ? ownerId : `profile-${id}`}"]`,
      )!;
    for (const id of ["self", "ada", "bob"]) {
      expect(section(id)).not.toBeNull();
    }
    expect(section("bob").querySelector(".sidebar-recent-sessions__label-text")?.textContent).toBe(
      ownerName,
    );
    expect(section("bob").querySelector("[data-person-card]")?.getAttribute("aria-label")).toBe(
      `Details for ${ownerName}`,
    );
    const self = {
      instanceId: client.instanceId,
      user: { id: "profile-self", identity: owners[0]!.identity, name: "Self" },
      lastActivityAt: Date.now(),
    };
    const ada = {
      instanceId: "ada-instance",
      user: { id: "profile-ada", identity: owners[1]!.identity, name: "Ada" },
      lastActivityAt: Date.now() - 5000,
    };
    await publishPresence([self, ada]);
    const dot = () => section("ada").querySelector(".sidebar-session-group-presence");
    const personButton = section("ada").querySelector<HTMLButtonElement>("[data-person-card]")!;
    expect(dot()?.getAttribute("aria-label")).toBe("Online · Active");
    expect(dot()?.classList.contains("sidebar-session-group-presence--idle")).toBe(false);
    expect(dot()!.id).toBeTruthy();
    expect(personButton.getAttribute("aria-describedby")).toBe(dot()!.id);
    expect(section("bob").querySelector(".sidebar-session-group-presence")).toBeNull();
    expect(section("self").querySelector(".sidebar-session-group-presence")).toBeNull();
    expect(section("self").querySelector("[data-person-card]")).toBeNull();
    expect(
      section("self").querySelector(
        ".sidebar-session-group-toggle .sidebar-recent-sessions__label-text",
      )?.textContent,
    ).toBe("self");

    const toggle = section("ada").querySelector<HTMLButtonElement>(
      ".sidebar-session-group-toggle",
    )!;
    expect(personButton?.tagName).toBe("BUTTON");
    expect(personButton.getAttribute("aria-haspopup")).toBe("dialog");
    expect(personButton.getAttribute("aria-label")).toBe("Details for ada");
    expect(personButton.previousElementSibling).toBe(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    personButton.click();
    await vi.dynamicImportSettled();
    await vi.waitFor(() => expect(activityCard()?.querySelector("h2")?.textContent).toBe("Ada"));
    const card = activityCard()!;
    expect(card.querySelector(".person-activity-card__status")?.textContent?.trim()).toBe(
      "Online · Active",
    );
    expect(personButton.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    card.querySelector<HTMLAnchorElement>("a")!.focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(activityCard()).toBeNull();
    expect(document.activeElement).toBe(personButton);
    expect(personButton.getAttribute("aria-expanded")).toBe("false");
    // A real chevron press lands outside the person button: it collapses the
    // section and dismisses an open card through the outside-pointer handling.
    personButton.click();
    await vi.waitFor(() => expect(activityCard()).not.toBeNull());
    toggle.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    toggle.click();
    await settleLitElement(sidebar);
    expect(section("ada").querySelector("[data-session-key]")).toBeNull();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(activityCard()).toBeNull();

    const bobButton = section("bob").querySelector<HTMLButtonElement>("[data-person-card]")!;
    bobButton.click();
    await vi.dynamicImportSettled();
    await vi.waitFor(() =>
      expect(activityCard()?.querySelector("h2")?.textContent).toBe(ownerName),
    );
    await activityReady;
    await settleLitElement(sidebar);
    const offlineCard = activityCard()!;
    expect(
      offlineCard.querySelector(".person-activity-card__status--offline")?.textContent?.trim(),
    ).toBe("Offline");
    expect(offlineCard.querySelector("dl")).toBeNull();
    const recent = offlineCard.querySelector("section")!;
    expect(recent.querySelector("h3")?.textContent).toBe("Recent sessions");
    expect(recent.querySelector("a")?.getAttribute("href")).toBe(`/chat/main/${ownerId}`);
    expect(offlineCard.querySelector("footer a")?.getAttribute("href")).toBe(
      `/activity/${ownerId}`,
    );
    bobButton.click();
    expect(activityCard()).toBeNull();
    bobButton.focus();
    await vi.waitFor(() =>
      expect(activityCard()?.querySelector("h2")?.textContent).toBe(ownerName),
    );
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    await publishPresence([self, { ...ada, lastActivityAt: Date.now() - 600000 }]);
    expect(dot()?.classList.contains("sidebar-session-group-presence--idle")).toBe(true);
    expect(dot()?.getAttribute("aria-label")).toBe("Online · Idle");
    expect(personButton.getAttribute("aria-describedby")).toBe(dot()!.id);

    await publishPresence([self, { ...ada, reason: "disconnect" }]);
    expect(dot()).toBeNull();
    expect(personButton.hasAttribute("aria-describedby")).toBe(false);
    expect(
      section("ada").querySelector(".sidebar-session-group-toggle__person")?.hasAttribute("title"),
    ).toBe(false);
  });

  it("shows all online identities with active-first ordering and idle dimming", async () => {
    const {
      sidebar,
      gateway: gatewayHarness,
      dom,
      publishPresence,
    } = await mountOnlineSidebar(
      createGatewayHarness({ instanceId: "self-instance" } as GatewayBrowserClient),
      createSessions("main", ["agent:main:main"]),
    );
    sidebar.connected = true;
    const onNavigate = vi.fn();
    sidebar.onNavigate = onNavigate;

    expect(dom.query(".sidebar-online__person")).toBeNull();
    await publishPresence([
      viewer("self", { instanceId: "self-instance", lastActivityAt: Date.now(), ts: 1 }),
    ]);
    expect(dom.all(".sidebar-online__person")).toHaveLength(1);
    expect(dom.query('[data-online-user-id="self"]')).not.toBeNull();

    gatewayHarness.publishEvent("presence", {
      presence: [
        viewer("self", { instanceId: "self-instance", lastActivityAt: Date.now(), ts: 1 }),
        viewer("zed", { instanceId: "zed-instance", lastActivityAt: Date.now() - 20000, ts: 1 }),
        viewer(
          "alice",
          { instanceId: "alice-instance", lastActivityAt: Date.now() - 600000, ts: 1 },
          { identity: { type: "profile", id: "alice" } },
        ),
        viewer("bob", { instanceId: "bob-instance", ts: 1 }),
      ],
    });

    await vi.waitFor(() => {
      const rows = [...dom.all<HTMLElement>(".sidebar-online__person")];
      expect(
        rows.map((row) => row.querySelector(".sidebar-online__person-name")?.textContent?.trim()),
      ).toEqual(["Self", "Zed", "Alice", "Bob"]);
      expect(rows.map((row) => row.dataset.presenceActivity)).toEqual([
        "active",
        "active",
        "idle",
        "unknown",
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
    expect(aliceRow.tagName).toBe("A");
    expect(aliceRow.getAttribute("href")).toBe("/activity/alice");
    expect(aliceRow.closest(".sidebar-online__row")?.querySelectorAll("a")).toHaveLength(1);
    expect(
      aliceRow.closest(".sidebar-online__row")?.querySelector('button[aria-label="Pin"]'),
    ).not.toBeNull();
    expect(activityCard()).toBeNull();

    focusSidebarPersonWithKeyboard(aliceRow);
    await vi.dynamicImportSettled();
    await vi.waitFor(() => expect(activityCard()).not.toBeNull());
    aliceRow.querySelector<HTMLElement>(".sidebar-online__person-name")!.click();
    await vi.dynamicImportSettled();
    expect(onNavigate).toHaveBeenCalledTimes(2);
    expect(activityCard()).toBeNull();

    const bobRow = dom.query<HTMLButtonElement>('[data-online-user-id="bob"]')!;
    expect(bobRow.tagName).toBe("BUTTON");
    bobRow.click();
    await vi.waitFor(() => expect(activityCard()?.querySelector("h2")?.textContent).toBe("Bob"));
    expect(onNavigate).toHaveBeenCalledTimes(2);
  });

  it("keeps the active identity and focused session link across presence reordering", async () => {
    const gateway = createGatewayHarness({ instanceId: "self" } as GatewayBrowserClient);
    const sessions = createSessionsHarness("main", ["agent:main:work"]);
    const result = sessions.sessions.state.result!;
    result.sessions[0]!.createdActor = {
      type: "human",
      id: "alice",
      identity: { type: "profile", id: "alice" },
    };
    sessions.publishList({ result });
    const { sidebar, dom, publishPresence } = await mountOnlineSidebar(gateway, sessions.sessions);
    sidebar.connected = true;
    const now = Date.now();
    const alice = {
      ts: now,
      user: { id: "alice", identity: aliceIdentity, name: "Alice" },
      watchedSessions: ["agent:main:work"],
      onlineSince: now - 60_000,
      lastActivityAt: now - 10_000,
    };
    const bob = { ts: now, user: { id: "bob", name: "Bob" }, lastActivityAt: Date.now() };
    await publishPresence([alice, bob]);
    const button = dom.query<HTMLAnchorElement>('[data-online-user-id="alice"]')!;
    focusSidebarPersonWithKeyboard(button);
    await vi.dynamicImportSettled();
    await vi.waitFor(() => expect(activityCard()).not.toBeNull());
    const card = activityCard()!;
    await vi.waitFor(() =>
      expect(card.querySelector(".person-activity-card__status")?.textContent?.trim()).toBe(
        "Online for 1m · Active",
      ),
    );
    const sessionLink = card.querySelector<HTMLAnchorElement>(".person-activity-card__session")!;
    sessionLink.focus();
    await publishPresence([{ ...alice, lastActivityAt: now - 600_000 }, bob]);
    expect(dom.query('[data-online-user-id="alice"]')).toBe(button);
    expect(dom.attr(".sidebar-online__person", "data-online-user-id")).toBe("bob");
    expect(card.querySelector("h2")?.textContent).toBe("Alice");
    expect(document.activeElement).toBe(sessionLink);
    expect(card.querySelector("time")?.getAttribute("datetime")).toBe(
      new Date(alice.onlineSince).toISOString(),
    );
    await publishPresence([{ ...alice, watchedSessions: [] }, bob]);
    expect([...card.querySelectorAll("h3")].map((heading) => heading.textContent)).toEqual([
      "Recent sessions",
    ]);
    // The initially empty recent selection cannot admit a new link mid-open,
    // even when it leaves Viewing now. Reopening takes a fresh selection.
    expect(card.querySelector(".person-activity-card__session")).toBeNull();
    expect(document.activeElement).toBe(button);
    button.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    button.blur();
    button.focus();
    await settleLitElement(sidebar);
    const recentLink = document.querySelector<HTMLAnchorElement>(".person-activity-card__session")!;
    expect(recentLink.getAttribute("href")).toBe(sessionLink.getAttribute("href"));
    expect(recentLink.closest("section")?.querySelector("h3")?.textContent).toBe("Recent sessions");
  });

  it("expires activity when the deadline passes during rendering", async () => {
    const { sidebar, gateway, dom, publishPresence } = await mountOnlineSidebar();
    sidebar.connected = true;
    vi.useFakeTimers();
    const now = Date.now();
    const project = presenceUsers.presenceViewerActivity;
    gateway.publishEvent("presence", {
      presence: [{ user: { id: "alice", name: "Alice" }, ts: now, lastActivityAt: now - 119_999 }],
    });
    // Event admission may read activity too; advance the clock only in the queued render.
    vi.spyOn(presenceUsers, "presenceViewerActivity").mockImplementationOnce((user) => {
      const state = project(user);
      vi.setSystemTime(now + 2);
      return state;
    });
    await sidebar.updateComplete;
    const row = dom.query<HTMLElement>('[data-online-user-id="alice"]')!;
    expect(row.dataset.presenceActivity).toBe("active");
    await vi.advanceTimersByTimeAsync(2);
    await settleLitElement(sidebar);
    expect(row.dataset.presenceActivity).toBe("idle");
    await publishPresence([
      { user: { id: "alice", name: "Alice" }, ts: Date.now(), lastActivityAt: Date.now() },
    ]);
    expect(row.dataset.presenceActivity).toBe("active");
  });

  it("ages rows and an open card into idle without another presence event", async () => {
    const { sidebar, provider, dom, publishPresence } = await mountOnlineSidebar();
    sidebar.connected = true;
    vi.useFakeTimers();
    const person = {
      user: { id: "alice", name: "Alice" },
      onlineSince: Date.now() - 300_000,
      lastActivityAt: Date.now() - 119_000,
    };
    await publishPresence([person]);
    const row = dom.query<HTMLElement>('[data-online-user-id="alice"]')!;
    row.click();
    await vi.dynamicImportSettled();
    const card = activityCard()!;
    expect(row.dataset.presenceActivity).toBe("active");
    await vi.advanceTimersByTimeAsync(1_000);
    await settleLitElement(sidebar);
    expect(row.dataset.presenceActivity).toBe("idle");
    expect(card.querySelector(".person-activity-card__status")?.textContent).toContain("Idle");
    expect(card.textContent).toContain("Online for");
    await publishPresence([{ ...person, lastActivityAt: Date.now() }]);
    expect(row.dataset.presenceActivity).toBe("active");
    provider.remove();
    await Promise.resolve();
    flush();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["disconnect", "switch", "route", "collapse", "shell", "remove", "teardown"] as const)(
    "dismisses and releases card timers on %s",
    async (reason) => {
      const { sidebar, provider, gateway, dom, publishPresence } = await mountOnlineSidebar();
      sidebar.connected = true;
      const person = {
        ts: Date.now(),
        user: { id: "alice", identity: aliceIdentity, name: "Alice" },
        onlineSince: Date.now() - 90_000,
      };
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
      if (reason === "disconnect") {
        gateway.publish({ phase: "reconnecting" });
      }
      if (reason === "switch") {
        gateway.publish({ client: createTestGatewayClient(async () => ({ profiles: [] })) });
      }
      if (reason === "route") {
        sidebar.activeRouteId = "activity";
      }
      if (reason === "shell") {
        sidebar.dismissTransientMenus();
      }
      if (reason === "collapse") {
        await selectSidebarView(sidebar, "sessions");
      }
      if (reason === "remove") {
        gateway.publishEvent("presence", { presence: [{ ...person, reason: "disconnect" }] });
      }
      if (reason === "teardown") {
        provider.remove();
      }
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
        expect(activityCard()?.querySelector("h2")?.textContent).toBe("Alice");
      }
    },
  );

  it("keeps explicitly selected Online expanded despite a legacy collapsed-section preference", async () => {
    localStorage.setItem(
      "openclaw:sidebar:sessions:collapsed-sections",
      JSON.stringify(["online"]),
    );
    const { sidebar, dom, publishPresence } = await mountOnlineSidebar(
      createGatewayHarness({ instanceId: "self-instance" } as GatewayBrowserClient),
      createSessions("main", ["agent:main:main"]),
    );

    await publishPresence([
      viewer("self", { instanceId: "self-instance" }),
      viewer(
        "alice",
        { instanceId: "alice-instance" },
        { identity: { type: "profile", id: "alice" } },
      ),
      ...["bob", "carol", "dave"].map((id) => viewer(id, { instanceId: `${id}-instance` })),
    ]);

    expect(dom.attr('[data-navigation-view="online"]', "aria-pressed")).toBe("true");
    expect(dom.query(".sidebar-online__list")).not.toBeNull();
    expect(dom.all(".sidebar-online__person")).toHaveLength(5);
    expect(localStorage.getItem("openclaw:sidebar:sessions:collapsed-sections")).toBe(
      JSON.stringify(["online"]),
    );
    await selectSidebarView(sidebar, "sessions");
    expect(dom.query(".sidebar-online")).toBeNull();
    await selectSidebarView(sidebar, "online");
    expect(dom.all(".sidebar-online__person")).toHaveLength(5);
  });

  it("groups identified viewers for session rows and keeps the footer identity-only", async () => {
    const client = { instanceId: "self-instance" } as GatewayBrowserClient;
    const gatewayHarness = createGatewayHarness(client);
    const { sidebar } = await mountSidebar(
      gatewayHarness.gateway,
      createSessions("main", ["agent:main:main", "agent:main:work"]),
    );
    const dom = domProbe(sidebar);
    const publishPresence = presencePublisher(sidebar, gatewayHarness);
    sidebar.connected = true;
    const selfUser = {
      id: "00-self",
      name: "Self User",
      avatarUrl: "/api/users/00-self/avatar?v=1",
    };
    const watchedSessions = ["agent:main:work"];
    await publishPresence([
      { instanceId: "self-instance", user: selfUser, watchedSessions },
      viewer(
        "alice",
        { instanceId: "alice-1", watchedSessions },
        { identity: aliceIdentity, avatarUrl: "/api/users/alice/avatar" },
      ),
      viewer(
        "alice",
        { instanceId: "alice-2", watchedSessions: ["agent:main:main"] },
        { identity: aliceIdentity },
      ),
      viewer(
        "bob",
        { instanceId: "bob-1", watchedSessions },
        { name: undefined, email: "bob@example.test" },
      ),
      ...["carol", "dave", "erin", "frank"].map((id) =>
        viewer(id, { instanceId: `${id}-1`, watchedSessions }),
      ),
      { instanceId: "anonymous-1", watchedSessions },
      viewer(
        "offline",
        { instanceId: "offline-1", reason: "disconnect", watchedSessions },
        { name: "Offline User" },
      ),
    ]);
    gatewayHarness.publish({ selfUser });
    sidebar.setSessionOwnerFilter(null);
    await settleLitElement(sidebar);

    const sessionFacepile = dom.query<HTMLElement>(
      '[data-session-key="agent:main:work"] openclaw-viewer-facepile',
    );
    await (sessionFacepile as { updateComplete?: Promise<unknown> } | null)?.updateComplete;
    expect(
      sessionFacepile?.querySelector(".viewer-facepile")?.getAttribute("data-viewer-count"),
    ).toBe("6");
    expect(
      [...(sessionFacepile?.querySelectorAll<HTMLElement>("[data-viewer-id]") ?? [])].map(
        (avatar) => avatar.dataset.viewerId,
      ),
    ).toEqual(["alice", "bob", "carol"]);
    expect(sessionFacepile?.querySelector(".viewer-avatar--overflow")?.textContent).toContain("+3");
    expect(sessionFacepile?.querySelector('[data-viewer-id="alice"] img')).not.toBeNull();
    expect(
      [...(sessionFacepile?.querySelectorAll("openclaw-tooltip") ?? [])].map(
        (tooltip) => (tooltip as HTMLElement & { content?: string }).content,
      ),
    ).toEqual(["Alice", "bob@example.test", "Carol", "Dave\nErin\nFrank"]);

    const identityCard = dom.query<HTMLButtonElement>(".sidebar-identity-card");
    expect(identityCard?.querySelector(".sidebar-identity-card__name")?.textContent?.trim()).toBe(
      "Self User",
    );
    expect(identityCard?.querySelector('[data-viewer-id="00-self"]')).not.toBeNull();

    const avatar = identityCard?.querySelector<HTMLImageElement>("openclaw-viewer-avatar img");
    expect(avatar?.getAttribute("src")).toBe("/api/users/00-self/avatar?v=1");
    const footer = dom.query(".sidebar-footer-bar");
    expect(footer?.querySelector("openclaw-viewer-facepile")).toBeNull();
    expect(footer?.querySelector("openclaw-sidebar-build-chip")).toBeNull();
    expect(footer?.querySelector(".sidebar-brand__logo-slot")).toBeNull();
    gatewayHarness.gateway.updateSelfUser?.({
      name: "Augusta Ada",
      avatarUrl: "/api/users/00-self/avatar?v=4",
    });
    await settleLitElement(sidebar);

    expect(identityCard?.querySelector(".sidebar-identity-card__name")?.textContent?.trim()).toBe(
      "Augusta Ada",
    );
    expect(avatar?.getAttribute("src")).toBe("/api/users/00-self/avatar?v=4");

    sidebar.connected = false;
    await settleLitElement(sidebar);
    expect(dom.text(".sidebar-identity-card__name")?.trim()).toBe("Augusta Ada");
  });

  it.each([
    undefined,
    { id: "owner-profile", identity: { type: "profile" as const, id: "owner-profile" } },
  ])("renders an Owner fallback without a name or email (%j)", async (user) => {
    const client = { instanceId: "anonymous-self" } as GatewayBrowserClient;
    const gatewayHarness = createGatewayHarness(client);
    const { sidebar } = await mountSidebar(
      gatewayHarness.gateway,
      createSessions("main", ["agent:main:main"]),
    );
    const dom = domProbe(sidebar);
    const publishPresence = presencePublisher(sidebar, gatewayHarness);

    gatewayHarness.publish({ selfUser: user ?? null });
    await publishPresence([
      { instanceId: "anonymous-self", user, watchedSessions: ["agent:main:main"] },
      {
        instanceId: "alice",
        user: { id: "alice", identity: aliceIdentity, name: "Alice" },
      },
    ]);

    const identityCard = dom.query(".sidebar-identity-card");
    expect(identityCard?.querySelector(".sidebar-identity-card__name")?.textContent?.trim()).toBe(
      "Owner",
    );
    expect(
      identityCard?.querySelector(`[data-viewer-id="${user?.id ?? "owner"}"]`)?.textContent,
    ).toContain("O");
  });
});
