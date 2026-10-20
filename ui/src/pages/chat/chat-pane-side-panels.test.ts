/* @vitest-environment jsdom */
/* @vitest-environment-options {"url":"http://chat-pane-side-panels.test/"} */

import { afterEach, expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
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
  fixture.state.sessionsResult = sessionsResult([parent], 1);
  const run = (active: boolean) => {
    child.hasActiveRun = parent.hasActiveSubagentRun = active;
    child.status = active ? "running" : "done";
    fixture.pane.render();
  };
  return { ...fixture, parent, child, roster, run };
}

it("keeps Subagents closed through hydration, new batches, and session identity changes", () => {
  const { pane, state, parent, child, roster, run } = createPane();
  pane.render();
  const layout = state.sidebarLayout;

  roster.rows = [child];
  run(true);
  expect(state.sidebarLayout).toEqual(layout);

  delete parent.sessionId;
  pane.render();
  parent.sessionId = "replacement-session";
  pane.render();
  expect(state.sidebarLayout).toEqual(layout);

  run(false);
  run(true);
  expect(state.sidebarLayout).toEqual(layout);
});

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
