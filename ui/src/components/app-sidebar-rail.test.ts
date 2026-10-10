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
} from "../test-helpers/app-sidebar.ts";
import "../test-helpers/app-sidebar-suite.ts";
import { createDataTransferStub } from "../test-helpers/drag-data.ts";
import { gatewayHelloForMethods } from "../test-helpers/gateway-methods.ts";
import { AppSidebarSessionNavigationElement } from "./app-sidebar-session-navigation.ts";
import "./app-sidebar.ts";

async function fixture(onlySelf = false) {
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
      actor: { type: "human", id: onlySelf || row.key.endsWith(":mine") ? "self" : "other" },
    };
  }
  if (onlySelf) {
    result.totalCount = result.sessions.length;
    result.hasMore = false;
    result.ownerSessionCounts = [{ profileId: "self", open: result.sessions.length, running: 0 }];
  }
  const { sidebar } = await mountSidebar(gateway.gateway, sessions.sessions);
  if (!(sidebar instanceof AppSidebarSessionNavigationElement)) {
    throw new Error("expected sidebar");
  }
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
}

describe("personal navigation rail", () => {
  it("keeps fixed navigation and Home, Inbox, identity separate from the middle view", async () => {
    const { sidebar } = await fixture();
    expect(
      [...sidebar.querySelectorAll("[data-navigation-view]")].map((button) =>
        button.getAttribute("aria-label"),
      ),
    ).toEqual(["Pages", "Sessions", "Online"]);
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

  it("supports native page drop and menu reorder/unpin with unloaded refs retained", async () => {
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
    const menu = pin.querySelector("wa-dropdown")!;
    menu.dispatchEvent(new CustomEvent("wa-select", { detail: { item: { value: "before" } } }));
    await sidebar.updateComplete;
    expect(sidebar.sidebarEntries).toEqual([
      "person:offline",
      "route:usage",
      "session:agent:other:unloaded",
    ]);
    menu.dispatchEvent(new CustomEvent("wa-select", { detail: { item: { value: "remove" } } }));
    await sidebar.updateComplete;
    expect(sidebar.sidebarEntries).toEqual(["person:offline", "session:agent:other:unloaded"]);
  });

  it("Mine selects the human owner rather than involvement and preserves both scopes for other offline owners", async () => {
    const { sidebar, result } = await fixture();
    const persist = vi.fn();
    sidebar.onUpdateNavigationScope = persist;
    sidebar.querySelector<HTMLButtonElement>('[aria-label="Mine"]')!.click();
    await sidebar.updateComplete;
    expect(persist).toHaveBeenCalledWith("mine");
    expect(sidebar.sidebarSessionOwnerFilter()).toEqual({ ownerId: "self", involvingMe: false });
    expect(sidebar.querySelector('[data-session-key="agent:main:other"]')).toBeNull();
    expect(sidebar.querySelector('[data-session-key="agent:main:mine"]')).not.toBeNull();
    expect(sidebar.querySelector('[aria-label="All"]')).not.toBeNull();
    result.owners = undefined;
    sidebar.requestUpdate();
    await sidebar.updateComplete;
    expect(sidebar.navigationCatalog.scopesEquivalent).toBe(false);
    expect(sidebar.navigationScope).toBe("mine");
  });

  it("shows All only for resolved profileless identity without replacing saved Mine", async () => {
    const { sidebar, gateway } = await fixture();
    const persist = vi.fn();
    sidebar.navigationScope = "mine";
    sidebar.onUpdateNavigationScope = persist;
    gateway.publish({ selfUser: undefined });
    await sidebar.updateComplete;
    expect(sidebar.querySelector('[data-session-key="agent:main:mine"]')).toBeNull();
    expect(sidebar.querySelector('[data-session-key="agent:main:other"]')).toBeNull();
    gateway.publish({ selfUser: null });
    await sidebar.updateComplete;
    expect(sidebar.querySelector('[data-session-key="agent:main:mine"]')).not.toBeNull();
    expect(sidebar.querySelector('[data-session-key="agent:main:other"]')).not.toBeNull();
    expect(sidebar.querySelector('[aria-label="All"]')?.getAttribute("aria-pressed")).toBe("true");
    expect(sidebar.navigationScope).toBe("mine");
    expect(persist).not.toHaveBeenCalled();
    gateway.publish({ selfUser: { id: "self", name: "Self" } });
    await sidebar.updateComplete;
    expect(sidebar.querySelector('[data-session-key="agent:main:mine"]')).not.toBeNull();
    expect(sidebar.querySelector('[data-session-key="agent:main:other"]')).toBeNull();
    expect(sidebar.querySelector('[aria-label="Mine"]')?.getAttribute("aria-pressed")).toBe("true");
    expect(sidebar.navigationScope).toBe("mine");
    expect(persist).not.toHaveBeenCalled();
    gateway.publish({ phase: "reconnecting", selfUser: undefined });
    await sidebar.updateComplete;
    expect(sidebar.querySelector('[data-session-key="agent:main:other"]')).toBeNull();
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

  it.each(["rail", "row", "main", "home", "disconnect"] as const)(
    "retires an unloaded pin lookup after newer %s intent without requiring a route change",
    async (target) => {
      const { sidebar, sessions, gateway, result } = await fixture();
      if (target === "home") {
        gateway.publish({ hello: gatewayHelloForMethods(["chat.history", "chat.send"]) });
      }
      const selected = target === "main" ? "agent:main:main" : "agent:main:mine";
      const missing = "agent:main:unloaded";
      sidebar.sessionKey = selected;
      sidebar.activeRouteId = target === "home" ? "sessions" : "chat";
      sidebar.sidebarEntries = [`session:${selected}`, `session:${missing}`];
      await sidebar.updateComplete;
      const pending = createDeferred<Awaited<ReturnType<typeof sessions.sessions.describe>>>();
      const describeRead = vi
        .spyOn(sessions.sessions, "describe")
        .mockReturnValueOnce(pending.promise);
      const navigate = vi.fn();
      sidebar.onNavigate = navigate;
      sidebar
        .querySelector<HTMLButtonElement>(
          '.sidebar-rail [data-sidebar-entry="session:agent:main:unloaded"] button.sidebar-rail__button',
        )!
        .click();
      expect(describeRead).toHaveBeenCalledWith({ key: missing });
      if (target === "disconnect") {
        sidebar.remove();
      } else if (target === "home") {
        const home = sidebar.querySelector<HTMLButtonElement>(".sidebar-footer-bar__home")!;
        expect(home.disabled).toBe(false);
        home.click();
        expect(sidebar.activeRouteId).toBe("sessions");
        expect(navigate).not.toHaveBeenCalled();
      } else {
        if (target === "main") {
          sidebar.openMainSession("main");
        } else {
          const selector =
            target === "rail"
              ? '.sidebar-rail [data-sidebar-entry="session:agent:main:mine"] a'
              : '.sidebar-session-content [data-session-key="agent:main:mine"] .sidebar-recent-session__link';
          sidebar.querySelector<HTMLElement>(selector)!.click();
        }
        expect(navigate).toHaveBeenCalledTimes(1);
      }
      const previousCalls = navigate.mock.calls.length;
      pending.resolve({ session: { ...result.sessions[1]!, key: missing } });
      await pending.promise;
      await sidebar.updateComplete;
      expect(navigate).toHaveBeenCalledTimes(previousCalls);
    },
  );

  it("keeps superseded pin lookup failures silent", async () => {
    const { sidebar, sessions } = await fixture();
    sidebar.sidebarEntries = ["session:agent:main:unloaded"];
    await sidebar.updateComplete;
    const pending = createDeferred<Awaited<ReturnType<typeof sessions.sessions.describe>>>();
    vi.spyOn(sessions.sessions, "describe").mockReturnValueOnce(pending.promise);
    const showToast = vi.spyOn(toast, "showToast");
    sidebar
      .querySelector<HTMLButtonElement>(
        '.sidebar-rail [data-sidebar-entry="session:agent:main:unloaded"] button.sidebar-rail__button',
      )!
      .click();
    sidebar.openMainSession("main");
    pending.reject(new Error("late unavailable"));
    await pending.promise.catch(() => undefined);
    expect(showToast).not.toHaveBeenCalled();
  });

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
    parent.append(sidebar);
    await sidebar.updateComplete;
    expect(catalogQueries()).toHaveLength(2);
    expect(sidebar.querySelector(".sidebar-pages")).not.toBeNull();
  });

  it.each(["mine", "all"] as const)(
    "keeps scope controls for a saved involving-me All filter while in %s",
    async (scope) => {
      const { sidebar } = await fixture(true);
      expect(sidebar.navigationCatalog.scopesEquivalent).toBe(true);
      sidebar.setSessionOwnerFilter(null, true);
      sidebar.setNavigationScope(scope);
      await sidebar.updateComplete;
      expect(sidebar.sessionOwnerFilter.involvingMe).toBe(true);
      expect(sidebar.querySelector('[aria-label="Mine"]')).not.toBeNull();
      expect(sidebar.querySelector('[aria-label="All"]')).not.toBeNull();
      sidebar.setSessionOwnerFilter(null, false);
      await sidebar.updateComplete;
      expect(sidebar.querySelector('[aria-label="Mine"]')).toBeNull();
    },
  );

  it("stores only stable person references", () => {
    expect(
      normalizeSidebarEntries(["person:self", "person:self", "person:  ", "person:display name"]),
    ).toEqual(["person:self"]);
  });
});
