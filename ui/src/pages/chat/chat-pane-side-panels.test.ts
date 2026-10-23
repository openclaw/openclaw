/* @vitest-environment jsdom */
/* @vitest-environment-options {"url":"http://chat-pane-side-panels.test/"} */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { createRefreshChatPane } from "./chat-pane-history.test-support.ts";
import { createDashboardHarness } from "./dashboard-presentation-defaults.test-support.ts";
import {
  closeSlot,
  isSidebarSlotVisible,
  openSlot,
  promoteSidebarPanel,
} from "./sidebar-layout.ts";

afterEach(() => vi.unstubAllGlobals());

function createPane() {
  vi.stubGlobal("localStorage", createStorageMock());
  const fixture = createRefreshChatPane();
  const parent: GatewaySessionRow = { key: "agent:main:parent", sessionId: "p", kind: "direct" };
  const child: GatewaySessionRow = {
    ...parent,
    key: "agent:main:subagent:child",
    sessionId: "child-session",
    spawnedBy: parent.key,
  };
  const roster = { rows: [] as GatewaySessionRow[], hydrated: true, pendingChildRead: false };
  Reflect.set(fixture.pane.swarm, "hydrator", roster);
  fixture.state.sessionKey = parent.key;
  fixture.state.sessionsResult = sessionsResult([parent], 1);
  const run = (active: boolean) => {
    child.hasActiveRun = parent.hasActiveSubagentRun = active;
    child.status = active ? "running" : "done";
    fixture.pane.render();
  };
  return { ...fixture, parent, child, roster, run };
}

it.each([undefined, "processes"] as const)(
  "keeps Subagents closed across lifecycle changes with %s selected",
  (selected) => {
    const { pane, state, parent, child, roster, run } = createPane();
    if (selected) {
      state.updateSidebarLayout(openSlot(state.sidebarLayout, selected));
    }
    pane.render();
    const layout = state.sidebarLayout;
    roster.rows = [child];
    run(true);
    expect(state.sidebarLayout).toEqual(layout);
    expect(isSidebarSlotVisible(state.sidebarLayout, "processes")).toBe(selected === "processes");

    delete parent.sessionId;
    pane.render();
    parent.sessionId = "replacement-session";
    pane.render();
    expect(state.sidebarLayout).toEqual(layout);

    run(false);
    run(true);
    expect(state.sidebarLayout).toEqual(layout);
  },
);

it("preserves a manually opened panel and never reopens it after dismissal", () => {
  const { pane, state, child, roster, run } = createPane();
  roster.rows = [child];
  state.updateSidebarLayout(openSlot(state.sidebarLayout, "subagents"));
  run(true);
  expect(isSidebarSlotVisible(state.sidebarLayout, "subagents")).toBe(true);

  run(false);
  expect(isSidebarSlotVisible(state.sidebarLayout, "subagents")).toBe(true);

  state.updateSidebarLayout(closeSlot(state.sidebarLayout, "subagents"));
  pane.render();
  expect(isSidebarSlotVisible(state.sidebarLayout, "subagents")).toBe(false);
  run(true);
  expect(isSidebarSlotVisible(state.sidebarLayout, "subagents")).toBe(false);
});

it("persists tab selection without changing the chosen main content", () => {
  vi.stubGlobal("localStorage", createStorageMock());
  vi.stubGlobal("sessionStorage", createStorageMock());
  const stored = promoteSidebarPanel(
    openSlot(openSlot({ columns: [] }, "terminal"), "dashboard"),
    "dashboard",
  );
  const h = createDashboardHarness({ savedLayout: stored });
  onTestFinished(() => h.mount.remove());
  h.sync();

  const layout = expectDefined(h.pane.render().layout, "Dashboard pane layout");
  layout.region.callbacks.activatePanel("terminal");

  expect(h.state.sidebarLayout.mainPanelId).toBe("dashboard");
  expect(h.state.sidebarLayout.columns[0]?.activePanelId).toBe("terminal");
  expect(h.saved()?.mainPanelId).toBe("dashboard");
  expect(h.saved()?.columns[0]?.activePanelId).toBe("terminal");
});

it("closes dashboard presentation through its owner without minimizing unrelated tabs", () => {
  vi.stubGlobal("localStorage", createStorageMock());
  vi.stubGlobal("sessionStorage", createStorageMock());
  const h = createDashboardHarness({
    savedLayout: openSlot(openSlot({ columns: [] }, "dashboard"), "terminal"),
  });
  onTestFinished(() => h.mount.remove());
  h.sync();

  const layout = expectDefined(h.pane.render().layout, "Dashboard pane layout");
  layout.region.callbacks.closeSlot("dashboard");

  expect(h.state.sidebarLayout.columns[0]?.panels.map((panel) => panel.slot)).toEqual(["terminal"]);
  expect(isSidebarSlotVisible(h.state.sidebarLayout, "terminal")).toBe(true);
  expect(h.state.sidebarLayout.open).toBe(true);
});
