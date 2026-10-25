/* @vitest-environment jsdom */

import { createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { createSidebarRegionCallbackMocks } from "../../test-helpers/sidebar-region-callbacks.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { sidebarPanelDefinitions } from "./chat-pane-embedded-panels.ts";
import { SidebarPanel } from "./chat-pane-embedded-view.tsx";
import { createMountedPanes } from "./chat-pane-mounted.test-support.ts";
import { getPaneTestRuntime } from "./chat-pane.test-support.ts";
import { closeSlot, openSlot, promoteSidebarPanel } from "./sidebar-layout.ts";

const lazyMocks = vi.hoisted(() => ({
  boardImportAttempts: 0,
  workspaceImportAttempts: 0,
}));

// mock-isolation: count lazy registration without mounting the real dashboard renderer.
vi.mock("../../components/board/board-view.tsx", () => {
  lazyMocks.boardImportAttempts += 1;
  return {
    BoardView: () => (
      <openclaw-board-view>
        <input aria-label="Board draft" />
      </openclaw-board-view>
    ),
  };
});

// mock-isolation: exercise Files registration at the existing panel loader boundary.
vi.mock("./components/chat-files-panel.tsx", () => {
  lazyMocks.workspaceImportAttempts += 1;
  return {
    ChatFilesPanel: () => (
      <openclaw-chat-files-panel>
        <input aria-label="Files draft" />
      </openclaw-chat-files-panel>
    ),
  };
});

// mock-isolation: the failed lazy-import fixture must throw before registering or exporting the real region.
vi.mock("./components/chat-sidebar-region.runtime.tsx", () => {
  throw new SyntaxError("Synthetic sidebar module export failure");
});

import { renderSidebarRegion } from "./chat-pane-sidebar-layout.ts";
import { SidebarRegionView } from "./chat-pane-sidebar-view.tsx";

afterEach(() => {
  cleanupSolid();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("chat pane lazy sidebar failures", () => {
  it.each(["dashboard", "workspace"] as const)(
    "keeps a saved hidden %s cold and publishes its first visible load",
    async (slot) => {
      const { pane, state } = createMountedPanes([]);
      getPaneTestRuntime(pane).mergedChrome = false;
      const hidden = openSlot(openSlot({ columns: [] }, slot), "detail");
      state.sidebarLayout = hidden;
      const definition = pane
        .render()
        .layout!.region.panelDefinitions.find((entry) => entry.slot === slot)!;
      if (slot === "dashboard") {
        const data = pane
          .render()
          .layout!.region.panelDefinitions.find((entry) => entry.slot === "workspace")!.view!;
        definition.view = {
          ...data,
          dashboard: {
            error: undefined,
            surface: {
              active: true,
              session: { sessionKey: state.sessionKey },
              snapshot: undefined,
              activeTabId: "",
              canMutate: false,
              canGrant: false,
              callbacks: { applyOps: async () => {}, grant: async () => {}, selectTab() {} },
              widgetFrameUrl: () => "",
            },
          },
        };
      }
      const attempts = () =>
        slot === "dashboard" ? lazyMocks.boardImportAttempts : lazyMocks.workspaceImportAttempts;
      const [visible, setVisible] = createSignal(false);
      const mounted = mountSolid(() => (
        <SidebarPanel definition={definition} visible={visible()} />
      ));
      expect(attempts()).toBe(0);
      state.sidebarLayout = openSlot(hidden, slot);
      setVisible(true);
      await waitForSolid(() => expect(mounted.getByRole("textbox")).toBeTruthy());
      expect(attempts()).toBe(1);
      const input = mounted.getByRole<HTMLInputElement>("textbox");
      input.value = "Retained draft";
      setVisible(false);
      flush();
      setVisible(true);
      flush();
      expect(mounted.getByRole("textbox")).toBe(input);
      expect(input.value).toBe("Retained draft");
      expect(attempts()).toBe(1);
    },
  );

  it("keeps failed panels dismissible in their final regions without losing the conversation", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const initialLayout = promoteSidebarPanel(
      openSlot(openSlot({ columns: [] }, "dashboard"), "detail"),
      "dashboard",
    );
    const primary = document.createElement("main");
    primary.dataset.primary = "";
    primary.textContent = "Primary chat";
    let openDetail: () => void = () => {};
    mountSolid(
      () => {
        const [layout, setLayout] = createSignal(initialLayout);
        openDetail = () => setLayout((current) => openSlot(current, "detail"));
        const content = () =>
          renderSidebarRegion({
            presentationId: "sidebar-layout-fixture",
            availableWidth: 1_400,
            callbacks: createSidebarRegionCallbackMocks({
              closeSlot: (slot) => setLayout((current) => closeSlot(current, slot)),
            }),
            layout: layout(),
            narrow: false,
            panelDefinitions: sidebarPanelDefinitions(),
            primary,
          });
        return <SidebarRegionView {...content()} />;
      },
      { container },
    );
    flush();

    openDetail();
    flush();

    await vi.waitFor(() => expect(container.querySelector('[role="alert"]')).not.toBeNull());
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(2);
    expect(container.querySelector("[data-primary]")?.textContent).toContain("Primary chat");
    expect(container.querySelector(".lazy-view-error__detail")?.textContent).toContain(
      "Synthetic sidebar module export failure",
    );
    const action = container.querySelector<HTMLButtonElement>(".lazy-view-error__action");
    expect(action?.textContent).toContain("Retry");
    container.querySelector<HTMLButtonElement>('button[aria-label="Close Dashboard"]')?.click();
    await waitForSolid(() => expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1));
    expect(container.querySelector(".sidebar-region__primary")?.getAttribute("data-region")).toBe(
      "main",
    );
    expect(container.querySelector(".sidebar-region__primary")?.hasAttribute("hidden")).toBe(false);
    container.querySelector<HTMLButtonElement>('button[aria-label="Close Review"]')?.click();
    flush();
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(0);
    expect(container.querySelector("[data-primary]")).toBe(primary);
  });
});
