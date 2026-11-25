/* @vitest-environment jsdom */

import { expect, it } from "vitest";
import { createMountedPanes } from "./chat-pane-mounted.test-support.ts";
import { getPaneTestRuntime } from "./chat-pane.test-support.ts";
import { isSidebarSlotVisible, openSlot, promoteSidebarPanel } from "./sidebar-layout.ts";

it("hides a mobile host without closing resources, losing its origin, or changing the desktop layout", () => {
  const { pane, state } = createMountedPanes([]);
  const runtime = getPaneTestRuntime(pane);
  runtime.mergedChrome = true;
  state.sidebarLayout = openSlot(openSlot({ columns: [] }, "terminal"), "workspace");
  const saved = structuredClone(state.sidebarLayout);
  const read = () => pane.render().layout!;
  const host = () => read().region.mobileHost!;

  host().navigate({ area: "details" });
  read().primary.chat.onOpenWorkspace?.();
  expect(host().destination.area).toBe("panels");
  expect(host().destination.backTo?.area).toBe("details");
  host().resize(280, "dock", 0);
  expect(host().height).toBe(280);
  host().toggleExpanded(280);
  expect(host().height).toBeUndefined();
  host().close();
  expect(isSidebarSlotVisible(read().region.layout, "conversation")).toBe(true);
  expect(isSidebarSlotVisible(read().region.layout, "workspace")).toBe(false);
  expect(state.sidebarLayout).toEqual(saved);

  host().reveal();
  expect(host()).toMatchObject({
    open: true,
    mode: "expanded",
    height: undefined,
    reservedHeight: 0,
  });
  expect(isSidebarSlotVisible(read().region.layout, "workspace")).toBe(true);
  host().back();
  expect(host().destination).toEqual({ area: "details" });
  expect(state.sidebarLayout).toEqual(saved);
  runtime.mergedChrome = false;
  expect(read().region.mobileHost).toBeUndefined();
  expect(state.sidebarLayout).toEqual(saved);
});

it("consumes suspension facts without discarding navigation, and scopes retained routes to the session", () => {
  const { pane, state } = createMountedPanes([]);
  const runtime = getPaneTestRuntime(pane);
  runtime.mergedChrome = true;
  const host = () => pane.render().layout!.region.mobileHost!;
  host().navigate({
    area: "details",
    page: { key: "controlled-child", title: "Child", content: document.createElement("article") },
    backTo: { area: "details" },
  });
  host().resize(260, "dock", 0);
  host().onComposerEditingChange(true);
  expect(host()).toMatchObject({ open: true, suspended: true, height: 260 });
  host().reveal();
  expect(host().suspended).toBe(false);
  expect(host().destination.page?.key).toBe("controlled-child");
  state.sessionKey = "agent:main:another-session";
  expect(host()).toMatchObject({
    mode: "dock",
    height: undefined,
    destination: { area: "panels" },
  });
});

it("enters each session closed on mobile while desktop keeps the saved open panels", () => {
  const { pane, state } = createMountedPanes([]);
  const runtime = getPaneTestRuntime(pane);
  state.sidebarLayout = {
    ...promoteSidebarPanel(openSlot({ columns: [] }, "workspace"), "workspace"),
    open: true,
  };
  const saved = structuredClone(state.sidebarLayout);
  const read = () => pane.render().layout!;
  expect(isSidebarSlotVisible(read().region.layout, "workspace")).toBe(true);

  runtime.mergedChrome = true;
  expect(read().region.mobileHost!.open).toBe(false);
  expect(isSidebarSlotVisible(read().region.layout, "workspace")).toBe(false);
  read().region.mobileHost!.navigate({ area: "panels", slot: "workspace" });
  expect(read().region.mobileHost!.open).toBe(true);

  state.sessionKey = "agent:main:another-session";
  expect(read().region.mobileHost!.open).toBe(false);
  expect(isSidebarSlotVisible(read().region.layout, "workspace")).toBe(false);
  // An explicit open delivered before the new session renders still applies.
  const openWorkspace = read().primary.chat.onOpenWorkspace;
  state.sessionKey = "agent:main:third-session";
  openWorkspace?.();
  expect(read().region.mobileHost!.open).toBe(true);
  expect(isSidebarSlotVisible(read().region.layout, "workspace")).toBe(true);

  // Returning to a parked pane's session starts closed as well.
  pane.presented = false;
  pane.presented = true;
  expect(read().region.mobileHost!.open).toBe(false);

  runtime.mergedChrome = false;
  expect(state.sidebarLayout).toEqual(saved);
  expect(isSidebarSlotVisible(read().region.layout, "workspace")).toBe(true);
});

it("selects a desktop-main Files panel on mobile without persisting the presentation", () => {
  const { pane, state } = createMountedPanes([]);
  const runtime = getPaneTestRuntime(pane);
  state.sidebarLayout = {
    ...promoteSidebarPanel(
      openSlot(openSlot({ columns: [] }, "workspace"), "terminal"),
      "workspace",
    ),
    expanded: true,
  };
  state.sidebarLayout.columns[0]!.activePanelId = "terminal";
  const saved = structuredClone(state.sidebarLayout);
  runtime.mergedChrome = true;
  const read = () => pane.render().layout!;
  read().region.mobileHost!.close();
  read().primary.chat.onOpenWorkspace?.();
  expect(isSidebarSlotVisible(read().region.layout, "workspace")).toBe(true);
  expect(isSidebarSlotVisible(read().region.layout, "terminal")).toBe(false);
  read().region.callbacks.activatePanel("terminal");
  expect(isSidebarSlotVisible(read().region.layout, "terminal")).toBe(true);
  expect(state.sidebarLayout).toEqual(saved);
  read().region.callbacks.reorderPanel("terminal", "workspace", "before");
  expect(state.sidebarLayout.mainPanelId).toBe(saved.mainPanelId);
  expect(state.sidebarLayout.expanded).toBe(true);
  expect(state.sidebarLayout.columns[0]!.panels.map((panel) => panel.id)).toEqual([
    "terminal",
    "workspace",
    "conversation",
  ]);
});
