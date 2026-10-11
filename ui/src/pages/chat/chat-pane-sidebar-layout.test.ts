/* @vitest-environment jsdom */

import { html, LitElement, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sidebarPanelDefinitions } from "./chat-pane-embedded-panels.ts";
import type { ResolvedBoardView } from "./chat-pane-shared.ts";
import {
  renderSidebarRegion,
  resolveSidebarLayoutForBoard,
  sidebarRegionCallbacks,
} from "./chat-pane-sidebar-layout.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import "./components/chat-sidebar-region.runtime.ts";
import {
  closeSlot,
  openSlot,
  promoteSidebarPanel,
  setSidebarDock,
  setSidebarExpanded,
  setSidebarOpen,
  sidebarActivePanel,
  sidebarMainPanel,
  type SidebarLayout,
} from "./sidebar-layout.ts";

function board(face: ResolvedBoardView["face"] = "dashboard") {
  return {
    available: true,
    hasBoard: true,
    face,
    provider: { hasLoadedSnapshot: true },
  } as ResolvedBoardView;
}

const containers: HTMLElement[] = [];
const requestUpdate = vi.fn();

function callbacks() {
  return {
    activatePanel: vi.fn(),
    togglePanelExpanded: vi.fn(),
    closeSlot: vi.fn(),
    openSlot: vi.fn(),
    reorderPanel: vi.fn(),
    resizePanel: vi.fn(),
    setOpen: vi.fn(),
  };
}

class NativeCloseLayoutFixture extends LitElement {
  static override properties = { layout: { attribute: false } };
  declare layout: SidebarLayout;

  constructor() {
    super();
    this.layout = openSlot(openSlot({ columns: [] }, "workspace"), "detail");
  }

  override createRenderRoot() {
    return this;
  }

  override render() {
    return renderSidebarRegion({
      presentationId: "sidebar-layout-fixture",
      availableWidth: 1_400,
      callbacks: {
        ...callbacks(),
        closeSlot: (slot) => {
          this.layout = closeSlot(this.layout, slot);
        },
      },
      layout: this.layout,
      narrow: false,
      panelDefinitions: sidebarPanelDefinitions().map((definition) =>
        Object.assign(definition, {
          available: definition.slot === "detail" || definition.slot === "workspace",
          content:
            definition.slot === "detail"
              ? html`<textarea aria-label="Side panel input"></textarea>`
              : definition.slot === "workspace"
                ? html`<div>Workspace</div>`
                : null,
        }),
      ),
      primary: html`<main>Conversation</main>`,
      requestUpdate: () => this.requestUpdate(),
    });
  }
}

customElements.define("native-close-layout-fixture", NativeCloseLayoutFixture);

async function renderLayout(
  container: HTMLElement,
  layout: SidebarLayout,
  narrow = false,
  presentationId = "sidebar-layout-fixture",
) {
  render(
    renderSidebarRegion({
      presentationId,
      availableWidth: narrow ? 620 : 1_400,
      callbacks: callbacks(),
      layout,
      narrow,
      panelDefinitions: sidebarPanelDefinitions().map((definition) =>
        Object.assign(definition, {
          available: ["detail", "terminal", "workspace"].includes(definition.slot),
          content:
            definition.slot === "detail"
              ? html`<aside data-detail>Details<input type="checkbox" /></aside>`
              : null,
        }),
      ),
      primary: html`<main data-primary>Primary<textarea></textarea></main>`,
      requestUpdate,
    }),
    container,
  );
  await customElements.whenDefined("openclaw-chat-sidebar-region");
  await container.querySelector("openclaw-chat-sidebar-region")?.updateComplete;
}

afterEach(() => {
  for (const container of containers.splice(0)) {
    container.remove();
  }
});

describe("chat pane sidebar layout", () => {
  it("restores focus to the surviving tab after its parent commits native Close", async () => {
    const parent = new NativeCloseLayoutFixture();
    containers.push(parent);
    document.body.append(parent);
    await parent.updateComplete;
    const region = parent.querySelector("openclaw-chat-sidebar-region")!;
    await region.updateComplete;
    parent.querySelector("textarea")!.focus();

    const command = new CustomEvent("openclaw:native-close-focused-panel", { cancelable: true });
    window.dispatchEvent(command);
    expect(command.defaultPrevented).toBe(true);
    await parent.updateComplete;
    await region.updateComplete;

    expect(sidebarActivePanel(parent.layout)?.slot).toBe("workspace");
    const nextTab = parent.querySelector<HTMLElement>('wa-tab[panel="workspace"]')!;
    expect(nextTab).not.toBeNull();
    expect(document.activeElement).toBe(nextTab);
  });

  it("preserves drafts and panel state across swapping, docking, focus, minimize, and mobile", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    containers.push(container);
    const open = openSlot({ columns: [] }, "detail");

    await renderLayout(container, { columns: [], open: false });
    const primary = container.querySelector("[data-primary]");
    const draft = primary!.querySelector("textarea")!;
    draft.value = "Keep this draft";
    await renderLayout(container, open);
    const detail = container.querySelector<HTMLElement>("[data-detail]")!;
    const checkbox = detail.querySelector("input")!;
    checkbox.checked = true;
    expect(container.querySelector("[data-primary]")).toBe(primary);
    const promoted = promoteSidebarPanel(open, "detail");
    for (const dock of ["left", "right", "bottom"] as const) {
      await renderLayout(container, setSidebarDock(promoted, dock));
      expect(detail.closest("[data-region]")?.getAttribute("data-region")).toBe("main");
      expect(primary?.closest("[data-region]")?.getAttribute("data-region")).toBe("side");
      expect(primary?.closest("[data-region]")?.hasAttribute("hidden")).toBe(false);
      expect(container.querySelector("[data-detail]")).toBe(detail);
      expect(container.querySelector("[data-primary]")).toBe(primary);
    }
    await renderLayout(container, setSidebarExpanded(promoted, true));
    expect(primary?.closest("[data-region]")?.hasAttribute("hidden")).toBe(true);
    expect(detail.closest("[data-region]")?.hasAttribute("hidden")).toBe(false);
    await renderLayout(container, setSidebarOpen(promoted, false));
    expect(primary?.closest("[data-region]")?.hasAttribute("hidden")).toBe(true);
    await renderLayout(container, setSidebarOpen(promoted, true), true);
    expect(primary?.closest("[data-region]")?.hasAttribute("hidden")).toBe(false);
    expect(container.querySelector(".sidebar-region--narrow")).not.toBeNull();
    const conversation = promoted.columns[0]!.panels.find(
      (panel) => panel.slot === "conversation",
    )!;
    await renderLayout(container, promoteSidebarPanel(promoted, conversation.id));
    expect(primary?.closest("[data-region]")?.getAttribute("data-region")).toBe("main");
    expect(container.querySelector("[data-detail]")).toBe(detail);
    expect(container.querySelector("[data-primary]")).toBe(primary);
    expect(draft.value).toBe("Keep this draft");
    expect(checkbox.checked).toBe(true);
  });

  it("keeps an unmeasured shell in the wide layout", async () => {
    const container = document.createElement("div");
    containers.push(container);
    render(
      renderSidebarRegion({
        presentationId: "sidebar-layout-fixture",
        availableWidth: 0,
        callbacks: callbacks(),
        layout: openSlot({ columns: [] }, "detail"),
        narrow: false,
        panelDefinitions: sidebarPanelDefinitions().map((definition) =>
          Object.assign(definition, {
            available: definition.slot === "detail",
            content: definition.slot === "detail" ? html`<aside>Details</aside>` : null,
          }),
        ),
        primary: html`<main>Primary</main>`,
        requestUpdate,
      }),
      container,
    );
    expect(container.querySelector(".sidebar-region--narrow")).toBeNull();
  });

  it("preserves a saved bottom dock and panel selection on a dashboard route", () => {
    const layout = resolveSidebarLayoutForBoard({
      board: board(),
      layout: { ...openSlot({ columns: [] }, "terminal"), dock: "bottom" },
      paneWidth: 1_400,
    });

    expect(layout.dock).toBe("bottom");
    expect(layout.columns[0]?.panels.map((panel) => panel.slot)).toEqual(["terminal"]);
  });

  it("persists tab selection without changing the chosen main content", () => {
    const stored = promoteSidebarPanel(
      openSlot(openSlot({ columns: [] }, "terminal"), "dashboard"),
      "dashboard",
    );
    const rendered = resolveSidebarLayoutForBoard({
      board: board(),
      layout: stored,
      paneWidth: 1_400,
    });
    const updateSidebarLayout = vi.fn();
    const updateSidebarActivePanel = vi.fn();
    const state = {
      sidebarLayout: stored,
      updateSidebarLayout,
      updateSidebarActivePanel,
    } as unknown as ChatPageHost;

    sidebarRegionCallbacks({
      state,
      layout: rendered,
      closePanelSlot: vi.fn(),
      openPanelSlot: vi.fn(),
      forgetDiscussionUrl: vi.fn(),
      resizePanel: vi.fn(),
      setPanelOpen: vi.fn(),
    }).activatePanel("terminal");

    expect(updateSidebarLayout).toHaveBeenCalledWith(
      expect.objectContaining({
        mainPanelId: "dashboard",
        columns: [expect.objectContaining({ activePanelId: "terminal" })],
      }),
    );
    expect(updateSidebarActivePanel).toHaveBeenCalledWith("terminal");
  });

  it("closes dashboard presentation through its owner without minimizing unrelated tabs", () => {
    const layout = resolveSidebarLayoutForBoard({
      board: board(),
      layout: { columns: [] },
      paneWidth: 1_400,
    });
    const setPanelOpen = vi.fn();
    const closePanelSlot = vi.fn();
    const state = {
      sidebarLayout: layout,
      updateSidebarLayout: vi.fn(),
      updateSidebarActivePanel: vi.fn(),
    } as unknown as ChatPageHost;

    sidebarRegionCallbacks({
      state,
      layout,
      closePanelSlot,
      openPanelSlot: vi.fn(),
      forgetDiscussionUrl: vi.fn(),
      resizePanel: vi.fn(),
      setPanelOpen,
    }).closeSlot("dashboard");

    expect(closePanelSlot).toHaveBeenCalledWith("dashboard");
    expect(setPanelOpen).not.toHaveBeenCalled();
    expect(state.updateSidebarLayout).not.toHaveBeenCalled();
  });

  it("keeps an empty dashboard open and only removes it when dashboard support is unavailable", () => {
    const layout = promoteSidebarPanel(
      openSlot(openSlot({ columns: [] }, "dashboard"), "detail"),
      "dashboard",
    );
    const loading = { ...board(), hasBoard: false };
    const awaitingSnapshot = resolveSidebarLayoutForBoard({
      board: { ...loading, provider: { hasLoadedSnapshot: false } } as ResolvedBoardView,
      layout,
      paneWidth: 1_400,
    });
    expect(awaitingSnapshot).toEqual(layout);
    expect(resolveSidebarLayoutForBoard({ board: loading, layout, paneWidth: 1_400 })).toEqual(
      layout,
    );
    const removed = resolveSidebarLayoutForBoard({
      board: { ...loading, available: false },
      layout,
      paneWidth: 1_400,
    });
    expect(sidebarMainPanel(removed)?.slot).toBe("conversation");
    expect(sidebarActivePanel(removed)?.slot).toBe("detail");
  });
});
