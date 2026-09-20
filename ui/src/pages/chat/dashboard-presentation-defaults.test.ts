/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { SessionsPatchResult } from "../../api/types.ts";
import { loadSettings, patchSettings } from "../../app/settings.ts";
import { t } from "../../i18n/index.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import { showToast } from "../../lib/toast.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { ensureBoardViewElement } from "./board-session-surface.ts";
import { createChatPaneRails } from "./chat-pane-rails.ts";
import { sidebarRegionCallbacks } from "./chat-pane-sidebar-layout.ts";
import {
  createDashboardHarness,
  expectPresentation,
  key,
  select,
  session,
} from "./dashboard-presentation-defaults.test-support.ts";
import {
  closeSlot,
  ensureSidebarConversation,
  isSidebarSlotVisible,
  normalizeSidebarLayout,
  openDashboardPresentation,
  openSlot,
  promoteSidebarPanel,
  setSidebarDock,
  setSidebarExpanded,
  setSidebarOpen,
  toggleSidebarPanelExpanded,
  sidebarMainPanel,
  sidebarActivePanel,
} from "./sidebar-layout.ts";

vi.mock("../../lib/toast.ts", () => ({ showToast: vi.fn() }));
// Board widgets own their rendering tests; these tests keep the real pane, page
// state, settings, session capability, and header/menu composition.
vi.mock("../../components/board/board-view.ts", () => {
  if (!customElements.get("openclaw-board-view")) {
    customElements.define("openclaw-board-view", class extends HTMLElement {});
  }
  return {};
});

const defaultAction = '[value="quick:layout:dashboard-default"]';
const defaultStatus = '[data-menu-status="dashboard-default"]';

beforeEach(() => {
  vi.stubGlobal("localStorage", createStorageMock());
  vi.stubGlobal("sessionStorage", createStorageMock());
  window.history.replaceState({}, "", "/");
});

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("dashboard default activation and personal layout persistence", () => {
  it("relocates only the visible fullscreen widget when a replacement task menu exists", async () => {
    await ensureBoardViewElement();
    const { pane } = createDashboardHarness();
    const board = { ...pane.resolveBoardView(), activeTabId: "research" };
    const expanded = openDashboardPresentation({ columns: [] }, "expanded");
    expect(pane.fullscreenBoardWidgetMenu(expanded, board)?.widget.name).toBe("source-map");
    expect(
      pane.fullscreenBoardWidgetMenu(openDashboardPresentation(expanded, "split"), board),
    ).toBeUndefined();
    expect(
      pane.fullscreenBoardWidgetMenu(expanded, { ...board, activeTabId: "main" }),
    ).toBeUndefined();
    const narrow = {
      ...board,
      snapshot: {
        ...board.snapshot,
        widgets: board.snapshot.widgets.map((widget) =>
          widget.name === "source-map" ? { ...widget, sizeW: 6 } : widget,
        ),
      },
    };
    expect(pane.fullscreenBoardWidgetMenu(expanded, narrow)).toBeUndefined();
    pane.visuallyPresented = false;
    expect(pane.fullscreenBoardWidgetMenu(expanded, board)).toBeUndefined();
    pane.visuallyPresented = true;
    pane.state.sessionsResult = null;
    expect(pane.fullscreenBoardWidgetMenu(expanded, board)).toBeUndefined();
  });

  it.each(["shared", "personal"] as const)(
    "opens the %s expanded preference through the registered keyboard handler",
    (kind) => {
      const h = createDashboardHarness({
        row: session({ boardPresentation: kind === "shared" ? "expanded" : "split" }),
        savedLayout:
          kind === "personal"
            ? {
                ...openDashboardPresentation({ columns: [] }, "expanded"),
                dashboardPresentationOverride: "expanded",
              }
            : undefined,
      });
      h.pane.routeFace = "chat";
      h.pane.active = true;
      h.state.updateSidebarLayout(closeSlot(h.state.sidebarLayout, "dashboard"));
      const event = new KeyboardEvent("keydown", {
        key: "G",
        code: "KeyG",
        metaKey: true,
        shiftKey: true,
        altKey: true,
        cancelable: true,
      });
      h.pane.handleDocumentKeydown(event);
      expect(event.defaultPrevented).toBe(true);
      expectPresentation(h.state.sidebarLayout, true);
      expect(h.saved()?.dashboardPresentationOverride).toBe(
        kind === "personal" ? "expanded" : null,
      );
    },
  );

  it("does not overwrite a newer cross-tab choice when opening Files", () => {
    const h = createDashboardHarness({
      row: session({ boardPresentation: "expanded" }),
      savedLayout: {
        ...openDashboardPresentation({ columns: [] }, "expanded"),
        dashboardPresentationOverride: null,
      },
    });
    h.sync();
    const current = h.state.sidebarLayout;
    patchSettings({
      sidebarSessionLayouts: { [key]: { ...current, dashboardPresentationOverride: "split" } },
    });
    h.state.updateSidebarLayout(openSlot(current, "workspace"));
    expect(h.saved()?.dashboardPresentationOverride).toBe("split");
    expect(h.state.sidebarLayout.dashboardPresentationOverride).toBe("split");
    h.revisit();
    expect(sidebarMainPanel(h.state.sidebarLayout)?.slot).toBe("dashboard");
    expect(h.state.sidebarLayout.expanded).toBe(false);
    expect(isSidebarSlotVisible(h.state.sidebarLayout, "workspace")).toBe(true);
  });

  it.each([
    { initial: "expanded", next: null, shared: "split" },
    { initial: "expanded", next: "split", shared: "expanded" },
    { initial: "split", next: "expanded", shared: "split" },
  ] as const)(
    "uses the latest cross-tab override $next when opening Dashboard",
    ({ initial, next, shared }) => {
      const savedLayout = {
        ...openDashboardPresentation({ columns: [] }, initial),
        dashboardPresentationOverride: initial,
      };
      const h = createDashboardHarness({
        savedLayout,
        row: session({ boardPresentation: shared }),
      });
      h.sync();
      h.state.updateSidebarLayout(openSlot(h.state.sidebarLayout, "terminal"));
      const rails = createChatPaneRails({
        state: h.state,
        sidebarLayout: h.state.sidebarLayout,
        presentationId: "cross-tab-dashboard",
        presented: true,
        gatewaySnapshot: h.pane.context.gateway.snapshot,
        setObserverVisibility: vi.fn(),
        updateSidebarLayout: h.state.updateSidebarLayout,
      });
      patchSettings({
        sidebarSessionLayouts: { [key]: { ...savedLayout, dashboardPresentationOverride: next } },
      });
      rails.openPanelSlot("dashboard");
      expectPresentation(h.state.sidebarLayout, (next ?? shared) === "expanded");
      expect(h.saved()?.dashboardPresentationOverride).toBe(next);
    },
  );

  it("keeps ordinary Chat and active Dashboard renders storage-free", () => {
    const h = createDashboardHarness();
    const getItem = vi.spyOn(localStorage, "getItem");
    h.pane.routeFace = "chat";
    getItem.mockClear();
    h.sync();
    h.sync();
    expect(getItem).not.toHaveBeenCalled();
    h.pane.routeFace = "dashboard";
    h.sync();
    getItem.mockClear();
    h.sync();
    h.sync();
    expect(getItem).not.toHaveBeenCalled();
  });

  it("activates a legacy Dashboard tab without adopting a differing shared mode", () => {
    const legacy = openSlot(openDashboardPresentation({ columns: [] }, "split"), "terminal");
    const h = createDashboardHarness({
      savedLayout: legacy,
      row: session({ boardPresentation: "expanded" }),
    });
    h.sync();
    const rails = createChatPaneRails({
      state: h.state,
      sidebarLayout: h.state.sidebarLayout,
      presentationId: "legacy-dashboard",
      presented: true,
      gatewaySnapshot: h.pane.context.gateway.snapshot,
      setObserverVisibility: vi.fn(),
      updateSidebarLayout: h.state.updateSidebarLayout,
    });
    rails.openPanelSlot("dashboard");
    expectPresentation(h.state.sidebarLayout, false);
    expect(h.saved()?.dashboardPresentationOverride).toBeUndefined();
    h.revisit();
    expectPresentation(h.state.sidebarLayout, false);
  });

  it.each(["split", "expanded"] as const)(
    "keeps a transient %s request through Chat-to-Dashboard activation, but not a revisit",
    (requested) => {
      const shared = requested === "expanded" ? "split" : "expanded";
      const h = createDashboardHarness({ row: session({ boardPresentation: shared }) });
      h.pane.routeFace = "chat";
      h.sync();
      h.pane.handleBoardCommand({
        sessionKey: key,
        command: { kind: "set_chat_dock", dock: requested === "expanded" ? "hidden" : "right" },
      });
      expectPresentation(h.state.sidebarLayout, requested === "expanded");
      // A child update can run before the parent publishes the requested route.
      h.sync();
      h.pane.routeFace = "dashboard";
      h.sync();
      expectPresentation(h.state.sidebarLayout, requested === "expanded");
      expect(
        loadSettings().sidebarSessionLayouts?.[key]?.dashboardPresentationOverride,
      ).toBeUndefined();
      h.pane.routeFace = "chat";
      h.sync();
      h.pane.routeFace = "dashboard";
      h.sync();
      expectPresentation(h.state.sidebarLayout, shared === "expanded");
    },
  );

  it("opens a dashboard route in split only once and preserves a later panel choice", () => {
    const h = createDashboardHarness();
    h.state.updateSidebarLayout(openSlot(h.state.sidebarLayout, "terminal"));
    h.sync();
    expectPresentation(h.state.sidebarLayout, false);
    h.state.updateSidebarLayout(openSlot(h.state.sidebarLayout, "terminal"));
    h.sync();
    expect(isSidebarSlotVisible(h.state.sidebarLayout, "terminal")).toBe(true);
    expect(isSidebarSlotVisible(h.state.sidebarLayout, "dashboard")).toBe(false);
  });

  it("waits for the selected authoritative row, then inherits without creating an override", () => {
    const h = createDashboardHarness({ metadataPending: true });
    h.sync();
    expect(isSidebarSlotVisible(h.state.sidebarLayout, "dashboard")).toBe(false);
    expect(h.saved()).toBeUndefined();
    h.state.sessionsResult = sessionsResult([session({ key: "agent:main:other" })], 10);
    h.sync();
    expect(isSidebarSlotVisible(h.state.sidebarLayout, "dashboard")).toBe(false);

    h.publishRow(session({ boardPresentation: "expanded" }));
    h.sync();
    expectPresentation(h.state.sidebarLayout, true);
    expect(h.saved()).toBeUndefined();
    h.resize();
    expect(h.saved()?.dashboardPresentationOverride).toBeNull();
    expect(h.saved()?.columns[0]?.width).toBe(620);

    h.publishRow(session({ boardPresentation: "split", updatedAt: 20 }));
    h.sync();
    expectPresentation(h.state.sidebarLayout, true);
    h.revisit();
    expectPresentation(h.state.sidebarLayout, false);
    expect(h.state.sidebarLayout.columns[0]?.width).toBe(620);
  });

  it("keeps a personal choice when the shared default is still unknown", () => {
    const h = createDashboardHarness({ metadataPending: true, expandedLink: true });
    h.sync();
    h.state.updateSidebarLayout(openDashboardPresentation(h.state.sidebarLayout, "split"), {
      dashboardPresentation: "personal",
    });
    expect(h.saved()?.dashboardPresentationOverride).toBe("split");
    h.publishRow(session({ boardPresentation: "expanded" }));
    h.pane.dashboardExpanded = false;
    h.revisit();
    expectPresentation(h.state.sidebarLayout, false);
  });

  it("does not apply a changed shared default when the reconnect epoch advances", () => {
    const h = createDashboardHarness();
    h.sync();
    h.publishRow(session({ boardPresentation: "expanded", updatedAt: 20 }));
    h.pane.connectionGeneration += 1;
    h.sync();
    expectPresentation(h.state.sidebarLayout, false);
    h.revisit();
    expectPresentation(h.state.sidebarLayout, true);
  });

  it("waits for metadata when a saved width carries explicit inheritance", () => {
    const savedLayout = {
      ...openDashboardPresentation({ columns: [] }, "split"),
      dashboardPresentationOverride: null,
    };
    const h = createDashboardHarness({ savedLayout, metadataPending: true });
    h.sync();
    expectPresentation(h.state.sidebarLayout, false);
    h.publishRow(session({ boardPresentation: "expanded" }));
    h.sync();
    expectPresentation(h.state.sidebarLayout, true);
    expect(h.saved()?.dashboardPresentationOverride).toBeNull();
  });

  it("updates the session cache without rearranging its active viewer", async () => {
    const h = createDashboardHarness();
    await h.sessions.refresh({ agentId: "main", force: true });
    const stop = h.sessions.subscribe((next) => {
      h.state.sessionsResult = next.result;
    });
    onTestFinished(stop);
    h.sync();
    h.sessions.reconcileChanged({
      ...session({ boardPresentation: "expanded", updatedAt: 20 }),
      sessionKey: key,
      reason: "patch",
    });
    expect(h.state.sessionsResult?.sessions[0]?.boardPresentation).toBe("expanded");
    h.sync();
    expectPresentation(h.state.sidebarLayout, false);
    expect((await h.header()).querySelector(defaultAction)).not.toBeNull();
    h.revisit();
    expectPresentation(h.state.sidebarLayout, true);
    expect((await h.header()).querySelector(defaultAction)).toBeNull();
    expect((await h.header()).querySelector(defaultStatus)?.textContent).toContain(
      t("chat.sidePanel.currentViewIsDefault"),
    );
    expect(h.saved()).toBeUndefined();
  });

  it("treats an absent optional default as split, not as unloaded metadata", () => {
    const h = createDashboardHarness({ row: session({ boardPresentation: undefined }) });
    h.sync();
    expectPresentation(h.state.sidebarLayout, false);
    expect(h.saved()).toBeUndefined();
    h.publishRow(session({ boardPresentation: "expanded", updatedAt: 20 }));
    h.sync();
    expectPresentation(h.state.sidebarLayout, false);
    h.revisit();
    expectPresentation(h.state.sidebarLayout, true);
  });

  it("does not convert a focused deep link or a later width save into a personal choice", () => {
    const h = createDashboardHarness({ metadataPending: true, expandedLink: true });
    h.sync();
    expectPresentation(h.state.sidebarLayout, true);
    expect(h.saved()).toBeUndefined();
    h.resize();
    expect(h.saved()?.dashboardPresentationOverride).toBeNull();
    h.publishRow(session());
    h.sync();
    expectPresentation(h.state.sidebarLayout, true);
    h.pane.dashboardExpanded = false;
    h.revisit();
    expectPresentation(h.state.sidebarLayout, false);
    expect(h.saved()?.dashboardPresentationOverride).toBeNull();
  });

  it("preserves personal precedence through a focused link and clears it when matching shared", async () => {
    const h = createDashboardHarness({ row: session({ boardPresentation: "expanded" }) });
    h.sync();
    await h.header();
    const focus = h.mount.querySelector<HTMLButtonElement>(".chat-panel-focus");
    expect(focus).not.toBeNull();
    focus!.click();
    expectPresentation(h.state.sidebarLayout, false);
    expect(h.saved()?.dashboardPresentationOverride).toBe("split");

    h.pane.dashboardExpanded = true;
    h.revisit();
    expectPresentation(h.state.sidebarLayout, true);
    h.resize();
    expect(h.saved()?.dashboardPresentationOverride).toBe("split");
    h.pane.dashboardExpanded = false;
    h.revisit();
    expectPresentation(h.state.sidebarLayout, false);

    h.state.updateSidebarLayout(openDashboardPresentation(h.state.sidebarLayout, "expanded"), {
      dashboardPresentation: "personal",
    });
    expect(h.saved()?.dashboardPresentationOverride).toBeNull();
    h.publishRow(session({ boardPresentation: "split", updatedAt: 30 }));
    h.sync();
    expectPresentation(h.state.sidebarLayout, true);
    h.revisit();
    expectPresentation(h.state.sidebarLayout, false);
  });

  it("records and clears a personal choice through the dashboard panel focus control", () => {
    const h = createDashboardHarness();
    h.sync();
    const focusPanel = () => {
      const dashboard = h.state.sidebarLayout.columns[0]?.panels.find(
        (panel) => panel.slot === "dashboard",
      );
      expect(dashboard).toBeDefined();
      sidebarRegionCallbacks({
        state: h.state,
        layout: h.state.sidebarLayout,
        closePanelSlot: vi.fn(),
        openPanelSlot: vi.fn(),
        forgetDiscussionUrl: vi.fn(),
        resizePanel: vi.fn(),
        setPanelOpen: vi.fn(),
      }).togglePanelExpanded(dashboard!.id);
    };
    focusPanel();
    expectPresentation(h.state.sidebarLayout, true);
    expect(h.saved()?.dashboardPresentationOverride).toBe("expanded");
    focusPanel();
    expectPresentation(h.state.sidebarLayout, false);
    expect(h.saved()?.dashboardPresentationOverride).toBeNull();
  });

  it("restores inherited versus personal presentation after page recreation", () => {
    const h = createDashboardHarness({ row: session({ boardPresentation: "expanded" }) });
    h.sync();
    h.resize();
    const inherited = h.saved();
    expect(inherited?.dashboardPresentationOverride).toBeNull();
    const reopened = createDashboardHarness({ savedLayout: inherited, row: session() });
    reopened.sync();
    expectPresentation(reopened.state.sidebarLayout, false);
    expect(reopened.state.sidebarLayout.columns[0]?.width).toBe(620);
    reopened.state.updateSidebarLayout(
      openDashboardPresentation(reopened.state.sidebarLayout, "expanded"),
      { dashboardPresentation: "personal" },
    );
    const reopenedAgain = createDashboardHarness({
      savedLayout: reopened.saved(),
      row: session(),
    });
    reopenedAgain.sync();
    expectPresentation(reopenedAgain.state.sidebarLayout, true);
    expect(reopenedAgain.saved()?.dashboardPresentationOverride).toBe("expanded");
  });

  it.each(
    ([undefined, "conversation", "dashboard"] as const).flatMap((mainPanelId) =>
      (["companion", "workspace"] as const).flatMap((sidePanel) =>
        ([null, "split"] as const).map((dashboardPresentationOverride) => ({
          mainPanelId,
          sidePanel,
          dashboardPresentationOverride,
        })),
      ),
    ),
  )(
    "restores $sidePanel with main $mainPanelId and override $dashboardPresentationOverride",
    ({ mainPanelId, sidePanel, dashboardPresentationOverride }) => {
      const split = openDashboardPresentation({ columns: [] }, "split");
      const savedLayout = normalizeSidebarLayout({
        ...setSidebarDock(
          openSlot(
            mainPanelId
              ? promoteSidebarPanel(ensureSidebarConversation(split), mainPanelId)
              : split,
            sidePanel,
          ),
          "left",
        ),
        dashboardPresentationOverride,
      });
      const row = session({
        boardPresentation: dashboardPresentationOverride === null ? "split" : "expanded",
      });
      const h = createDashboardHarness({ savedLayout, row });
      h.sync();
      expect(sidebarMainPanel(h.state.sidebarLayout)?.slot).toBe(mainPanelId);
      expect(sidebarActivePanel(h.state.sidebarLayout)?.slot).toBe(sidePanel);
      h.revisit();
      expect(h.state.sidebarLayout).toEqual(savedLayout);
      expect(h.saved()).toEqual(savedLayout);

      const reopened = createDashboardHarness({ savedLayout: h.saved(), row });
      reopened.sync();
      expect(reopened.state.sidebarLayout).toEqual(savedLayout);
      expect(reopened.saved()).toEqual(savedLayout);
    },
  );

  it.each(["closed side", "focused Chat", "focused Side chat"] as const)(
    "restores a retained Dashboard without disturbing %s",
    (view) => {
      const split = openSlot(openDashboardPresentation({ columns: [] }, "split"), "companion");
      const savedLayout = normalizeSidebarLayout({
        ...(view === "closed side"
          ? setSidebarOpen(split, false)
          : view === "focused Chat"
            ? setSidebarExpanded(ensureSidebarConversation(split), true)
            : toggleSidebarPanelExpanded(split, "companion")),
        dashboardPresentationOverride: null,
      });
      const h = createDashboardHarness({ savedLayout });
      h.sync();
      expect(h.state.sidebarLayout).toEqual(savedLayout);
      expect(isSidebarSlotVisible(h.state.sidebarLayout, "dashboard")).toBe(false);
      h.revisit();
      expect(h.state.sidebarLayout).toEqual(savedLayout);
      const reopened = createDashboardHarness({ savedLayout: h.saved() });
      reopened.sync();
      expect(reopened.state.sidebarLayout).toEqual(savedLayout);
      expect(reopened.saved()).toEqual(savedLayout);
    },
  );

  it.each(["shared default", "expanded link", "tool command"] as const)(
    "reveals Dashboard over an inactive retained tab for an explicit %s",
    (activation) => {
      const savedLayout = normalizeSidebarLayout({
        ...openSlot(openDashboardPresentation({ columns: [] }, "split"), "workspace"),
        dashboardPresentationOverride: null,
      });
      const h = createDashboardHarness({
        savedLayout,
        row: session({ boardPresentation: activation === "shared default" ? "expanded" : "split" }),
        expandedLink: activation === "expanded link",
      });
      h.sync();
      if (activation === "tool command") {
        h.pane.handleBoardCommand({
          sessionKey: key,
          command: { kind: "set_chat_dock", dock: "right" },
        });
      }
      expect(isSidebarSlotVisible(h.state.sidebarLayout, "dashboard")).toBe(true);
      expectPresentation(h.state.sidebarLayout, activation !== "tool command");
      expect(h.saved()).toEqual(savedLayout);
    },
  );

  it("opens a marked personal layout without waiting for shared metadata", () => {
    const savedLayout = {
      ...openDashboardPresentation({ columns: [] }, "split"),
      dashboardPresentationOverride: "expanded" as const,
    };
    const h = createDashboardHarness({ savedLayout, metadataPending: true });
    h.sync();
    expectPresentation(h.state.sidebarLayout, true);
    expect(h.saved()?.dashboardPresentationOverride).toBe("expanded");
  });

  it.each([true, false])(
    "preserves an unmarked legacy layout verbatim, including open=%s, across revisits",
    (open) => {
      const savedLayout = normalizeSidebarLayout({
        ...setSidebarDock(
          promoteSidebarPanel(
            openSlot(openSlot({ columns: [] }, "dashboard"), "terminal"),
            "terminal",
          ),
          "left",
        ),
        open,
      });
      const h = createDashboardHarness({ savedLayout, metadataPending: true });
      h.sync();
      expect(h.state.sidebarLayout).toEqual(savedLayout);
      h.publishRow(session({ boardPresentation: "expanded" }));
      h.revisit();
      expect(h.state.sidebarLayout).toEqual(savedLayout);
      h.resize();
      expect(h.saved()).not.toHaveProperty("dashboardPresentationOverride");
      const resized = structuredClone(h.state.sidebarLayout);
      h.revisit();
      expect(h.state.sidebarLayout).toEqual(resized);
      expect(sidebarMainPanel(h.state.sidebarLayout)?.slot).toBe("terminal");
    },
  );

  it("keeps transient tool presentation out of personal defaults even after resizing", () => {
    const h = createDashboardHarness();
    h.sync();
    h.pane.handleBoardCommand({
      sessionKey: key,
      command: { kind: "set_chat_dock", dock: "hidden" },
    });
    expectPresentation(h.state.sidebarLayout, true);
    expect(h.saved()).toBeUndefined();
    h.resize();
    expect(h.saved()?.dashboardPresentationOverride).toBeNull();
    h.revisit();
    expectPresentation(h.state.sidebarLayout, false);
  });
});

describe("dashboard shared default in the real header Layout menu", () => {
  it.each(["split", "expanded", "narrow"] as const)(
    "offers the differing %s view to a writer without requiring admin scope",
    async (view) => {
      const expanded = view === "expanded";
      const h = createDashboardHarness({
        row: session({ boardPresentation: expanded ? "split" : "expanded" }),
      });
      h.state.updateSidebarLayout(
        openDashboardPresentation(h.state.sidebarLayout, expanded ? "expanded" : "split"),
        { persist: false },
      );
      h.pane.narrow = view === "narrow";
      h.pane.paneWidth = h.pane.narrow ? 400 : 1400;
      const menu = await h.header();
      expect(menu.querySelector(defaultAction)?.textContent).toContain(
        t("chat.sidePanel.useViewAsDefault"),
      );
      expect(menu.querySelector(defaultAction)?.hasAttribute("disabled")).toBe(false);
      expect(menu.textContent).toContain(t("chat.sidePanel.defaultViewDescription"));
      expect(menu.querySelector(defaultStatus)).toBeNull();
      expectPresentation(h.state.sidebarLayout, expanded);
    },
  );

  it.each([
    "split",
    "expanded",
    "builtin split",
    "narrow",
    "read only",
    "restricted viewer",
  ] as const)(
    "identifies the matching shared default for %s without offering a write",
    async (view) => {
      const expanded = view === "expanded";
      const h = createDashboardHarness({
        scopes: view === "read only" ? ["operator.read"] : undefined,
        row: session({
          boardPresentation: view === "builtin split" ? undefined : expanded ? "expanded" : "split",
          ...(view === "restricted viewer"
            ? { visibility: "read-only", sharingRole: "viewer" }
            : {}),
        }),
      });
      h.sync();
      h.pane.narrow = view === "narrow";
      h.pane.paneWidth = h.pane.narrow ? 400 : 1400;
      const menu = await h.header();
      const status = menu.querySelector(defaultStatus);
      expect(status?.getAttribute("role")).toBe("note");
      expect(status?.textContent).toContain(t("chat.sidePanel.currentViewIsDefault"));
      expect(status?.textContent).toContain(t("chat.sidePanel.defaultViewDescription"));
      expect(menu.querySelector(defaultAction)).toBeNull();
      select(menu, "quick:layout:dashboard-default");
      expect(h.request.mock.calls.some(([method]) => method === "sessions.patch")).toBe(false);
      expectPresentation(h.state.sidebarLayout, expanded);
    },
  );

  it.each([
    "read only",
    "restricted viewer",
    "not shown",
    "inactive side tab",
    "fullscreen other panel",
    "disconnected",
    "missing session id",
  ] as const)("does not offer a shared default for %s", async (reason) => {
    const h = createDashboardHarness({
      scopes: reason === "read only" ? ["operator.read"] : undefined,
      row: session({
        boardPresentation: "split",
        ...(reason === "restricted viewer"
          ? { visibility: "read-only", sharingRole: "viewer" }
          : {}),
        ...(reason === "missing session id" ? { sessionId: undefined } : {}),
      }),
    });
    h.state.sidebarLayout = openDashboardPresentation(h.state.sidebarLayout, "expanded");
    if (reason === "not shown") {
      h.state.sidebarLayout = closeSlot(h.state.sidebarLayout, "dashboard");
    }
    if (reason === "inactive side tab") {
      h.state.sidebarLayout = openSlot(
        openDashboardPresentation({ columns: [] }, "split"),
        "companion",
      );
      h.publishRow(session({ boardPresentation: "expanded" }));
    }
    if (reason === "fullscreen other panel") {
      h.state.sidebarLayout = {
        ...promoteSidebarPanel(openSlot(h.state.sidebarLayout, "terminal"), "terminal"),
        expanded: true,
      };
    }
    if (reason === "disconnected") {
      h.state.connected = false;
    }
    const menu = await h.header();
    expect(menu.querySelector(defaultAction)).toBeNull();
    expect(menu.querySelector(defaultStatus)).toBeNull();
  });

  it("saves through the session capability, disables duplicate clicks, and acknowledges without rearranging", async () => {
    const h = createDashboardHarness();
    await h.sessions.refresh({ agentId: "main", force: true });
    const stop = h.sessions.subscribe((next) => {
      h.state.sessionsResult = next.result;
    });
    onTestFinished(stop);
    h.sync();
    h.state.updateSidebarLayout(openDashboardPresentation(h.state.sidebarLayout, "expanded"), {
      dashboardPresentation: "personal",
    });
    const layout = structuredClone(h.state.sidebarLayout);
    const persisted = structuredClone(h.saved());
    const reply = createDeferred<SessionsPatchResult>();
    onTestFinished(() => {
      reply.resolve({
        ok: true,
        key,
        path: "(multiple)",
        entry: { sessionId: "dashboard-session" },
      });
    });
    h.setPatchReply(reply.promise);
    const save = vi.spyOn(h.pane, "saveDashboardDefault");
    const patch = vi.spyOn(h.sessions, "patch");
    let menu = await h.header();
    select(menu, "quick:layout:dashboard-default");
    const operation = save.mock.results[0]?.value;
    expect(operation).toBeDefined();
    menu = await h.header();
    expect(menu.querySelector(defaultAction)?.hasAttribute("disabled")).toBe(true);
    expect(menu.querySelector(defaultAction)?.textContent).toContain(
      t("chat.sidePanel.savingDefault"),
    );
    select(menu, "quick:layout:dashboard-default");
    expect(patch).toHaveBeenCalledExactlyOnceWith(
      key,
      { boardPresentation: "expanded" },
      { agentId: "main", expectedSessionId: "dashboard-session" },
    );
    expect(h.sessions.state.result?.sessions[0]?.boardPresentation).toBe("split");
    reply.resolve({
      ok: true,
      key,
      path: "(multiple)",
      entry: { sessionId: "dashboard-session", updatedAt: 20, boardPresentation: "expanded" },
    });
    await operation;
    expect(h.sessions.state.result?.sessions[0]?.boardPresentation).toBe("expanded");
    expect(h.state.sidebarLayout).toEqual(layout);
    expect(h.saved()).toEqual(persisted);
    menu = await h.header();
    expect(menu.querySelector(defaultAction)).toBeNull();
    expect(menu.querySelector(defaultStatus)?.textContent).toContain(
      t("chat.sidePanel.currentViewIsDefault"),
    );
    select(menu, "quick:layout:dashboard-default");
    expect(patch).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith({
      message: t("chat.sidePanel.defaultSaved"),
      anchor: h.pane,
    });
  });

  it("shows a rejected save and releases the pending menu without changing either preference", async () => {
    const h = createDashboardHarness();
    h.sync();
    h.state.updateSidebarLayout(openDashboardPresentation(h.state.sidebarLayout, "expanded"), {
      dashboardPresentation: "personal",
    });
    const before = structuredClone(h.saved());
    const reply = createDeferred<SessionsPatchResult>();
    onTestFinished(() => {
      reply.resolve({
        ok: true,
        key,
        path: "(multiple)",
        entry: { sessionId: "dashboard-session" },
      });
    });
    h.setPatchReply(reply.promise);
    const save = vi.spyOn(h.pane, "saveDashboardDefault");
    select(await h.header(), "quick:layout:dashboard-default");
    const operation = save.mock.results[0]?.value;
    expect(operation).toBeDefined();
    expect((await h.header()).querySelector(defaultAction)?.hasAttribute("disabled")).toBe(true);
    reply.reject(new Error("Dashboard default denied"));
    await operation;
    expect(h.state.chatError).toContain("Dashboard default denied");
    expect(showToast).toHaveBeenCalledWith({
      message: t("chat.sidePanel.defaultSaveError", { error: "Dashboard default denied" }),
      anchor: h.pane,
    });
    expect((await h.header()).querySelector(defaultAction)?.hasAttribute("disabled")).toBe(false);
    expect(h.saved()).toEqual(before);
    expect(h.state.sessionsResult?.sessions[0]?.boardPresentation).toBe("split");
  });

  it.each([
    { changed: "session incarnation", success: false },
    { changed: "session incarnation", success: true },
    { changed: "hidden pane", success: false },
    { changed: "hidden pane", success: true },
    { changed: "Gateway", success: false },
    { changed: "Gateway", success: true },
  ] as const)(
    "does not publish a late save outcome after $changed changes (success=$success)",
    async ({ changed, success }) => {
      const h = createDashboardHarness();
      h.sync();
      h.state.updateSidebarLayout(openDashboardPresentation(h.state.sidebarLayout, "expanded"), {
        persist: false,
      });
      const reply = createDeferred<SessionsPatchResult>();
      onTestFinished(() => {
        reply.resolve({
          ok: true,
          key,
          path: "(multiple)",
          entry: { sessionId: "dashboard-session" },
        });
      });
      h.setPatchReply(reply.promise);
      const operation = h.pane.saveDashboardDefault(session(), "main");
      expect(h.request.mock.calls.filter(([method]) => method === "sessions.patch")).toHaveLength(
        1,
      );
      if (changed === "session incarnation") {
        h.publishRow(session({ sessionId: "replacement-session", updatedAt: 30 }));
      } else if (changed === "hidden pane") {
        Object.defineProperty(h.pane, "isConnected", { configurable: true, value: false });
        h.pane.presented = false;
        Object.defineProperty(h.pane, "isConnected", { configurable: true, value: true });
      } else {
        h.pane.applyGatewaySnapshot({ ...h.pane.context.gateway.snapshot, phase: "reconnecting" });
      }
      if (success) {
        reply.resolve({
          ok: true,
          key,
          path: "(multiple)",
          entry: { sessionId: "dashboard-session", updatedAt: 20, boardPresentation: "expanded" },
        });
      } else {
        reply.reject(new Error("Late rejected save"));
      }
      await operation;
      expect(showToast).not.toHaveBeenCalled();
      expect(h.state.chatError).toBeNull();
      expect(h.state.lastError).not.toBe("Late rejected save");
      expect(h.saved()).toBeUndefined();
    },
  );

  it.each(["incarnation", "agent owner"] as const)(
    "rechecks the selected %s before a captured menu can save",
    async (changed) => {
      const original = session(changed === "agent owner" ? { key: "global" } : {});
      const h = createDashboardHarness({ row: original });
      h.sync();
      h.state.updateSidebarLayout(openDashboardPresentation(h.state.sidebarLayout, "expanded"), {
        persist: false,
      });
      const menu = await h.header();
      if (changed === "agent owner") {
        h.state.assistantAgentId = "work";
        h.state.sessionsResultAgentId = "work";
        h.publishRow({ ...original, agentId: "work", updatedAt: 30 });
      } else {
        h.publishRow({ ...original, sessionId: "replacement-session", updatedAt: 30 });
      }
      select(menu, "quick:layout:dashboard-default");
      expect(h.request.mock.calls.some(([method]) => method === "sessions.patch")).toBe(false);
    },
  );
});
