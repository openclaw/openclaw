/* @vitest-environment jsdom */

import { expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import { gatewayHelloForMethods as desktopHello } from "../../test-helpers/gateway-methods.ts";
import {
  activePlacementSession,
  createPaneHeaderWorkspaceFixture,
  createGatewayBrowserClientFixture as gateway,
  createSessionCapabilityFixture,
  createTestChatPane,
  getPaneTestRuntime,
} from "./chat-pane.test-support.ts";
import type { HeaderPanelAction } from "./components/chat-header-panel-actions.tsx";
import { openSlot } from "./sidebar-layout.ts";

function activate(action: HeaderPanelAction | undefined) {
  if (!action || action.kind === "status") {
    throw new Error("Expected an available panel action");
  }
  return action.onActivate();
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
  const header = (
    row: GatewaySessionRow | undefined,
    workspace = createPaneHeaderWorkspaceFixture(state),
  ) => pane.renderPaneHeader(workspace, row, false, undefined, false, null);
  const session = directSession(state.sessionKey);
  return { pane, state, header, session };
}

it.each(["session", "owner", "target", "client", "reconnect"] as const)(
  "closes terminal continuation after a %s ownership change",
  async (change) => {
    const client = gateway({ gatewayUrl: "wss://gateway.example/control" });
    const { pane, header } = createTerminalPane(client);
    const row = directSession("bare-session", "row-agent");

    await pane.handleHeaderSessionAction({ kind: "continue-in-terminal" }, row);
    expect(header(row).continueInTerminal).toBeDefined();

    if (change === "owner") {
      header({ ...row, agentId: "other-agent" });
    } else if (change === "target") {
      pane.context.gateway.connection.gatewayUrl = "wss://other.example/control";
      header(row);
      pane.context.gateway.connection.gatewayUrl = "ws://example.test";
    } else if (change === "client") {
      pane.context.gateway.snapshot.client = gateway({
        gatewayUrl: "wss://replacement.example/control",
      });
      header(row);
      pane.context.gateway.snapshot.client = client;
    } else if (change === "reconnect") {
      pane.connectionGeneration += 1;
      header(row);
      pane.connectionGeneration -= 1;
    } else {
      header({ ...row, key: "other-session" });
    }

    expect(pane.headerPresentation.continueInTerminalDialog).toBeNull();
    expect(header(row).continueInTerminal).toBeUndefined();
  },
);

it("explains why query-routed Gateways cannot continue in a terminal", () => {
  const { header } = createTerminalPane(
    gateway({ gatewayUrl: "wss://gateway.example/?route=alpha" }),
  );
  const reason = header(directSession("main", "alpha")).header.sessionMenuAction
    ?.actionDisabledReasons["continue-in-terminal"];
  expect(reason).toContain("Query-routed Gateway URLs");
  expect(reason).toContain("queryless configured Gateway URL");
});

it.each([
  ["terminal", "terminalAvailable", "onToggleTerminal"],
  ["browser", "browserPanelAvailable", "onToggleBrowser"],
] as const)(
  "offers %s in the compact fallback only when available",
  async (slot, field, action) => {
    const { state, header, session } = createTerminalPane(undefined, true);
    const draw = () =>
      header(session, {
        ...createPaneHeaderWorkspaceFixture(state),
        [action]: state[field]
          ? () => state.updateSidebarLayout(openSlot(state.sidebarLayout, slot))
          : undefined,
      }).header.panelMenuActions?.find(({ id }) => id === slot);
    state[field] = false;
    expect(draw()).toBeUndefined();
    state[field] = true;
    await activate(draw());
    expect(state.sidebarLayout.columns[0]?.panels.map((panel) => panel.slot)).toContain(slot);
    state[field] = false;
    expect(draw()).toBeUndefined();
  },
);

it.each([
  ["unadvertised", false],
  ["local", true],
  ["cloud", true],
  ["paired", true],
  ["requested", false],
  ["reclaimed", false],
  ["missing", false],
  ["read-only", false],
] as const)("gates compact Desktop for %s targets", async (kind, available) => {
  const { pane, state, header, session: localSession } = createTerminalPane(undefined, true);
  const onToggleDesktop = vi.fn();
  pane.context.gateway.snapshot.hello = desktopHello(
    kind === "unadvertised" ? [] : ["desktop.observe"],
    [kind === "read-only" ? "operator.read" : "operator.admin"],
  );
  let row: GatewaySessionRow | undefined = localSession;
  if (kind === "cloud") {
    row = { ...activePlacementSession(row.key), execNode: "stale-node" };
  }
  if (kind === "paired") {
    row = { ...row, execNode: "  paired-node  " };
  }
  if (kind === "requested" || kind === "reclaimed") {
    row = {
      ...row,
      execNode: "must-not-fall-back",
      placement: {
        ...activePlacementSession(row.key).placement!,
        state: kind,
        environmentId: "former-worker",
      },
    };
  }
  if (kind === "missing") {
    row = undefined;
  }
  const action = header(row, {
    ...createPaneHeaderWorkspaceFixture(state),
    onToggleDesktop,
  }).header.panelMenuActions?.find(({ id }) => id === "desktop");
  if (available) {
    await activate(action);
    expect(onToggleDesktop).toHaveBeenCalledOnce();
  } else {
    expect(action).toBeUndefined();
  }
});
