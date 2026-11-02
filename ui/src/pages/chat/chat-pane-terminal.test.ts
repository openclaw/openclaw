/* @vitest-environment jsdom */

import { flush } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import { decodeResumeHandoff } from "../../../../src/shared/resume-handoff.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import { gatewayHelloForMethods as desktopHello } from "../../test-helpers/gateway-methods.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createGatewayBrowserClientFixture as gateway } from "./chat-application-context.test-support.ts";
import {
  runPaneHeaderAction,
  activePlacementSession,
  createPaneHeaderWorkspaceFixture,
  createTestChatPane,
  getPaneTestRuntime,
} from "./chat-pane.test-support.ts";
import { createSessionCapabilityFixture } from "./chat-session-capability.test-support.ts";
import {
  openNativeMenu,
  renderPaneHeaderInto,
  selectNativeMenu,
} from "./components/chat-pane-header.test-support.ts";
import { openSlot } from "./sidebar-layout.ts";

async function openPanelMenu(container: HTMLElement, readyValue?: string) {
  const menu = container.querySelector<HTMLElement>(".chat-pane__layout-menu");
  expect(menu).not.toBeNull();
  await openNativeMenu(menu!, readyValue);
  return menu!;
}

async function selectPanel(container: HTMLElement, value: string) {
  const menu = await openPanelMenu(container, value);
  const item = menu.querySelector<HTMLButtonElement>(`button[data-value="${value}"]`);
  if (!item) {
    throw new Error(`Expected Layout panel action: ${value}`);
  }
  item.click();
  await waitForSolid(() =>
    expect(menu.querySelector(".oc-menu")?.matches(":popover-open")).toBe(false),
  );
}

function directSession(key: string, agentId?: string): GatewaySessionRow {
  return { key, agentId, kind: "direct", updatedAt: 0 };
}

function createTerminalPane(client = gateway(), compact = false) {
  const { pane, state } = createTestChatPane({
    client,
    sessions: createSessionCapabilityFixture(),
  });
  getPaneTestRuntime(pane).mergedChrome = compact;
  getPaneTestRuntime(pane).compact = compact;
  const container = document.body.appendChild(document.createElement("div"));
  onTestFinished(() => container.remove());
  const paint = (
    row: GatewaySessionRow | undefined,
    workspace = createPaneHeaderWorkspaceFixture(state),
  ) => {
    renderPaneHeaderInto(
      pane.renderPaneHeader(workspace, row, false, undefined, false, null),
      container,
    );
    flush();
  };
  const panelActionIds = () =>
    [...container.querySelectorAll('.chat-pane__layout-menu button[role^="menuitem"]')].map(
      (item) => item.getAttribute("data-value"),
    );
  const topButton = (label: string) =>
    container.querySelector(`button[aria-label="${label}"]:not([role^="menuitem"])`);
  const session = directSession(state.sessionKey);
  return { pane, state, container, paint, panelActionIds, topButton, session };
}

it.each(["session", "owner", "target", "client", "reconnect"] as const)(
  "closes terminal continuation after a %s ownership change",
  async (change) => {
    const client = gateway({ gatewayUrl: "wss://gateway.example/control" });
    const { pane, container, paint } = createTerminalPane(client);
    const row = directSession("bare-session", "row-agent");

    await runPaneHeaderAction(pane, { kind: "continue-in-terminal" }, row);
    paint(row);
    const command = await waitForSolid(() => {
      const text =
        container.querySelector(".continue-in-terminal-dialog .login-gate__command code")
          ?.textContent ?? "";
      expect(text).toMatch(/^openclaw resume --handoff [A-Za-z0-9_-]+$/u);
      return text;
    });
    expect(decodeResumeHandoff(command.slice("openclaw resume --handoff ".length))).toEqual({
      version: 1,
      sessionKey: "agent:row-agent:bare-session",
      gatewayUrl: "wss://gateway.example/control",
    });

    if (change === "owner") {
      paint({ ...row, agentId: "other-agent" });
    } else if (change === "target") {
      pane.context.gateway.connection.gatewayUrl = "wss://other.example/control";
      paint(row);
      pane.context.gateway.connection.gatewayUrl = "ws://example.test";
    } else if (change === "client") {
      pane.context.gateway.snapshot.client = gateway({
        gatewayUrl: "wss://replacement.example/control",
      });
      paint(row);
      pane.context.gateway.snapshot.client = client;
    } else if (change === "reconnect") {
      pane.connectionGeneration += 1;
      paint(row);
      pane.connectionGeneration -= 1;
    } else {
      paint({ ...row, key: "other-session" });
    }

    expect(container.querySelector("openclaw-modal-dialog")).toBeNull();
    paint(row);
    expect(container.querySelector("openclaw-modal-dialog")).toBeNull();
  },
);

it("disables terminal continuation with query-specific guidance", async () => {
  const client = gateway({
    gatewayUrl: "wss://gateway.example/control?route=alpha",
  });
  const { container, paint } = createTerminalPane(client);
  const row = directSession("main", "alpha");
  paint(row);

  const menu = container.querySelector<HTMLElement>("openclaw-chat-header-session-menu")!;
  await selectNativeMenu(menu, "submenu:advanced");
  await selectNativeMenu(menu, "submenu:open-in");
  const continuation = await waitForSolid(() => {
    const item = menu.querySelector<HTMLButtonElement>('[data-value="continue-in-terminal"]');
    expect(item).not.toBeNull();
    return item!;
  });
  expect(continuation.disabled).toBe(true);
  expect(continuation.title).toBe(
    "Query-routed Gateway URLs cannot create credential-free continuation commands because authentication and stored device scope are not query-aware. Use a manually authenticated CLI target or a queryless configured Gateway URL.",
  );
});

it("offers Terminal in the compact fallback only when available", async () => {
  const { state, container, paint, session, panelActionIds, topButton } = createTerminalPane(
    undefined,
    true,
  );
  state.terminalAvailable = true;
  const renderHeader = () =>
    paint(session, {
      ...createPaneHeaderWorkspaceFixture(state),
      onToggleTerminal: state.terminalAvailable
        ? () => state.updateSidebarLayout(openSlot(state.sidebarLayout, "terminal"))
        : undefined,
    });

  renderHeader();
  expect(topButton("Toggle terminal")).toBeNull();
  await selectPanel(container, "terminal");
  expect(state.sidebarLayout.columns[0]?.panels.map((panel) => panel.slot)).toContain("terminal");

  state.terminalAvailable = false;
  renderHeader();
  expect(panelActionIds().includes("terminal")).toBe(false);
});

it("offers Desktop in the compact fallback only for observable session targets", async () => {
  const fixture = createTerminalPane(undefined, true);
  const { pane, state, container, paint } = fixture;
  const { session: localSession, panelActionIds, topButton } = fixture;
  const snapshot = pane.context.gateway.snapshot;
  snapshot.hello = desktopHello([], ["operator.admin"]);
  paint(localSession);
  await openPanelMenu(container);
  expect(topButton("Toggle desktop panel")).toBeNull();
  expect(panelActionIds()).not.toContain("desktop");

  snapshot.hello = desktopHello(["desktop.observe"], ["operator.admin"]);
  const onToggleDesktop = vi.fn();
  const renderDesktopHeader = (session: GatewaySessionRow | undefined) =>
    paint(session, { ...createPaneHeaderWorkspaceFixture(state), onToggleDesktop });
  const targetCases: Array<[string, GatewaySessionRow]> = [
    ["local", localSession],
    ["cloud", { ...activePlacementSession(localSession.key), execNode: "stale-node" }],
    ["node", { ...localSession, execNode: "  paired-node  " }],
  ];
  for (const [name, session] of targetCases) {
    renderDesktopHeader(session);
    await openPanelMenu(container);
    expect(topButton("Toggle desktop panel")).toBeNull();
    expect(panelActionIds(), name).toContain("desktop");
    await selectPanel(container, "desktop");
    expect(onToggleDesktop, name).toHaveBeenCalledTimes(1);
    onToggleDesktop.mockClear();
  }

  for (const placement of [
    { state: "requested" },
    { state: "reclaimed", environmentId: "former-worker" },
    undefined,
  ]) {
    renderDesktopHeader(
      placement && {
        ...localSession,
        execNode: "must-not-fall-back",
        placement: placement as GatewaySessionRow["placement"],
      },
    );
    await openPanelMenu(container);
    expect(topButton("Toggle desktop panel")).toBeNull();
    expect(panelActionIds()).not.toContain("desktop");
  }

  snapshot.hello = desktopHello(["desktop.observe"], ["operator.read"]);
  renderDesktopHeader(localSession);
  await openPanelMenu(container);
  expect(topButton("Toggle desktop panel")).toBeNull();
  expect(panelActionIds()).not.toContain("desktop");
});

it("keeps Browser reachable through the compact fallback", async () => {
  const { state, container, paint, session, panelActionIds } = createTerminalPane(undefined, true);
  state.browserPanelAvailable = false;
  paint(session);
  await openPanelMenu(container);
  expect(container.querySelector(".chat-browser-panel-toggle")).toBeNull();
  expect(panelActionIds()).not.toContain("browser");

  state.browserPanelAvailable = true;
  const onToggleBrowser = vi.fn();
  paint(session, { ...createPaneHeaderWorkspaceFixture(state), onToggleBrowser });
  await openPanelMenu(container);
  expect(panelActionIds()).toContain("browser");
  await selectPanel(container, "browser");
  await waitForSolid(() => expect(onToggleBrowser).toHaveBeenCalledOnce());
});
