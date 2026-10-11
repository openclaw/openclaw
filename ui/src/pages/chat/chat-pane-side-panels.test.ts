/* @vitest-environment jsdom */
/* @vitest-environment-options {"url":"http://chat-pane-side-panels.test/"} */

import { afterEach, expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { createRefreshChatPane } from "./chat-pane-history.test-support.ts";
import { closeSlot, isSidebarSlotVisible, openSlot, setSidebarOpen } from "./sidebar-layout.ts";

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
  Reflect.set(fixture.pane, "swarmHydrator", roster);
  fixture.state.sessionKey = parent.key;
  fixture.state.sessionsResult = {
    ts: 1,
    count: 1,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions: [parent],
  };
  return { ...fixture, parent, child, roster };
}

it("reveals a batch once, honors its dismissal, and keeps settled results open", () => {
  const { pane, state, parent, child, roster } = createPane();
  pane.render();
  expect(isSidebarSlotVisible(state.sidebarLayout, "subagents")).toBe(false);

  roster.rows = [child];
  parent.hasActiveSubagentRun = true;
  pane.render();
  expect(isSidebarSlotVisible(state.sidebarLayout, "subagents")).toBe(true);

  state.updateSidebarLayout(closeSlot(state.sidebarLayout, "subagents"));
  pane.render();
  expect(isSidebarSlotVisible(state.sidebarLayout, "subagents")).toBe(false);

  child.hasActiveRun = false;
  child.status = "done";
  parent.hasActiveSubagentRun = false;
  pane.render();
  expect(isSidebarSlotVisible(state.sidebarLayout, "subagents")).toBe(false);

  child.hasActiveRun = true;
  child.status = "running";
  parent.hasActiveSubagentRun = true;
  pane.render();
  expect(isSidebarSlotVisible(state.sidebarLayout, "subagents")).toBe(true);

  child.hasActiveRun = false;
  child.status = "done";
  parent.hasActiveSubagentRun = false;
  pane.render();
  expect(isSidebarSlotVisible(state.sidebarLayout, "subagents")).toBe(true);

  const next = createRefreshChatPane();
  next.state.sessionKey = "agent:main:next";
  next.state.sessionsResult = {
    ts: 1,
    count: 1,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions: [{ key: next.state.sessionKey, kind: "direct" }],
  };
  next.pane.render();
  expect(isSidebarSlotVisible(next.state.sidebarLayout, "subagents")).toBe(false);
});

it("does not mistake an overlapping roster read for settlement after a pane close", () => {
  const { pane, state, parent, child, roster } = createPane();
  parent.hasActiveSubagentRun = true;
  roster.rows = [child];
  pane.render();
  expect(isSidebarSlotVisible(state.sidebarLayout, "subagents")).toBe(true);
  state.updateSidebarLayout(setSidebarOpen(state.sidebarLayout, false));

  parent.hasActiveSubagentRun = false;
  roster.rows = [];
  roster.pendingChildRead = true;
  pane.render();
  parent.hasActiveSubagentRun = true;
  roster.rows = [child];
  roster.pendingChildRead = false;
  pane.render();
  expect(isSidebarSlotVisible(state.sidebarLayout, "subagents")).toBe(false);
});

it.each([
  { label: "an ordinary visible child session", key: "agent:main:dashboard:child" },
  {
    label: "another conversation's subagent",
    key: "agent:main:subagent:other",
    spawnedBy: "agent:main:other",
  },
])("does not reveal Subagents for $label", ({ key, spawnedBy }) => {
  const { pane, state, parent, child, roster } = createPane();
  parent.hasActiveSubagentRun = true;
  roster.rows = [{ ...child, key, spawnedBy: spawnedBy ?? parent.key }];
  pane.render();
  expect(isSidebarSlotVisible(state.sidebarLayout, "subagents")).toBe(false);
});

it("preserves a manually opened empty panel for its session", () => {
  const { pane, state } = createPane();
  state.updateSidebarLayout(openSlot(state.sidebarLayout, "subagents"));
  pane.render();
  pane.render();
  expect(isSidebarSlotVisible(state.sidebarLayout, "subagents")).toBe(true);
});
