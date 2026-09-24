import { render } from "lit";
import { expect, vi } from "vitest";
import type { GatewaySessionRow, SessionsPatchResult } from "../../api/types.ts";
import { loadSettings, patchSettings } from "../../app/settings.ts";
import type { BoardWidgetPageMenu } from "../../components/board/board-widget-cell-render.ts";
import type { BoardCommandEvent, BoardProvider } from "../../lib/board/provider.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import { createMockBoardProvider } from "../../test-helpers/board-provider.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import type { ResolvedBoardView } from "./chat-pane-shared.ts";
import {
  createGatewayBrowserClientFixture,
  createTestChatPane,
  type TestChatPane,
} from "./chat-pane.test-support.ts";
import { createPageState } from "./chat-state-page.ts";
import { createBackgroundTasksProps } from "./components/chat-background-tasks.ts";
import { createSessionWorkspaceProps } from "./components/chat-session-workspace.ts";
import { isSidebarSlotVisible, type SidebarLayout } from "./sidebar-layout.ts";

type DashboardPane = TestChatPane & {
  visuallyPresented: boolean;
  fullscreenBoardWidgetMenu: (
    layout: SidebarLayout,
    board?: ResolvedBoardView,
  ) => BoardWidgetPageMenu | undefined;
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
type HeaderMenu = HTMLElement & { updateComplete: Promise<boolean> };

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
  patchSettings({
    sessionKey: current.key,
    sidebarSessionLayouts: options.savedLayout ? { [current.key]: options.savedLayout } : {},
  });
  const state = createPageState(
    pane.context,
    { invalidate: vi.fn(), afterCommit: () => () => {} },
    pane,
  );
  pane.state = state;
  pane.sessionKey = current.key;
  pane.routeFace = "dashboard";
  pane.dashboardExpanded = options.expandedLink ?? false;
  pane.paneWidth = 1400;
  pane.boardProvider = createMockBoardProvider(current.key);
  // The detached pane exposes real controller methods without running unrelated
  // connectedCallback polling. Header templates are mounted separately below.
  vi.spyOn(pane, "requestUpdate").mockImplementation(() => {});
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
  const mount = document.body.appendChild(document.createElement("div"));
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
    render(
      pane.renderPaneHeader(
        createSessionWorkspaceProps(state),
        createBackgroundTasksProps(state),
        state.sessionsResult?.sessions[0],
        false,
        undefined,
        false,
        null,
        state.sidebarLayout,
      ),
      mount,
    );
    const menu = mount.querySelector<HeaderMenu>("openclaw-chat-header-session-menu");
    expect(menu).not.toBeNull();
    await menu!.updateComplete;
    if (pane.narrow) {
      select(menu!, "compact:open-layout");
      await menu!.updateComplete;
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

export function select(menu: ParentNode, value: string) {
  const dropdown = menu.querySelector("wa-dropdown");
  expect(dropdown).not.toBeNull();
  dropdown!.dispatchEvent(
    new CustomEvent("wa-select", {
      bubbles: true,
      cancelable: true,
      composed: true,
      detail: { item: { value } },
    }),
  );
}

export function expectPresentation(layout: SidebarLayout, expanded: boolean) {
  expect(isSidebarSlotVisible(layout, "dashboard")).toBe(true);
  expect(layout.expanded).toBe(expanded);
  expect(isSidebarSlotVisible(layout, "conversation")).toBe(!expanded);
}
