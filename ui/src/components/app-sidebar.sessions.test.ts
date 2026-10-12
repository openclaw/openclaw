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

async function mountOwnerFilter(
  selfUser: { id: string; name: string } | null | undefined,
  savedFilter?: SidebarSessionOwnerFilter,
  singleUser = false,
) {
  const gateway = createGatewayHarness({} as GatewayBrowserClient);
  gateway.publish({ selfUser });
  if (singleUser) {
    const hello = gateway.gateway.snapshot.hello;
    if (!hello) {
      throw new Error("Expected Gateway hello fixture");
    }
    gateway.publish({
      hello: { ...hello, policy: { ...hello.policy, hasMultipleSessionSharingIdentities: false } },
    });
  }
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
  if (singleUser) {
    result.owners = [{ type: "human", id: "viewer", label: "Viewer" }];
    result.sessions.forEach((row) => {
      delete row.owner;
    });
  }
  if (savedFilter && selfUser) {
    storeSidebarSessionOwnerFilter(gateway.gateway.connection.gatewayUrl, selfUser.id, savedFilter);
  }
  const context = createContext(gateway.gateway, harness.sessions);
  const provider = createApplicationContextProvider(context);
  const sidebar = document.createElement("openclaw-app-sidebar");
  if (!(sidebar instanceof AppSidebarSessionNavigationElement)) {
    throw new Error("Expected registered sidebar");
  }
  sidebar.sidebarEntries = [];
  provider.append(sidebar);
  document.body.append(provider);
  await settleLitElement(sidebar);
  await sidebar.sidebarMenus.preloadMenuRenderer();
  return { sidebar, gateway, harness, provider };
}

const viewer = { id: "viewer", name: "Viewer" };
const ownerTitle = (sidebar: Element) =>
  sidebar.querySelector("#sidebar-session-owner-title .picker-select__label")?.textContent;

describe("Sessions owner filter", () => {
  it("defaults to My sessions for a signed-in profile and filters by human ownership", async () => {
    const { sidebar } = await mountOwnerFilter(viewer);
    expect(ownerTitle(sidebar)).toBe("My sessions");
    expect(sidebar.sidebarSessionOwnerFilter()).toEqual({ ownerId: "viewer", involvingMe: false });
    expect(sidebar.querySelector('[data-session-key="agent:main:mine"]')).not.toBeNull();
    expect(sidebar.querySelector('[data-session-key="agent:main:other"]')).toBeNull();
    expect(sidebar.querySelector('[data-session-key="agent:main:agent-owned"]')).toBeNull();
  });

  it("keeps the self query while a known multi-owner list resets under a solo hello policy", async () => {
    const { sidebar, gateway } = await mountOwnerFilter(viewer);
    const hello = gateway.gateway.snapshot.hello!;
    gateway.publish({
      hello: { ...hello, policy: { ...hello.policy, hasMultipleSessionSharingIdentities: false } },
    });
    await settleLitElement(sidebar);
    expect(sidebar.sessionData.sessionListQuery("main").ownerId).toBe("viewer");

    // A new query temporarily has no rows or owner facet before its response.
    sidebar.sessionData.sessionsResult = null;
    sidebar.sessionData.sessionResultsByAgent = {};
    sidebar.reconciledSidebarZone();
    expect(sidebar.sessionData.sessionListQuery("main").ownerId).toBe("viewer");
    expect(sidebar.sidebarSessionOwnerFilter()).toEqual({ ownerId: "viewer", involvingMe: false });
  });

  it.each([null, undefined])("defaults to everyone for identity %s", async (selfUser) => {
    const { sidebar } = await mountOwnerFilter(selfUser);
    expect(ownerTitle(sidebar)).toBe("All owners");
    expect(sidebar.sidebarSessionOwnerFilter()).toEqual({ ownerId: null, involvingMe: false });
    expect(sidebar.querySelector('[data-session-key="agent:main:mine"]')).not.toBeNull();
    expect(sidebar.querySelector('[data-session-key="agent:main:other"]')).not.toBeNull();
  });

  it.each([
    { filter: { ownerId: "viewer", involvingMe: false }, title: "My sessions" },
    { filter: { ownerId: null, involvingMe: true }, title: "Involving me" },
    { filter: { ownerId: null, involvingMe: false }, title: "All owners" },
    { filter: { ownerId: "other", involvingMe: false }, title: "Other" },
  ])("uses the saved owner choice as its $title title", async ({ filter, title }) => {
    const { sidebar } = await mountOwnerFilter(viewer, filter);
    expect(ownerTitle(sidebar)).toBe(title);
    expect(sidebar.sidebarSessionOwnerFilter()).toEqual(filter);
  });

  it("keeps a single-user title plain and includes sessions without owner metadata", async () => {
    const { sidebar } = await mountOwnerFilter(viewer, undefined, true);
    expect(sidebar.querySelector("#sidebar-session-owner-title")).toBeNull();
    expect(sidebar.querySelector(".sidebar-session-toolbar")?.textContent).toContain("Sessions");
    expect(sidebar.querySelectorAll(".sidebar-recent-session[data-session-key]")).toHaveLength(3);
    const query = sidebar.sessionData.sessionListQuery("main");
    expect(query.ownerId).toBeUndefined();
    expect(query.involvingMe).toBeUndefined();
  });

  it.each([
    { ownerId: "viewer", involvingMe: false },
    { ownerId: null, involvingMe: true },
  ])("resets panel settings without changing the owner choice $involvingMe", async (filter) => {
    const { sidebar } = await mountOwnerFilter(viewer, filter);
    const trigger = sidebar.querySelector<HTMLButtonElement>(".sidebar-session-sort")!;
    expect(trigger.classList.contains("sidebar-session-sort--filtered")).toBe(false);
    expect(trigger.getAttribute("aria-description")).toBeNull();
    trigger.click();
    await settleLitElement(sidebar);
    expect(sidebar.querySelector("#sidebar-sessions-owner")).toBeNull();
    expect(sidebar.querySelector("#sidebar-sessions-reset")).toBeNull();
    sidebar.sessionOrganizer.setSessionsStatusFilter("all");
    await settleLitElement(sidebar);
    expect(trigger.getAttribute("aria-description")).toBe("Active filters: 1");
    expect(trigger.classList.contains("sidebar-session-sort--filtered")).toBe(true);
    sidebar.querySelector<HTMLButtonElement>("#sidebar-sessions-reset")!.click();
    await settleLitElement(sidebar);
    expect(sidebar.sidebarSessionOwnerFilter()).toEqual(filter);
    expect(sidebar.sessionsStatusFilter).toBe("active");
    expect(trigger.getAttribute("aria-description")).toBeNull();
  });

  it("changes only the owner filter when choosing an owner from the title", async () => {
    const { sidebar, gateway } = await mountOwnerFilter(viewer);
    sidebar.sidebarEntries = ["route:usage"];
    const onEntries = vi.fn();
    const onCollapse = vi.fn();
    sidebar.onUpdateSidebarEntries = onEntries;
    sidebar.onToggleSidebar = onCollapse;
    await settleLitElement(sidebar);
    sidebar.querySelector<HTMLButtonElement>("#sidebar-session-owner-title")!.click();
    await settleLitElement(sidebar);
    sidebar.querySelector<HTMLElement>('[role="option"][data-value="owner:other"]')!.click();
    await settleLitElement(sidebar);
    expect(ownerTitle(sidebar)).toBe("Other");
    expect(sidebar.sidebarSessionOwnerFilter()).toEqual({ ownerId: "other", involvingMe: false });
    expect(
      loadStoredSidebarSessionOwnerFilter(gateway.gateway.connection.gatewayUrl, "viewer"),
    ).toEqual({ ownerId: "other", involvingMe: false });
    expect(sidebar.navigationView).toBe("sessions");
    expect(sidebar.navigationCollapsed).toBe(false);
    expect(sidebar.sidebarEntries).toEqual(["route:usage"]);
    expect(onEntries).not.toHaveBeenCalled();
    expect(onCollapse).not.toHaveBeenCalled();
  });

  it("restores each profile's saved owner choice across identity changes and remount", async () => {
    const filter = { ownerId: "other", involvingMe: false };
    const { sidebar, gateway, provider } = await mountOwnerFilter(viewer, filter);
    const url = gateway.gateway.connection.gatewayUrl;
    storeSidebarSessionOwnerFilter(url, "other", { ownerId: null, involvingMe: true });
    gateway.publish({ selfUser: { id: "other", name: "Other" } });
    await settleLitElement(sidebar);
    expect(ownerTitle(sidebar)).toBe("Involving me");
    gateway.publish({ selfUser: null });
    await settleLitElement(sidebar);
    expect(ownerTitle(sidebar)).toBe("All owners");
    gateway.publish({ selfUser: viewer });
    await settleLitElement(sidebar);
    expect(ownerTitle(sidebar)).toBe("Other");
    sidebar.remove();
    const reloaded = document.createElement("openclaw-app-sidebar");
    if (!(reloaded instanceof AppSidebarSessionNavigationElement)) {
      throw new Error("Expected sidebar");
    }
    provider.append(reloaded);
    await settleLitElement(reloaded);
    expect(reloaded.sidebarSessionOwnerFilter()).toEqual(filter);
    expect(ownerTitle(reloaded)).toBe("Other");
  });
});
