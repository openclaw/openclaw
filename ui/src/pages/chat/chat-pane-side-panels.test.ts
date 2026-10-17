/* @vitest-environment jsdom */
/* @vitest-environment-options {"url":"http://chat-pane-side-panels.test/"} */

import { afterEach, expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { createRefreshChatPane } from "./chat-pane-history.test-support.ts";
import { closeSlot, isSidebarSlotVisible, openSlot } from "./sidebar-layout.ts";

afterEach(() => vi.unstubAllGlobals());

function createPane() {
  vi.stubGlobal("localStorage", createStorageMock());
  const fixture = createRefreshChatPane();
  const parent: GatewaySessionRow = {
    key: "agent:main:parent",
    sessionId: "parent-session",
    kind: "direct",
  };
  const child: GatewaySessionRow = {
    key: "agent:main:subagent:child",
    sessionId: "child-session",
    kind: "direct",
    spawnedBy: parent.key,
    label: "Research",
    status: "running",
    hasActiveRun: true,
  };
  const roster = { rows: [] as GatewaySessionRow[], hydrated: true, pendingChildRead: false };
  Reflect.set(fixture.pane.swarm, "hydrator", roster);
  fixture.state.sessionKey = parent.key;
  fixture.state.sessionsResult = {
    ts: 1,
    path: "",
    count: 1,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions: [parent],
  };
  return { ...fixture, parent, child, roster };
}

it("keeps Subagents closed through hydration, new batches, and session identity changes", () => {
  const { pane, state, parent, child, roster } = createPane();
  pane.render();
  const layout = state.sidebarLayout;

  roster.rows = [child];
  parent.hasActiveSubagentRun = true;
  pane.render();
  expect(state.sidebarLayout).toEqual(layout);

  delete parent.sessionId;
  pane.render();
  parent.sessionId = "replacement-session";
  pane.render();
  expect(state.sidebarLayout).toEqual(layout);

  child.hasActiveRun = false;
  child.status = "done";
  parent.hasActiveSubagentRun = false;
  pane.render();
  child.hasActiveRun = true;
  child.status = "running";
  parent.hasActiveSubagentRun = true;
  pane.render();
  expect(state.sidebarLayout).toEqual(layout);
});

it("preserves a manually opened panel and never reopens it after dismissal", () => {
  const { pane, state, parent, child, roster } = createPane();
  parent.hasActiveSubagentRun = true;
  roster.rows = [child];
  state.updateSidebarLayout(openSlot(state.sidebarLayout, "subagents"));
  pane.render();
  expect(isSidebarSlotVisible(state.sidebarLayout, "subagents")).toBe(true);

  child.hasActiveRun = false;
  child.status = "done";
  parent.hasActiveSubagentRun = false;
  pane.render();
  expect(isSidebarSlotVisible(state.sidebarLayout, "subagents")).toBe(true);

  state.updateSidebarLayout(closeSlot(state.sidebarLayout, "subagents"));
  pane.render();
  expect(isSidebarSlotVisible(state.sidebarLayout, "subagents")).toBe(false);
  child.hasActiveRun = true;
  child.status = "running";
  parent.hasActiveSubagentRun = true;
  pane.render();
  expect(isSidebarSlotVisible(state.sidebarLayout, "subagents")).toBe(false);
});

it("leaves the selected panel unchanged when running children are discovered", () => {
  const { pane, state, parent, child, roster } = createPane();
  state.updateSidebarLayout(openSlot(state.sidebarLayout, "processes"));
  const layout = state.sidebarLayout;
  parent.hasActiveSubagentRun = true;
  roster.rows = [child];
  pane.render();
  expect(state.sidebarLayout).toEqual(layout);
  expect(isSidebarSlotVisible(state.sidebarLayout, "processes")).toBe(true);
});
