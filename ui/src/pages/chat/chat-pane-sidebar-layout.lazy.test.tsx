/* @vitest-environment jsdom */

import { createSignal, flush, Show } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { sidebarPanelDefinitions } from "./chat-pane-embedded-panels.ts";
import { openSlot, promoteSidebarPanel } from "./sidebar-layout.ts";

const lazyMocks = vi.hoisted(() => ({
  importAttempts: 0,
  retryDocument: vi.fn(async () => true),
}));

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

import { renderSidebarRegion } from "./chat-pane-sidebar-layout.ts";
import { SidebarRegionView } from "./chat-pane-sidebar-view.tsx";

afterEach(() => {
  cleanupSolid();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("chat pane lazy sidebar failures", () => {
  it("places lazy panels in their final regions before offering document-level recovery", async () => {
    vi.stubGlobal("customElements", { get: vi.fn(() => undefined) });
    const container = document.createElement("div");
    document.body.append(container);
    let layout = promoteSidebarPanel(
      openSlot(openSlot({ columns: [] }, "dashboard"), "detail"),
      "dashboard",
    );
    const primary = document.createElement("main");
    primary.dataset.primary = "";
    primary.textContent = "Primary chat";
    let renderCurrent: () => void = () => {};
    mountSolid(
      () => {
        const [content, setContent] = createSignal<
          ReturnType<typeof renderSidebarRegion> | undefined
        >(undefined, { ownedWrite: true });
        renderCurrent = () => {
          setContent(() =>
            renderSidebarRegion({
              presentationId: "sidebar-layout-fixture",
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
              layout,
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
              requestUpdate: renderCurrent,
            }),
          );
        };
        renderCurrent();
        return <Show when={content()}>{(current) => <SidebarRegionView {...current()} />}</Show>;
      },
      { container },
    );
    flush();

    const placeholders = [...container.querySelectorAll(".side-panel__panel")];
    expect(placeholders.map((panel) => panel.getAttribute("data-region"))).toEqual(["main"]);
    expect(placeholders[0]?.querySelector("openclaw-panel-loading-skeleton")?.variant).toBe(
      "board",
    );
    expect(container.querySelector(".sidebar-region__primary")?.getAttribute("data-region")).toBe(
      "side",
    );
    expect(container.querySelector(".sidebar-region__primary")?.hasAttribute("hidden")).toBe(false);
    layout = openSlot(layout, "detail");
    renderCurrent();
    flush();
    expect(
      [...container.querySelectorAll(".side-panel__panel")].map((panel) =>
        panel.getAttribute("data-region"),
      ),
    ).toEqual(["main", "side"]);

    await vi.waitFor(() => expect(container.querySelector('[role="alert"]')).not.toBeNull());
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(container.querySelector("[data-primary]")?.textContent).toContain("Primary chat");
    expect(container.querySelector(".lazy-view-error__detail")?.textContent).toContain(
      "sidebar-region.js",
    );
    const action = container.querySelector<HTMLButtonElement>(".lazy-view-error__action");
    expect(action?.textContent).toContain("Reload");
    action?.click();
    await vi.waitFor(() => expect(lazyMocks.retryDocument).toHaveBeenCalledOnce());
    expect(lazyMocks.importAttempts).toBe(1);
  });
});
