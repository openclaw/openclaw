/* @vitest-environment jsdom */

import "../test-helpers/app-sidebar-suite.ts";
import "../test-helpers/app-sidebar-cases/categorized-child-sessions.ts";
import "../test-helpers/app-sidebar-cases/child-session-errors.ts";
import "../test-helpers/app-sidebar-cases/child-session-archive.ts";
import "../test-helpers/app-sidebar-cases/child-sessions-cap.ts";
import "../test-helpers/app-sidebar-cases/child-sessions.ts";
import "../test-helpers/app-sidebar-cases/narration.ts";
import "../test-helpers/app-sidebar-cases/outbox-badges.ts";
import "../test-helpers/app-sidebar-cases/pull-request-state.ts";
import "../test-helpers/app-sidebar-cases/session-indicators.ts";
import "../test-helpers/app-sidebar-cases/session-delegated-activity.ts";
import "../test-helpers/app-sidebar-cases/sessions.ts";
import "../test-helpers/app-sidebar-cases/session-ownership.ts";
import "../test-helpers/app-sidebar-cases/session-ownership-filtering.ts";
import "../test-helpers/app-sidebar-cases/session-list-sections.ts";
import "../test-helpers/app-sidebar-cases/sidebar-zone.ts";
import "../test-helpers/app-sidebar-cases/plugin-session-list.ts";
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { selectSessionMenuValue } from "../test-helpers/app-sidebar-menu.ts";
import {
  createContext,
  createGatewayHarness,
  createSessionsHarness,
} from "../test-helpers/app-sidebar.ts";
import { createApplicationContextProvider } from "../test-helpers/application-context.ts";
import { settleLitElement } from "../test-helpers/lit-settle.ts";
import { AppSidebarSessionNavigationElement } from "./app-sidebar-session-navigation.ts";
import {
  loadStoredSidebarSessionOwnerFilter,
  storeSidebarSessionOwnerFilter,
  type SidebarSessionOwnerFilter,
} from "./app-sidebar-session-types.ts";

async function mountDefaultMine(
  selfAvailable: boolean,
  savedAllFilter?: SidebarSessionOwnerFilter,
) {
  const gateway = createGatewayHarness({} as GatewayBrowserClient);
  gateway.publish({ selfUser: selfAvailable ? { id: "viewer", name: "Viewer" } : undefined });
  const harness = createSessionsHarness("main", [
    "agent:main:mine",
    "agent:main:other",
    "agent:main:agent-owned",
  ]);
  const result = harness.sessions.state.result!;
  result.owners = [
    { type: "human", id: "viewer", label: "Viewer" },
    { type: "human", id: "other", label: "Other" },
    { type: "agent", id: "viewer", label: "Agent" },
  ];
  result.sessions.forEach((row, index) => {
    row.owner = { actor: result.owners![index]! };
  });
  if (savedAllFilter) {
    storeSidebarSessionOwnerFilter(gateway.gateway.connection.gatewayUrl, "viewer", savedAllFilter);
  }
  const context = createContext(gateway.gateway, harness.sessions);
  const provider = createApplicationContextProvider(context);
  const sidebar = document.createElement("openclaw-app-sidebar");
  if (!(sidebar instanceof AppSidebarSessionNavigationElement)) {
    throw new Error("Expected registered sidebar");
  }
  // Model the shell supplying the personal preference before first render.
  sidebar.navigationScope = "mine";
  sidebar.sidebarEntries = [];
  provider.append(sidebar);
  document.body.append(provider);
  await settleLitElement(sidebar);
  return { sidebar, gateway, harness, provider };
}

describe("personal Sessions view preferences", () => {
  it.each([true, false])(
    "uses only the admitted presentation profile for offline Mine rows, never unresolved live identity (cached: %s)",
    async (resultCached) => {
      const { sidebar, gateway, harness } = await mountDefaultMine(false);
      const persist = vi.fn();
      sidebar.onUpdateNavigationScope = persist;
      const presentation = {
        ...harness.sessions.presentation,
        resultCached,
        profileId: "viewer",
      };
      vi.spyOn(harness.sessions, "presentation", "get").mockReturnValue(presentation);
      gateway.publish({ phase: "connecting" });
      await settleLitElement(sidebar);
      expect(sidebar.querySelector('[data-session-key="agent:main:mine"]')).not.toBeNull();
      expect(sidebar.querySelector('[data-session-key="agent:main:other"]')).toBeNull();
      expect(sidebar.querySelector('[data-session-key="agent:main:agent-owned"]')).toBeNull();
      expect(sidebar.navigationScope).toBe("mine");
      expect(persist).not.toHaveBeenCalled();
      gateway.publish({ phase: "connected", selfUser: undefined });
      await settleLitElement(sidebar);
      expect(sidebar.querySelectorAll(".sidebar-session-content [data-session-key]")).toHaveLength(
        0,
      );
      gateway.publish({ selfUser: { id: "other", name: "Other" } });
      await settleLitElement(sidebar);
      expect(sidebar.querySelector('[data-session-key="agent:main:mine"]')).toBeNull();
      expect(sidebar.querySelector('[data-session-key="agent:main:other"]')).not.toBeNull();
      expect(persist).not.toHaveBeenCalled();
    },
  );

  it("renders an initial Mine preference by human ownership and retains it across view switches", async () => {
    const { sidebar } = await mountDefaultMine(true);
    const onScope = vi.fn();
    sidebar.onUpdateNavigationScope = onScope;
    expect(sidebar.querySelector('[data-session-key="agent:main:mine"]')).not.toBeNull();
    expect(sidebar.querySelector('[data-session-key="agent:main:other"]')).toBeNull();
    expect(sidebar.querySelector('[data-session-key="agent:main:agent-owned"]')).toBeNull();
    for (const view of ["pages", "online", "sessions"]) {
      sidebar.querySelector<HTMLButtonElement>(`[data-navigation-view="${view}"]`)!.click();
      await settleLitElement(sidebar);
      expect(sidebar.navigationScope).toBe("mine");
      expect(onScope).not.toHaveBeenCalled();
    }
    expect(sidebar.querySelector('[data-session-key="agent:main:mine"]')).not.toBeNull();
    expect(sidebar.querySelector('[data-session-key="agent:main:other"]')).toBeNull();
  });

  it("does not broaden an initial Mine preference while the current profile is unavailable", async () => {
    const { sidebar, gateway, harness } = await mountDefaultMine(false);
    expect(sidebar.navigationScope).toBe("mine");
    expect(sidebar.querySelectorAll(".sidebar-session-content [data-session-key]")).toHaveLength(0);
    expect(sidebar.querySelector('[aria-label="Mine"]')?.getAttribute("aria-pressed")).toBe("true");
    harness.list.mockClear();
    gateway.publish({ selfUser: { id: "viewer", name: "Viewer" } });
    await settleLitElement(sidebar);
    expect(harness.list).toHaveBeenCalledWith(expect.objectContaining({ ownerId: "viewer" }));
    expect(sidebar.querySelector('[data-session-key="agent:main:mine"]')).not.toBeNull();
    expect(sidebar.querySelector('[data-session-key="agent:main:other"]')).toBeNull();
    const onScope = vi.fn();
    sidebar.onUpdateNavigationScope = onScope;
    sidebar.querySelector<HTMLButtonElement>('[aria-label="All"]')!.click();
    await settleLitElement(sidebar);
    expect(onScope).toHaveBeenCalledWith("all");
    expect(sidebar.querySelector('[data-session-key="agent:main:other"]')).not.toBeNull();
  });
});

describe("profileless retained Sessions view", () => {
  it("keeps resolved profileless rows offline without writing Mine and closes them for unresolved identity", async () => {
    const { sidebar, gateway } = await mountDefaultMine(false);
    const persist = vi.fn();
    sidebar.onUpdateNavigationScope = persist;
    gateway.publish({ selfUser: null });
    await settleLitElement(sidebar);
    expect(sidebar.querySelector('[data-session-key="agent:main:other"]')).not.toBeNull();
    for (const phase of ["reconnecting", "offline"] as const) {
      gateway.publish({ phase });
      await settleLitElement(sidebar);
      expect(sidebar.querySelector('[data-session-key="agent:main:other"]')).not.toBeNull();
      expect(sidebar.querySelector('[aria-label="All"]')?.getAttribute("aria-pressed")).toBe(
        "true",
      );
      expect(sidebar.navigationScope).toBe("mine");
      expect(persist).not.toHaveBeenCalled();
    }
    gateway.publish({ phase: "reconnecting", selfUser: undefined });
    await settleLitElement(sidebar);
    expect(sidebar.querySelectorAll(".sidebar-session-content [data-session-key]")).toHaveLength(0);
    expect(sidebar.navigationScope).toBe("mine");
    expect(persist).not.toHaveBeenCalled();
  });
});

describe("saved All filters in the personal Sessions view", () => {
  it.each([
    { ownerId: "other", involvingMe: false },
    { ownerId: null, involvingMe: true },
  ])("preserves $ownerId/$involvingMe across Mine, All and remount", async (filter) => {
    const { sidebar, gateway, harness, provider } = await mountDefaultMine(true, filter);
    const stored = () =>
      loadStoredSidebarSessionOwnerFilter(gateway.gateway.connection.gatewayUrl, "viewer");
    expect(sidebar.sidebarSessionOwnerFilter()).toEqual({ ownerId: "viewer", involvingMe: false });
    expect(stored()).toEqual(filter);
    harness.list.mockClear();
    sidebar.querySelector<HTMLButtonElement>('[aria-label="All"]')!.click();
    await settleLitElement(sidebar);
    expect(sidebar.sidebarSessionOwnerFilter()).toEqual(filter);
    expect(
      harness.list.mock.calls.filter(([query]) => !query?.includeOwnerSessionCounts),
    ).toHaveLength(1);
    const query = filter.involvingMe ? { involvingMe: true } : { ownerId: "other" };
    expect(harness.list).toHaveBeenCalledWith(expect.objectContaining(query));
    sidebar.querySelector<HTMLButtonElement>('[aria-label="Mine"]')!.click();
    await settleLitElement(sidebar);
    expect(sidebar.sidebarSessionOwnerFilter()).toEqual({ ownerId: "viewer", involvingMe: false });
    expect(stored()).toEqual(filter);
    sidebar.remove();
    const reloaded = document.createElement("openclaw-app-sidebar");
    if (!(reloaded instanceof AppSidebarSessionNavigationElement)) {
      throw new Error("Expected sidebar");
    }
    reloaded.navigationScope = "all";
    provider.append(reloaded);
    await settleLitElement(reloaded);
    expect(reloaded.sidebarSessionOwnerFilter()).toEqual(filter);
    await reloaded.sidebarMenus.preloadMenuRenderer();
    await selectSessionMenuValue(reloaded, "owner:");
    expect(stored()).toEqual({ ownerId: null, involvingMe: false });
  });

  it("restores a replacement profile's All choice without changing Mine's owner", async () => {
    const { sidebar, gateway } = await mountDefaultMine(true, {
      ownerId: "other",
      involvingMe: false,
    });
    const url = gateway.gateway.connection.gatewayUrl;
    storeSidebarSessionOwnerFilter(url, "other", { ownerId: null, involvingMe: true });
    gateway.publish({ selfUser: { id: "other", name: "Other" } });
    await settleLitElement(sidebar);
    expect(sidebar.sidebarSessionOwnerFilter()).toEqual({ ownerId: "other", involvingMe: false });
    sidebar.querySelector<HTMLButtonElement>('[aria-label="All"]')!.click();
    await settleLitElement(sidebar);
    expect(sidebar.sidebarSessionOwnerFilter()).toEqual({ ownerId: null, involvingMe: true });
    gateway.publish({ selfUser: null });
    await settleLitElement(sidebar);
    expect(sidebar.sidebarSessionOwnerFilter()).toEqual({ ownerId: null, involvingMe: false });
    gateway.publish({ selfUser: { id: "viewer", name: "Viewer" } });
    await settleLitElement(sidebar);
    expect(sidebar.sidebarSessionOwnerFilter()).toEqual({ ownerId: "other", involvingMe: false });
    expect(loadStoredSidebarSessionOwnerFilter(url, "other")).toEqual({
      ownerId: null,
      involvingMe: true,
    });
  });
});
