/* @vitest-environment jsdom */
/* @vitest-environment-options {"url":"http://chat-pane-side-panels.test/"} */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import { renderPanelFixture } from "../../test-helpers/chat-pane-embedded-panels.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { createRefreshChatPane } from "./chat-pane-history.test-support.ts";
import {
  connectPaneTestView,
  createGatewayBrowserClientFixture,
  createTestChatPane,
  getPaneTestRuntime,
} from "./chat-pane.test-support.ts";
import type { ChatSessionRailElement } from "./components/chat-session-rail.tsx";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";
import { createDashboardHarness } from "./dashboard-presentation-defaults.test-support.ts";
import {
  closeSlot,
  isSidebarSlotVisible,
  openSlot,
  promoteSidebarPanel,
  setSidebarExpanded,
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

it("projects the Side Chat model catalog only when its panel mounts", async () => {
  const { pane, state } = createTestChatPane({ client: createGatewayBrowserClientFixture() });
  const context = pane.context;
  state.hello!.features!.methods!.push("sessions.companion.state");
  context.gateway.snapshot.hello = state.hello;
  state.chatModelCatalog = [{ id: "test-model", name: "Test model", provider: "example" }];
  state.updateSidebarLayout(openSlot(openSlot({ columns: [] }, "companion"), "terminal"));
  const projectCatalog = vi.spyOn(state.chatModelCatalog, "map");
  const mount = document.body.appendChild(document.createElement("div"));
  onTestFinished(() => mount.remove());
  const renderPanels = async () => {
    const layout = expectDefined(pane.render().layout, "Pane layout");
    await renderPanelFixture(
      mount,
      layout.region.layout,
      layout.region.panelDefinitions,
      undefined,
      context,
    );
  };

  await renderPanels();
  expect(projectCatalog).not.toHaveBeenCalled();
  expect(mount.querySelector("openclaw-chat-session-rail")).toBeNull();

  state.updateSidebarLayout(openSlot(state.sidebarLayout, "companion"));
  await renderPanels();
  await waitForSolid(() =>
    expect(mount.querySelector("openclaw-chat-session-rail")).not.toBeNull(),
  );
  const rail = expectDefined(
    mount.querySelector<ChatSessionRailElement>("openclaw-chat-session-rail"),
    "Side Chat panel",
  );
  expect(rail.presented).toBe(true);
  await waitForSolid(() =>
    expect(rail.modelControls?.modelCatalog?.[0]).toEqual(state.chatModelCatalog[0]),
  );
  expect(projectCatalog).toHaveBeenCalledOnce();
  state.chatModelsLoading = true;
  await waitForSolid(() => expect(rail.modelControls?.modelCatalogState.status).toBe("loading"));
  state.chatModelCatalog = [{ id: "loaded-model", name: "Loaded model", provider: "example" }];
  state.chatModelCatalogInitialized = true;
  state.chatModelsLoading = false;
  await waitForSolid(() => {
    expect(rail.modelControls?.modelCatalog?.[0]?.id).toBe("loaded-model");
    expect(rail.modelControls?.modelCatalogState.status).toBe("ready");
  });
  rail.modelControls?.onModelSelect?.("example/loaded-model", `side-chat:${state.sessionKey}`);
  await renderPanels();
  await waitForSolid(() =>
    expect(rail.modelControls?.modelOverrides).toEqual({
      [`side-chat:${state.sessionKey}`]: "example/loaded-model",
    }),
  );
});

it.each([true, false])(
  "mounts a hidden conversation on first reveal and retains its draft (pane presented: %s)",
  async (panePresented) => {
    installTranscriptDomMocks();
    onTestFinished(resetTranscriptTestDom);
    const { pane, state } = createTestChatPane({ client: createGatewayBrowserClientFixture() });
    const hidden = setSidebarExpanded(
      promoteSidebarPanel(openSlot({ columns: [] }, "terminal"), "terminal"),
      true,
    );
    pane.presented = panePresented;
    state.updateSidebarLayout(panePresented ? hidden : setSidebarExpanded(hidden, false));
    connectPaneTestView(pane);
    document.body.append(pane.element);
    await pane.updateComplete;
    expect(pane.querySelector(".chat-pane-primary-column")).toBeNull();
    expect(pane.querySelector(".chat-thread")).toBeNull();
    expect(pane.querySelector("textarea")).toBeNull();

    pane.presented = true;
    state.updateSidebarLayout(setSidebarExpanded(hidden, false));
    await waitForSolid(() => expect(pane.querySelector("textarea")).not.toBeNull());
    const input = expectDefined(pane.querySelector("textarea"), "Revealed composer");
    state.handleChatDraftChange("Retained conversation draft");
    await waitForSolid(() => expect(input.value).toBe("Retained conversation draft"));

    state.updateSidebarLayout(hidden);
    await waitForSolid(() =>
      expect(pane.querySelector<HTMLElement>(".sidebar-region__primary")?.hidden).toBe(true),
    );
    expect(pane.querySelector("textarea")).toBe(input);
    state.updateSidebarLayout(setSidebarExpanded(hidden, false));
    await waitForSolid(() =>
      expect(pane.querySelector<HTMLElement>(".sidebar-region__primary")?.hidden).toBe(false),
    );
    expect(pane.querySelector("textarea")).toBe(input);
    expect(input.value).toBe("Retained conversation draft");
  },
);

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

it("discards a Details process request after switching agents on the same global key", () => {
  vi.stubGlobal("localStorage", createStorageMock());
  vi.stubGlobal("sessionStorage", createStorageMock());
  const { pane, state, mount } = createDashboardHarness({
    row: { key: "global", agentId: "main", sessionId: "global-session", kind: "direct" },
  });
  onTestFinished(() => mount.remove());
  pane.routeFace = "chat";
  const runtime = getPaneTestRuntime(pane);
  state.assistantAgentId = "main";
  const open = () => {
    const details = pane.render().layout?.header?.header.header.detailsControl?.chat;
    expectDefined(details?.onOpenProcesses, "Details process action")("process-main");
  };
  open();
  state.assistantAgentId = "research";
  expect(runtime.companionIntents.processesShowRequest?.()).toBeUndefined();

  open();
  expect(runtime.companionIntents.processesShowRequest?.()).toEqual({
    instanceId: "process-main",
    fromDetails: true,
  });
  expect(runtime.companionIntents.processesShowRequest).toBeUndefined();
});
