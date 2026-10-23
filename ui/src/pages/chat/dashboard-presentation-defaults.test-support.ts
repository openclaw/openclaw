import { flush } from "solid-js";
import { expect, onTestFinished, vi } from "vitest";
import type { GatewaySessionRow, SessionsPatchResult } from "../../api/types.ts";
import { loadSettings, patchSettings } from "../../app/settings.ts";
import type { BoardWidgetPageMenu } from "../../components/board/board-widget-cell-options.ts";
import type { BoardCommandEvent, BoardProvider } from "../../lib/board/provider.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import { createMockBoardProvider } from "../../test-helpers/board-provider.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import type { ChatPaneRuntime } from "./chat-pane-render.ts";
import type { ResolvedBoardView } from "./chat-pane-shared.ts";
import {
  createGatewayBrowserClientFixture,
  createPaneHeaderWorkspaceFixture,
  createTestChatPane,
  type TestChatPane,
} from "./chat-pane.test-support.ts";
import { createPageState } from "./chat-state-page.ts";
import { renderPaneHeaderInto } from "./components/chat-pane-header.test-support.ts";
import { isSidebarSlotVisible, type SidebarLayout } from "./sidebar-layout.ts";

type DashboardPane = TestChatPane & {
  visuallyPresented: boolean;
  dashboardControls: ChatPaneRuntime["dashboardControls"];
  configureHeaderPanelPresentation: ChatPaneRuntime["configureHeaderPanelPresentation"];
  pageBoardWidgetMenu: (layout: SidebarLayout) => BoardWidgetPageMenu | undefined;
  boardProvider: BoardProvider;
  routeFace: "chat" | "dashboard" | undefined;
  dashboardExpanded: boolean;
  narrow: boolean;
  paneWidth: number;
  resolveBoardView: () => ResolvedBoardView;
  syncRetainedBoardSession: (board: ResolvedBoardView) => void;
  captureNavigationFace: () => "chat" | "dashboard" | undefined;
  commitSidebarPanelResize: (layout: SidebarLayout, columnId: string, size: number) => void;
  handleBoardCommand: (event: BoardCommandEvent) => void;
  saveDashboardDefault: (row: GatewaySessionRow, agentId: string | undefined) => Promise<void>;
};
type HeaderMenu = HTMLElement;

export const key = "agent:main:dashboard-defaults";

export function session(overrides: Partial<GatewaySessionRow> = {}): GatewaySessionRow {
  return {
    key,
    agentId: "main",
    sessionId: "dashboard-session",
    kind: "direct",
    updatedAt: 10,
    boardFace: "dashboard",
    boardPresentation: "split",
    ...overrides,
  };
}

async function settleDashboardMenu() {
  flush();
  await Promise.resolve();
  flush();
}

async function openDashboardMenu(menu: HTMLElement) {
  await settleDashboardMenu();
  const panel = menu.querySelector<HTMLElement>(".oc-menu")!;
  if (!panel.matches(":popover-open")) {
    menu.querySelector<HTMLButtonElement>(".chat-dashboard-menu__trigger")!.click();
    await settleDashboardMenu();
  }
  expect(panel.matches(":popover-open")).toBe(true);
}

export function createDashboardHarness(
  options: {
    row?: GatewaySessionRow;
    savedLayout?: SidebarLayout;
    metadataPending?: boolean;
    expandedLink?: boolean;
    scopes?: string[];
  } = {},
) {
  let current = options.row ?? session();
  let patchReply: Promise<SessionsPatchResult> | undefined;
  const request = vi.fn(async (method: string) => {
    if (method === "sessions.list") {
      return sessionsResult([current], current.updatedAt ?? 0);
    }
    if (method === "sessions.patch") {
      if (!patchReply) {
        throw new Error("Unexpected sessions.patch without a configured acknowledgement");
      }
      const result = await patchReply;
      if (result && result.entry.sessionId === current.sessionId) {
        current = {
          ...current,
          ...(result.entry.updatedAt !== undefined ? { updatedAt: result.entry.updatedAt } : {}),
          ...(result.entry.boardFace !== undefined ? { boardFace: result.entry.boardFace } : {}),
          ...(Object.hasOwn(result.entry, "boardPresentation")
            ? { boardPresentation: result.entry.boardPresentation }
            : {}),
        };
      }
      return result;
    }
    if (method === "sessions.describe") {
      return { session: current };
    }
    return {};
  });
  const client = createGatewayBrowserClientFixture({ request });
  const harness = createTestChatPane({ client });
  const pane = harness.pane as DashboardPane;
  Object.defineProperty(pane, "isConnected", { configurable: true, value: false });
  patchSettings({
    sessionKey: current.key,
    sidebarSessionLayouts: options.savedLayout ? { [current.key]: options.savedLayout } : {},
  });
  const state = createPageState(pane.context, { afterCommit: () => () => {} }, pane);
  pane.state = state;
  pane.sessionKey = current.key;
  pane.routeFace = "dashboard";
  pane.dashboardExpanded = options.expandedLink ?? false;
  pane.paneWidth = 1400;
  pane.boardProvider = createMockBoardProvider(current.key);
  // The detached pane exposes real runtime methods without running unrelated
  // connectedCallback polling. Header templates are mounted separately below.
  pane.context.gateway.snapshot.hello = gatewayHelloForMethods(
    ["sessions.patch"],
    options.scopes ?? ["operator.write", "operator.read"],
  );
  state.client = client;
  state.connected = true;
  state.connectionEpoch = pane.connectionGeneration;
  state.hello = pane.context.gateway.snapshot.hello;
  state.sessionKey = current.key;
  state.sessionsResult = options.metadataPending ? null : sessionsResult([current], 10);
  Object.defineProperty(pane, "isConnected", { configurable: true, value: true });
  const mount = document.body.appendChild(document.createElement("div"));
  let dashboard: ReturnType<typeof mountSolid> | undefined;
  const publishRow = (row: GatewaySessionRow) => {
    current = row;
    state.sessionsResult = sessionsResult([row], row.updatedAt ?? 0);
  };
  const sync = () => pane.syncRetainedBoardSession(pane.resolveBoardView());
  const revisit = () => {
    // Exercise the real presented setter and its activation reset, without
    // starting unrelated connection hydration on this detached fixture.
    Object.defineProperty(pane, "isConnected", { configurable: true, value: false });
    pane.presented = false;
    pane.presented = true;
    Object.defineProperty(pane, "isConnected", { configurable: true, value: true });
    sync();
  };
  const saved = () => loadSettings().sidebarSessionLayouts?.[state.sessionKey];
  const resize = () => {
    const column = state.sidebarLayout.columns[0];
    expect(column).toBeDefined();
    pane.commitSidebarPanelResize(state.sidebarLayout, column!.id, 620);
  };
  const header = async () => {
    const presentation = pane.renderPaneHeader(
      createPaneHeaderWorkspaceFixture(state),
      state.sessionsResult?.sessions[0],
      false,
      undefined,
      false,
      null,
      state.sidebarLayout,
    );
    pane.configureHeaderPanelPresentation({
      nativeHeader: presentation.header,
      headerDetails: undefined,
      state,
      currentAgentId: "main",
      sidebarLayout: state.sidebarLayout,
      panelDefinitions: presentation.header.panelDefinitions ?? [],
      catalog: false,
      externalPanelsToggle: true,
    });
    renderPaneHeaderInto(presentation, mount);
    await settleDashboardMenu();
    if (!dashboard) {
      // The board renderer is mocked here; host the actual retained control
      // produced by the header, as the Dashboard view does.
      dashboard = mountSolid(() => pane.dashboardControls);
      onTestFinished(dashboard.unmount);
    }
    const menu = dashboard.container.querySelector<HeaderMenu>(".chat-dashboard-menu");
    expect(menu).not.toBeNull();
    if (
      state.sidebarLayout.columns.some((column) =>
        column.panels.some((panel) => panel.slot === "dashboard"),
      )
    ) {
      await openDashboardMenu(menu!);
    } else {
      expect(
        presentation.header.layoutMenuActions?.find((action) => action.id === "dashboard-default"),
      ).toBeUndefined();
      expect(menu!.querySelector(".oc-menu")?.matches(":popover-open")).toBe(false);
    }
    return menu!;
  };
  return {
    ...harness,
    pane,
    state,
    client,
    mount,
    request,
    publishRow,
    sync,
    revisit,
    saved,
    resize,
    header,
    setPatchReply: (promise: Promise<SessionsPatchResult>) => {
      patchReply = promise;
    },
  };
}

export async function select(menu: ParentNode, value: string) {
  if (!(menu instanceof HTMLElement) || !menu.matches(".chat-dashboard-menu")) {
    throw new Error("Expected native Dashboard menu");
  }
  await openDashboardMenu(menu);
  const item = menu.querySelector<HTMLElement>(`[data-value="${value}"]`);
  expect(item, "Expected Dashboard action: " + value).not.toBeNull();
  item!.click();
  await settleDashboardMenu();
}

export function expectPresentation(layout: SidebarLayout, expanded: boolean) {
  expect(isSidebarSlotVisible(layout, "dashboard")).toBe(true);
  expect(layout.expanded).toBe(expanded);
  expect(isSidebarSlotVisible(layout, "conversation")).toBe(!expanded);
}
