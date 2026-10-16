/* @vitest-environment jsdom */

import "../test-helpers/app-sidebar-suite.ts";
import "../test-helpers/app-sidebar-cases/categorized-child-sessions.ts";
import "../test-helpers/app-sidebar-cases/child-session-errors.ts";
import "../test-helpers/app-sidebar-cases/child-session-archive.ts";
import "../test-helpers/app-sidebar-cases/child-sessions-cap.ts";
import "../test-helpers/app-sidebar-cases/child-sessions.ts";
import "../test-helpers/app-sidebar-cases/narration.ts";
import "../test-helpers/app-sidebar-cases/outbox-badges.ts";
import "../test-helpers/app-sidebar-cases/session-indicators.ts";
import "../test-helpers/app-sidebar-cases/session-delegated-activity.ts";
import "../test-helpers/app-sidebar-cases/sessions.ts";
import "../test-helpers/app-sidebar-cases/session-ownership.ts";
import "../test-helpers/app-sidebar-cases/session-ownership-filtering.ts";
import "../test-helpers/app-sidebar-cases/session-list-sections.ts";
import "../test-helpers/app-sidebar-cases/sidebar-zone.ts";
import "../test-helpers/app-sidebar-cases/plugin-session-list.ts";
import { describe, expect, it } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import {
  createContext,
  createGatewayHarness,
  createSidebarElement,
  createSessionsHarness,
} from "../test-helpers/app-sidebar.ts";
import { createApplicationContextProvider } from "../test-helpers/application-context.ts";
import { settleLitElement } from "../test-helpers/lit-settle.ts";
import {
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
  const sidebar = await createSidebarElement();
  sidebar.sidebarEntries = [];
  provider.append(sidebar.hostElement);
  document.body.append(provider);
  await settleLitElement(sidebar);
  await sidebar.sidebarMenus.preloadMenuRenderer();
  return { sidebar, gateway, harness, provider };
}

const viewer = { id: "viewer", name: "Viewer" };
const ownerTitle = (sidebar: Element) =>
  sidebar.querySelector("#sidebar-session-owner-title .picker-select__label")?.textContent;

describe("Sessions owner filter", () => {
  it("keeps a single-user title plain and includes sessions without owner metadata", async () => {
    const { sidebar } = await mountOwnerFilter(viewer, undefined, true);
    expect(sidebar.querySelector("#sidebar-session-owner-title")).toBeNull();
    expect(sidebar.querySelector(".sidebar-session-toolbar")?.textContent).toContain("Sessions");
    expect(sidebar.querySelectorAll(".sidebar-recent-session[data-session-key]")).toHaveLength(3);
    const query = sidebar.sessionData.sessionListQuery("main");
    expect(query.ownerId).toBeUndefined();
    expect(query.involvingMe).toBeUndefined();
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
    const reloaded = await createSidebarElement();
    provider.append(reloaded.hostElement);
    await settleLitElement(reloaded);
    expect(reloaded.sidebarSessionOwnerFilter()).toEqual(filter);
    expect(ownerTitle(reloaded)).toBe("Other");
  });
});
