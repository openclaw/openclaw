/* @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { normalizeSidebarEntries } from "../app-navigation.ts";
import * as toast from "../lib/toast.ts";
import {
  createGatewayHarness,
  createSessionsHarness,
  mountSidebar,
  TWO_AGENTS,
} from "../test-helpers/app-sidebar.ts";
import "../test-helpers/app-sidebar-suite.ts";
import { createDataTransferStub } from "../test-helpers/drag-data.ts";
import { gatewayHelloForMethods } from "../test-helpers/gateway-methods.ts";
import "./app-sidebar.tsx";

async function fixture() {
  const gateway = createGatewayHarness({} as GatewayBrowserClient);
  gateway.publish({ selfUser: { id: "self", name: "Self" } });
  const sessions = createSessionsHarness("main", [
    "agent:main:main",
    "agent:main:mine",
    "agent:main:other",
  ]);
  const result = sessions.sessions.state.result!;
  result.owners = [
    { type: "human", id: "self", label: "Self" },
    { type: "human", id: "other", label: "Other" },
  ];
  for (const row of result.sessions) {
    row.owner = {
      actor: { type: "human", id: row.key.endsWith(":mine") ? "self" : "other" },
    };
  }
  const { sidebar } = await mountSidebar(gateway.gateway, sessions.sessions);
  sidebar.connected = true;
  sidebar.sidebarEntries = [];
  sidebar.onUpdateSidebarEntries = (entries) => {
    sidebar.sidebarEntries = entries;
  };
  await sidebar.updateComplete;
  return { sidebar, sessions, gateway, result };
}

function drag(target: Element, type: string, transfer: ReturnType<typeof createDataTransferStub>) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, { dataTransfer: { value: transfer }, clientY: { value: 0 } });
  target.dispatchEvent(event);
  return event;
}

describe("personal navigation rail", () => {
  it("keeps fixed navigation and Home, Inbox, identity separate from the middle view", async () => {
    const { sidebar } = await fixture();
    expect(
      [...sidebar.querySelectorAll("[data-navigation-view]")].map((button) =>
        button.getAttribute("aria-label"),
      ),
    ).toEqual(["Pages", "Sessions", "Online"]);
    const frame = sidebar.querySelector("aside.sidebar")!;
    const bottom = sidebar.querySelector(".sidebar-rail__bottom")!;
    expect(bottom.querySelector(".sidebar-footer-bar__home")).not.toBeNull();
    expect(bottom.querySelector("openclaw-sidebar-attention")).not.toBeNull();
    expect(bottom.querySelector(".sidebar-identity-card")).not.toBeNull();
    expect(sidebar.querySelector(".nav-item--home")).toBeNull();
    expect(sidebar.querySelector(".sidebar-shell__footer .sidebar-identity-card")).toBeNull();
    sidebar.querySelector<HTMLButtonElement>('[data-navigation-view="pages"]')!.click();
    await sidebar.updateComplete;
    expect(sidebar.querySelector(".sidebar-pages")).not.toBeNull();
    expect(sidebar.querySelector(".sidebar-session-content")).toBeNull();
    expect(sidebar.querySelector("aside.sidebar")).toBe(frame);
    expect(sidebar.querySelector(".sidebar-rail__bottom")).toBe(bottom);
  });

  it("keeps main activity visible on Home when the middle list is collapsed", async () => {
    const { sidebar, result, sessions } = await fixture();
    const mainIndex = result.sessions.findIndex((row) => row.key === "agent:main:main");
    sessions.publishList({
      agentId: "main",
      result: {
        ...result,
        sessions: result.sessions.with(mainIndex, {
          ...result.sessions[mainIndex]!,
          status: "running",
          hasActiveRun: true,
        }),
      },
    });
    sidebar.navigationCollapsed = true;
    sidebar.requestUpdate();
    await sidebar.updateComplete;
    expect(sidebar.querySelector(".sidebar-footer-bar__home .session-glyph__ring")).not.toBeNull();
    expect(
      sidebar
        .querySelector(".sidebar-footer-bar__home .session-glyph__ring")
        ?.getAttribute("aria-label"),
    ).toBe("Active run");
  });

  it("keeps Home outbox attention and drafts visible with its run state", async () => {
    const { sidebar, result, sessions } = await fixture();
    const mainIndex = result.sessions.findIndex((row) => row.key === "agent:main:main");
    sessions.publishList({
      agentId: "main",
      result: {
        ...result,
        sessions: result.sessions.with(mainIndex, {
          ...result.sessions[mainIndex]!,
          hasActiveRun: true,
          status: "running",
        }),
      },
    });
    sidebar.storedOutboxes = {
      total: 2,
      attentionCountForSession: (key) => (key === "agent:main:main" ? 2 : 0),
      hasSessionDraft: (key) => key === "agent:main:main",
    };
    await sidebar.updateComplete;
    const home = sidebar.querySelector(".sidebar-footer-bar__home")!;
    expect(home.querySelector(".session-glyph__ring")).not.toBeNull();
    expect(
      home.querySelector(".session-row-badge--attention")?.getAttribute("aria-label"),
    ).toContain("2");
    expect(home.querySelector(".session-row-badge--draft")).not.toBeNull();
    sidebar.storedOutboxes = {
      total: 0,
      attentionCountForSession: () => 0,
      hasSessionDraft: () => false,
    };
    await sidebar.updateComplete;
    expect(home.querySelector(".session-row-badge--attention")).toBeNull();
    expect(home.querySelector(".session-row-badge--draft")).toBeNull();
    expect(home.querySelector(".session-glyph__ring")).not.toBeNull();
  });

  it("pins and unpins sessions personally without sessions.patch", async () => {
    const { sidebar, sessions } = await fixture();
    const pin = sidebar.querySelector<HTMLButtonElement>(
      '[data-session-key="agent:main:mine"] [data-sidebar-session-pin]',
    );
    expect(pin).not.toBeNull();
    pin!.click();
    await sidebar.updateComplete;
    expect(sidebar.sidebarEntries).toEqual(["session:agent:main:mine"]);
    expect(pin!.closest(".session-row-host")?.classList.contains("session-row-host--pinned")).toBe(
      true,
    );
    expect(
      sidebar.querySelector('.sidebar-rail [data-sidebar-entry="session:agent:main:mine"]'),
    ).not.toBeNull();
    expect(sessions.sessions.patch).not.toHaveBeenCalled();
    pin!.click();
    await sidebar.updateComplete;
    expect(sidebar.sidebarEntries).toEqual([]);
    expect(pin!.closest(".session-row-host")?.classList.contains("session-row-host--pinned")).toBe(
      false,
    );
    expect(sessions.sessions.patch).not.toHaveBeenCalled();
  });

  it("adds a session to an empty rail and shows the drop affordance only during its drag", async () => {
    const { sidebar, sessions, result } = await fixture();
    sessions.publishList({
      agentId: "main",
      result: {
        ...result,
        sessions: result.sessions.map((row) =>
          row.key === "agent:main:mine" ? Object.assign({}, row, { label: "Release Notes" }) : row,
        ),
      },
    });
    await sidebar.updateComplete;
    const pins = sidebar.querySelector(".sidebar-rail__pins")!;
    expect(pins.children).toHaveLength(0);
    expect(pins.classList.contains("sidebar-rail__pins--drag-active")).toBe(false);
    const unrelated = createDataTransferStub();
    unrelated.setData("text/plain", "not a sidebar item");
    expect(drag(pins, "dragover", unrelated).defaultPrevented).toBe(false);
    await sidebar.updateComplete;
    expect(pins.classList.contains("sidebar-rail__pins--drag-active")).toBe(false);

    const source = sidebar.querySelector('[data-session-key="agent:main:mine"]')!;
    const transfer = createDataTransferStub();
    drag(source, "dragstart", transfer);
    await sidebar.updateComplete;
    expect(pins.classList.contains("sidebar-rail__pins--drag-active")).toBe(true);
    expect(drag(pins, "dragover", transfer).defaultPrevented).toBe(true);
    drag(pins, "drop", transfer);
    await sidebar.updateComplete;
    expect(sidebar.sidebarEntries).toEqual(["session:agent:main:mine"]);
    expect(
      pins.querySelector('[aria-label="Release Notes"] .sidebar-rail__monogram')?.textContent,
    ).toBe("RN");
    expect(pins.classList.contains("sidebar-rail__pins--drag-active")).toBe(false);
    expect(sessions.sessions.patch).not.toHaveBeenCalled();
    const pin = pins.querySelector(".sidebar-rail__pin")!;
    drag(pin, "dragstart", transfer);
    await sidebar.updateComplete;
    expect(pins.classList.contains("sidebar-rail__pins--drag-active")).toBe(true);
    drag(pin, "dragend", transfer);
    await sidebar.updateComplete;
    expect(pins.classList.contains("sidebar-rail__pins--drag-active")).toBe(false);
  });

  it.each([
    { label: "Release Notes", icon: undefined, monogram: "RN" },
    { label: "Résumé", icon: undefined, monogram: "R" },
    { label: "Launch Pad", icon: "🚀", monogram: undefined },
    {
      label: "Architecture",
      icon: `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/></svg>')}`,
      monogram: undefined,
    },
  ])("uses the session artwork or title initials for $label", async ({ label, icon, monogram }) => {
    const { sidebar, sessions, result } = await fixture();
    sessions.publishList({
      agentId: "main",
      result: {
        ...result,
        sessions: result.sessions.map((row) =>
          row.key === "agent:main:mine" ? Object.assign({}, row, { label, icon }) : row,
        ),
      },
    });
    sidebar.sidebarEntries = ["session:agent:main:mine"];
    await sidebar.updateComplete;
    const pin = sidebar.querySelector(
      '.sidebar-rail [data-sidebar-entry="session:agent:main:mine"]',
    )!;
    expect(pin.querySelector("a")?.getAttribute("aria-label")).toBe(label);
    expect(pin.querySelector("openclaw-tooltip")?.content).toBe(label);
    expect(pin.querySelector(".sidebar-rail__monogram")?.textContent).toBe(monogram);
    if (icon?.startsWith("data:")) {
      expect(pin.querySelector(".session-glyph__icon img")?.getAttribute("src")).toBe(icon);
    } else {
      expect(pin.querySelector(".session-glyph__emoji")?.textContent).toBe(icon);
    }
    expect(pin.querySelector("svg")).toBeNull();
    expect(pin.querySelector(".session-owner-chip")).toBeNull();
  });

  it("keeps a session shortcut's identity with only running and unread decorations", async () => {
    const { sidebar, sessions, result } = await fixture();
    const key = "agent:main:mine";
    sessions.publishList({
      agentId: "main",
      result: {
        ...result,
        sessions: result.sessions.map((row) =>
          row.key === key
            ? Object.assign({}, row, {
                label: "Release Notes",
                icon: "📝",
                hasActiveRun: true,
                status: "running" as const,
                unread: true,
                agentStatus: {
                  note: "Waiting for input",
                  attention: "key",
                  expiresAt: Date.now() + 60_000,
                },
                worktree: { id: "wt-notes", branch: "docs/notes", repoRoot: "/repo" },
              })
            : row,
        ),
      },
    });
    sessions.sessions.setPullRequestSummary(key, { numbers: [1], state: "open" });
    sidebar.storedOutboxes = {
      total: 2,
      attentionCountForSession: (sessionKey) => (sessionKey === key ? 2 : 0),
      hasSessionDraft: (sessionKey) => sessionKey === key,
    };
    sidebar.sidebarEntries = [`session:${key}`];
    await sidebar.updateComplete;
    const row = sidebar.querySelector(`[data-session-key="${key}"]`)!;
    expect(row.querySelector(".sidebar-session-attention__icon")).not.toBeNull();
    expect(row.querySelector(".session-row-badge--attention")).not.toBeNull();
    expect(row.querySelector(".session-row-badge--draft")).not.toBeNull();
    const pin = sidebar.querySelector(`.sidebar-rail [data-sidebar-entry="session:${key}"]`)!;
    expect(pin.querySelector(".session-glyph__emoji")?.textContent).toBe("📝");
    expect(pin.querySelectorAll(".session-glyph__ring")).toHaveLength(1);
    expect(pin.querySelectorAll(".session-glyph__badge--unread")).toHaveLength(1);
    expect(
      pin.querySelector(
        ".sidebar-session-attention__icon, .session-row-badges, [data-pull-request-state], .session-owner-chip",
      ),
    ).toBeNull();
  });

  it("supports native page drop, direct pin reordering, and context-menu unpin with unloaded refs retained", async () => {
    const { sidebar } = await fixture();
    sidebar.sidebarEntries = ["person:offline", "session:agent:other:unloaded"];
    sidebar.navigationView = "pages";
    await sidebar.updateComplete;
    const transfer = createDataTransferStub();
    drag(
      sidebar.querySelector('.sidebar-pages [data-sidebar-entry="route:usage"]')!,
      "dragstart",
      transfer,
    );
    drag(sidebar.querySelector(".sidebar-rail__pins")!, "drop", transfer);
    await sidebar.updateComplete;
    expect(sidebar.sidebarEntries).toEqual([
      "person:offline",
      "session:agent:other:unloaded",
      "route:usage",
    ]);
    const pin = sidebar.querySelector('.sidebar-rail [data-sidebar-entry="route:usage"]')!;
    expect(pin.querySelector(".sidebar-reorder-trigger")).toBeNull();
    const reorder = createDataTransferStub();
    drag(pin.querySelector("a")!, "dragstart", reorder);
    drag(
      sidebar.querySelector('.sidebar-rail [data-sidebar-entry="person:offline"]')!,
      "drop",
      reorder,
    );
    await sidebar.updateComplete;
    expect(sidebar.sidebarEntries).toEqual([
      "route:usage",
      "person:offline",
      "session:agent:other:unloaded",
    ]);
    await sidebar.sidebarMenus.preloadMenuRenderer();
    pin.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await sidebar.updateComplete;
    const menu = sidebar.querySelector(".sidebar-rail-pin-menu")!;
    expect(menu).not.toBeNull();
    const remove = menu.querySelector('wa-dropdown-item[value="remove"]');
    menu.dispatchEvent(new CustomEvent("wa-select", { detail: { item: remove } }));
    await sidebar.updateComplete;
    expect(sidebar.sidebarEntries).toEqual(["person:offline", "session:agent:other:unloaded"]);
  });

  it("toggles the panel from the active view and expands it when switching views", async () => {
    const { sidebar } = await fixture();
    const toggle = vi.fn(() => {
      sidebar.navigationCollapsed = !sidebar.navigationCollapsed;
    });
    sidebar.onToggleSidebar = toggle;
    const select = async (view: string) => {
      sidebar.querySelector<HTMLButtonElement>(`[data-navigation-view="${view}"]`)!.click();
      await sidebar.updateComplete;
    };
    await select("sessions");
    expect(sidebar.navigationCollapsed).toBe(true);
    await select("sessions");
    expect(sidebar.navigationCollapsed).toBe(false);
    await select("pages");
    expect(sidebar.navigationView).toBe("pages");
    expect(sidebar.navigationCollapsed).toBe(false);
    await select("pages");
    expect(sidebar.navigationCollapsed).toBe(true);
    await select("online");
    expect(sidebar.navigationView).toBe("online");
    expect(sidebar.navigationCollapsed).toBe(false);
    expect(toggle).toHaveBeenCalledTimes(4);
  });

  it("preserves a mobile drawer when a stored desktop preference is collapsed", async () => {
    const { sidebar } = await fixture();
    vi.spyOn(globalThis, "matchMedia").mockReturnValue({
      media: "",
      matches: true,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent: () => true,
    });
    sidebar.navigationCollapsed = true;
    const toggle = vi.fn();
    sidebar.onToggleSidebar = toggle;
    await sidebar.updateComplete;
    for (const view of ["sessions", "pages"]) {
      sidebar.querySelector<HTMLButtonElement>(`[data-navigation-view="${view}"]`)!.click();
      await sidebar.updateComplete;
    }
    expect(sidebar.navigationView).toBe("pages");
    expect(toggle).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "collapses shortcut navigation only on desktop (mobile: %s)",
    async (mobile) => {
      vi.spyOn(globalThis, "matchMedia").mockImplementation((query) => ({
        media: query,
        matches: query.includes("max-width") ? mobile : false,
        onchange: null,
        addListener() {},
        removeListener() {},
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent: () => true,
      }));
      const { sidebar, gateway } = await fixture();
      gateway.publish({
        hello: {
          ...gatewayHelloForMethods(["chat.history", "chat.send"]),
          controlUiTabs: [
            {
              group: "control",
              id: "logbook",
              label: "Logbook",
              pluginId: "logbook",
              slug: "logbook",
            },
          ],
        },
      });
      sidebar.sidebarEntries = [
        "session:agent:main:mine",
        "route:usage",
        "person:other",
        "plugin:logbook/logbook",
      ];
      const toggle = vi.fn(() => {
        sidebar.navigationCollapsed = !sidebar.navigationCollapsed;
      });
      sidebar.onToggleSidebar = toggle;
      await sidebar.updateComplete;
      for (const selector of [
        '[data-sidebar-entry="session:agent:main:mine"] a',
        '[data-sidebar-entry="route:usage"] a',
        '[data-sidebar-entry="person:other"] a',
        '[data-sidebar-entry="plugin:logbook/logbook"] a',
        ".sidebar-footer-bar__home",
      ]) {
        sidebar.navigationCollapsed = false;
        await sidebar.updateComplete;
        const shortcut = sidebar.querySelector<HTMLElement>(`.sidebar-rail ${selector}`);
        expect(shortcut).not.toBeNull();
        shortcut!.click();
        await sidebar.updateComplete;
        expect(sidebar.navigationCollapsed, selector).toBe(!mobile);
      }
      expect(toggle).toHaveBeenCalledTimes(mobile ? 0 : 5);
    },
  );

  it("opens the existing agent menu from the named avatar at the top of the rail", async () => {
    const gateway = createGatewayHarness({} as GatewayBrowserClient);
    const sessions = createSessionsHarness("main", ["agent:main:main"]);
    const { sidebar } = await mountSidebar(gateway.gateway, sessions.sessions, "panel", TWO_AGENTS);
    const agent = sidebar.querySelector<HTMLButtonElement>(
      ".sidebar-rail .sidebar-agent-card__main",
    );
    expect(agent).not.toBeNull();
    expect(agent?.getAttribute("aria-label")).toContain("Molty");
    agent!.click();
    await vi.dynamicImportSettled();
    await sidebar.updateComplete;
    expect(sidebar.querySelector(".sidebar-agent-menu")).not.toBeNull();
    expect(sidebar.querySelector('[value="agent:research"]')).not.toBeNull();
    expect(sidebar.querySelector(".sidebar-brand")).toBeNull();
  });

  it("pins a person with native drag and retains a safe destination after they go offline", async () => {
    const { sidebar } = await fixture();
    sidebar.querySelector<HTMLButtonElement>('[data-navigation-view="online"]')!.click();
    sidebar.sessionData.presencePayload = {
      presence: [
        {
          ts: Date.now(),
          user: { id: "other", name: "Other", identity: { type: "profile", id: "other" } },
        },
      ],
    };
    await sidebar.updateComplete;
    const transfer = createDataTransferStub();
    const collapse = sidebar.querySelector<HTMLButtonElement>(
      ".sidebar-online .sidebar-session-group-toggle",
    )!;
    collapse.click();
    await sidebar.updateComplete;
    expect(sidebar.querySelector(".sidebar-online__row")).toBeNull();
    collapse.click();
    await sidebar.updateComplete;
    drag(sidebar.querySelector(".sidebar-online__row")!, "dragstart", transfer);
    drag(sidebar.querySelector(".sidebar-rail__pins")!, "drop", transfer);
    await sidebar.updateComplete;
    expect(sidebar.sidebarEntries).toEqual(["person:other"]);
    sidebar.sessionData.presencePayload = { presence: [] };
    sidebar.requestUpdate();
    await sidebar.updateComplete;
    const person = sidebar.querySelector<HTMLAnchorElement>(
      '.sidebar-rail [data-sidebar-entry="person:other"] a',
    )!;
    expect(person).not.toBeNull();
    const navigate = vi.fn();
    sidebar.onNavigate = navigate;
    person.click();
    expect(navigate).toHaveBeenCalledWith(
      "activity",
      expect.objectContaining({ pathname: expect.stringContaining("activity") }),
    );
  });

  it("opens a pinned dashboard on its saved face instead of forcing chat", async () => {
    const { sidebar, result } = await fixture();
    result.sessions.find((row) => row.key === "agent:main:mine")!.boardFace = "dashboard";
    sidebar.sidebarEntries = ["session:agent:main:mine"];
    sidebar.requestUpdate();
    await sidebar.updateComplete;
    const navigate = vi.fn();
    sidebar.onNavigate = navigate;
    sidebar
      .querySelector<HTMLAnchorElement>(
        '.sidebar-rail [data-sidebar-entry="session:agent:main:mine"] a',
      )!
      .click();
    expect(navigate).toHaveBeenCalledWith(
      "dashboard",
      expect.objectContaining({ pathname: expect.stringContaining("dashboard") }),
    );
  });

  it("resolves an unloaded pinned session once and uses its real label, icon, and navigation", async () => {
    const { sidebar, sessions, result } = await fixture();
    const key = "agent:other:unloaded";
    const pending = createDeferred<Awaited<ReturnType<typeof sessions.sessions.describe>>>();
    const describeRead = vi.spyOn(sessions.sessions, "describe").mockReturnValue(pending.promise);
    const navigate = vi.fn();
    sidebar.onNavigate = navigate;
    sidebar.sidebarEntries = [`session:${key}`];
    await sidebar.updateComplete;
    expect(sidebar.querySelector(`.sidebar-rail [data-sidebar-entry="session:${key}"]`)).toBeNull();
    expect(describeRead).toHaveBeenCalledExactlyOnceWith({ key });
    sidebar.requestUpdate();
    await sidebar.updateComplete;
    expect(describeRead).toHaveBeenCalledTimes(1);
    pending.resolve({
      session: { ...result.sessions[1]!, key, label: "Release notes", icon: "📝" },
    });
    await pending.promise;
    await sidebar.updateComplete;
    const link = sidebar.querySelector<HTMLAnchorElement>(
      `.sidebar-rail [data-sidebar-entry="session:${key}"] a`,
    )!;
    expect(link.getAttribute("aria-label")).toBe("Release notes");
    expect(link.querySelector(".session-glyph__emoji")?.textContent).toBe("📝");
    expect(link.getAttribute("href")).toContain("unloaded");
    expect(navigate).not.toHaveBeenCalled();
    link.click();
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(describeRead).toHaveBeenCalledTimes(1);
    // Once the authoritative row loads, it wins over the scoped descriptor snapshot.
    sessions.publishList({
      agentId: "main",
      result: {
        ...result,
        sessions: [
          ...result.sessions,
          { ...result.sessions[1]!, key, label: "Current title", icon: "🚀" },
        ],
      },
    });
    await sidebar.updateComplete;
    expect(
      sidebar
        .querySelector(`.sidebar-rail [data-sidebar-entry="session:${key}"] a`)
        ?.getAttribute("aria-label"),
    ).toBe("Current title");
  });

  it("retains a lookup across a synchronous host move within the same connection", async () => {
    const { sidebar, sessions, result } = await fixture();
    const pending = createDeferred<Awaited<ReturnType<typeof sessions.sessions.describe>>>();
    const read = vi.spyOn(sessions.sessions, "describe").mockReturnValue(pending.promise);
    sidebar.sidebarEntries = ["session:agent:other:unloaded"];
    await sidebar.updateComplete;
    const parent = sidebar.parentElement!;
    sidebar.remove();
    parent.append(sidebar.hostElement);
    pending.resolve({
      session: { ...result.sessions[1]!, key: "agent:other:unloaded", label: "Detached result" },
    });
    await pending.promise;
    await sidebar.updateComplete;
    expect(read).toHaveBeenCalledTimes(1);
    expect(sidebar.querySelector('.sidebar-rail a[aria-label="Detached result"]')).not.toBeNull();
  });

  it.each(["not-found", "failure"] as const)(
    "hides %s sessions and unavailable destinations without pruning or retrying",
    async (outcome) => {
      const { sidebar, sessions } = await fixture();
      const read = vi.spyOn(sessions.sessions, "describe");
      if (outcome === "failure") {
        read.mockRejectedValue(new Error("Unavailable"));
      } else {
        read.mockResolvedValue({ session: null });
      }
      const showToast = vi.spyOn(toast, "showToast");
      const navigate = vi.fn();
      sidebar.onNavigate = navigate;
      sidebar.enabledRouteIds = ["chat"];
      const entries = ["session:agent:other:missing", "route:usage", "plugin:missing/navigation"];
      sidebar.sidebarEntries = entries;
      await sidebar.updateComplete;
      await Promise.resolve();
      sidebar.requestUpdate();
      await sidebar.updateComplete;
      expect(sidebar.querySelectorAll(".sidebar-rail__pin")).toHaveLength(0);
      expect(sidebar.sidebarEntries).toEqual(entries);
      expect(read).toHaveBeenCalledTimes(1);
      expect(showToast).not.toHaveBeenCalled();
      expect(navigate).not.toHaveBeenCalled();
    },
  );

  it.each(["success", "failure"] as const)(
    "does not publish a superseded connection lookup (%s)",
    async (outcome) => {
      const { sidebar, sessions, gateway, result } = await fixture();
      const pending = createDeferred<Awaited<ReturnType<typeof sessions.sessions.describe>>>();
      const read = vi
        .spyOn(sessions.sessions, "describe")
        .mockReturnValueOnce(pending.promise)
        .mockResolvedValue({ session: null });
      const showToast = vi.spyOn(toast, "showToast");
      const navigate = vi.fn();
      sidebar.onNavigate = navigate;
      sidebar.sidebarEntries = ["session:agent:other:unloaded"];
      await sidebar.updateComplete;
      expect(read).toHaveBeenCalledTimes(1);
      gateway.publish({ phase: "reconnecting" });
      await sidebar.updateComplete;
      gateway.publish({ phase: "connected" });
      await sidebar.updateComplete;
      if (outcome === "success") {
        pending.resolve({
          session: { ...result.sessions[1]!, key: "agent:other:unloaded", label: "Old connection" },
        });
      } else {
        pending.reject(new Error("Old connection"));
      }
      await pending.promise.catch(() => undefined);
      await sidebar.updateComplete;
      expect(read).toHaveBeenCalledTimes(2);
      expect(sidebar.querySelectorAll(".sidebar-rail__pin")).toHaveLength(0);
      expect(navigate).not.toHaveBeenCalled();
      expect(showToast).not.toHaveBeenCalled();
    },
  );

  it("does not recreate catalog observations in an update queued before removal", async () => {
    const { sidebar, sessions } = await fixture();
    const parent = sidebar.parentElement!;
    const observe = vi.spyOn(sessions.sessions, "observeList");
    const catalogQueries = () =>
      observe.mock.calls.filter(
        ([query]) => query.includeOwnerSessionCounts || query.source === "dashboard",
      );
    sidebar.navigationView = "pages";
    sidebar.remove();
    await sidebar.updateComplete;
    expect(catalogQueries()).toHaveLength(0);
    parent.append(sidebar.hostElement);
    await sidebar.updateComplete;
    expect(catalogQueries()).toHaveLength(1);
    expect(sidebar.querySelector(".sidebar-pages")).not.toBeNull();
  });

  it("stores only stable person references", () => {
    expect(
      normalizeSidebarEntries(["person:self", "person:self", "person:  ", "person:display name"]),
    ).toEqual(["person:self"]);
  });
});
