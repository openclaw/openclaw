/* @vitest-environment jsdom */

import { createMemo, createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { projectOwner } from "../../lib/reactive/projection.ts";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { sidebarPanelDefinitions } from "./chat-pane-embedded-panels.ts";
import { SidebarPanel } from "./chat-pane-embedded-view.tsx";
import { closeSlot, openSlot, promoteSidebarPanel } from "./sidebar-layout.ts";

const lazyMocks = vi.hoisted(() => ({
  boardImportAttempts: 0,
  boardRegistered: false,
  workspaceImportAttempts: 0,
  workspaceRegistered: false,
  importAttempts: 0,
  retryDocument: vi.fn(async () => true),
}));

// mock-isolation: count lazy registration without mounting the real dashboard renderer.
vi.mock("../../components/board/board-view.ts", () => {
  lazyMocks.boardImportAttempts += 1;
  lazyMocks.boardRegistered = true;
  return {};
});

// mock-isolation: exercise Files registration at the existing panel loader boundary.
vi.mock("./components/chat-files-panel.tsx", () => {
  lazyMocks.workspaceImportAttempts += 1;
  lazyMocks.workspaceRegistered = true;
  return {};
});

// mock-isolation: the failed lazy-import fixture must throw before registering or exporting the real region.
vi.mock("./components/chat-sidebar-region.runtime.tsx", () => {
  lazyMocks.importAttempts += 1;
  throw new Error("Failed to fetch dynamically imported module: sidebar-region.js");
});

vi.mock("../../app/stale-chunk-reload.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../app/stale-chunk-reload.ts")>()),
  isStaleChunkImportError: () => true,
  retryStaleChunkReloadWhenReachable: lazyMocks.retryDocument,
  scheduleStaleChunkReload: vi.fn(async () => false),
}));

import { lazySidebarElements, renderSidebarRegion } from "./chat-pane-sidebar-layout.ts";
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
      vi.stubGlobal("customElements", {
        get: (tag: string) => {
          const registered =
            slot === "dashboard" ? lazyMocks.boardRegistered : lazyMocks.workspaceRegistered;
          const targetTag =
            slot === "dashboard" ? "openclaw-board-view" : "openclaw-chat-files-panel";
          return tag === targetTag && !registered ? undefined : HTMLElement;
        },
      });
      const attempts = () =>
        slot === "dashboard" ? lazyMocks.boardImportAttempts : lazyMocks.workspaceImportAttempts;
      const hidden = openSlot(openSlot({ columns: [] }, slot), "detail");
      let showPanel = () => {};
      const mounted = mountSolid(() => {
        const [layout, setLayout] = createSignal(hidden);
        showPanel = () => setLayout(openSlot(hidden, slot));
        const elements = projectOwner(lazySidebarElements, (owner) => owner.snapshot);
        const content = createMemo(() => {
          elements.read();
          return renderSidebarRegion({
            presentationId: "panel-loader-fixture",
            availableWidth: 1_400,
            callbacks: {
              activatePanel: vi.fn(),
              togglePanelExpanded: vi.fn(),
              closeSlot: vi.fn(),
              openSlot: vi.fn(),
              reorderPanel: vi.fn(),
              resizePanel: vi.fn(),
              setOpen: vi.fn(),
            },
            layout: layout(),
            narrow: false,
          });
        });
        return (
          <output>
            {content().panelDefinitions.find((panel) => panel.slot === slot)?.loadState === null
              ? "loading"
              : "ready"}
          </output>
        );
      });
      flush();
      expect(attempts()).toBe(0);
      expect(lazySidebarElements.snapshot.has(slot)).toBe(false);

      showPanel();
      flush();
      expect(mounted.container.textContent).toBe("loading");
      await vi.waitFor(() => expect(mounted.container.textContent).toBe("ready"));
      showPanel();
      flush();
      expect(attempts()).toBe(1);
    },
  );

  it("keeps failed panels dismissible in their final regions without losing the conversation", async () => {
    vi.stubGlobal("customElements", { get: vi.fn(() => undefined) });
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
        const elements = projectOwner(lazySidebarElements, (owner) => owner.snapshot);
        const content = createMemo(() => {
          elements.read();
          return renderSidebarRegion({
            presentationId: "sidebar-layout-fixture",
            availableWidth: 1_400,
            callbacks: {
              activatePanel: vi.fn(),
              togglePanelExpanded: vi.fn(),
              closeSlot: (slot) => setLayout((current) => closeSlot(current, slot)),
              openSlot: vi.fn(),
              reorderPanel: vi.fn(),
              resizePanel: vi.fn(),
              setOpen: vi.fn(),
            },
            layout: layout(),
            narrow: false,
            panelDefinitions: sidebarPanelDefinitions().map((definition) =>
              Object.assign(definition, {
                available: definition.slot === "detail",
                content:
                  definition.slot === "detail"
                    ? Object.assign(document.createElement("aside"), { textContent: "Review" })
                    : null,
              }),
            ),
            primary,
          });
        });
        return <SidebarRegionView {...content()} />;
      },
      { container },
    );
    flush();

    const placeholders = [...container.querySelectorAll(".side-panel__panel")];
    expect(placeholders.map((panel) => panel.getAttribute("data-region"))).toEqual(["main"]);
    expect(
      placeholders[0]
        ?.querySelector("openclaw-panel-loading-skeleton")
        ?.getAttribute("data-panel-skeleton"),
    ).toBe("board");
    expect(container.querySelector(".sidebar-region__primary")?.getAttribute("data-region")).toBe(
      "side",
    );
    expect(container.querySelector(".sidebar-region__primary")?.hasAttribute("hidden")).toBe(false);
    openDetail();
    flush();
    expect(
      [...container.querySelectorAll(".side-panel__panel")].map((panel) =>
        panel.getAttribute("data-region"),
      ),
    ).toEqual(["main", "side"]);

    await vi.waitFor(() => expect(container.querySelector('[role="alert"]')).not.toBeNull());
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(2);
    expect(container.querySelector("[data-primary]")?.textContent).toContain("Primary chat");
    expect(container.querySelector(".lazy-view-error__detail")?.textContent).toContain(
      "sidebar-region.js",
    );
    const action = container.querySelector<HTMLButtonElement>(".lazy-view-error__action");
    expect(action?.textContent).toContain("Reload");
    action?.click();
    await vi.waitFor(() => expect(lazyMocks.retryDocument).toHaveBeenCalledOnce());
    expect(lazyMocks.importAttempts).toBe(1);
    container.querySelector<HTMLButtonElement>('button[aria-label="Close Dashboard"]')?.click();
    flush();
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(container.querySelector(".sidebar-region__primary")?.getAttribute("data-region")).toBe(
      "main",
    );
    expect(container.querySelector(".sidebar-region__primary")?.hasAttribute("hidden")).toBe(false);
    container.querySelector<HTMLButtonElement>('button[aria-label="Close Review"]')?.click();
    flush();
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(0);
    expect(container.querySelector("[data-primary]")).toBe(primary);
  });
  it("shows a failed Files import through the pane loader and its reload action", async () => {
    lazyMocks.retryDocument.mockClear();
    // mock-isolation: fail the real module boundary before its element registers.
    vi.doMock("./components/chat-files-panel.tsx", () => {
      throw new Error("Failed to fetch dynamically imported module: chat-files-panel.js");
    });
    vi.stubGlobal("customElements", {
      get: (tag: string) => (tag === "openclaw-chat-files-panel" ? undefined : HTMLElement),
    });
    try {
      const mounted = mountSolid(() => {
        const elements = projectOwner(lazySidebarElements, (owner) => owner.snapshot);
        const content = createMemo(() => {
          elements.read();
          return renderSidebarRegion({
            presentationId: "files-loader-failure",
            availableWidth: 1_400,
            callbacks: {
              activatePanel: vi.fn(),
              togglePanelExpanded: vi.fn(),
              closeSlot: vi.fn(),
              openSlot: vi.fn(),
              reorderPanel: vi.fn(),
              resizePanel: vi.fn(),
              setOpen: vi.fn(),
            },
            layout: openSlot({ columns: [] }, "workspace"),
            narrow: false,
          });
        });
        return (
          <SidebarPanel
            definition={content().panelDefinitions.find((panel) => panel.slot === "workspace")!}
          />
        );
      });
      await waitForSolid(() =>
        expect(mounted.container.querySelector('[role="alert"]')).not.toBeNull(),
      );
      expect(mounted.container.textContent).toContain("chat-files-panel.js");
      const reload = mounted.getByRole("button", { name: "Reload" });
      reload.click();
      await waitForSolid(() => expect(lazyMocks.retryDocument).toHaveBeenCalledOnce());
    } finally {
      vi.doUnmock("./components/chat-files-panel.tsx");
    }
  });
});
