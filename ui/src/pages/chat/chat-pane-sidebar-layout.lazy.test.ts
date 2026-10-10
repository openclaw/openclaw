/* @vitest-environment jsdom */

import { html, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sidebarPanelDefinitions } from "./chat-pane-embedded-panels.ts";
import { openSlot, promoteSidebarPanel } from "./sidebar-layout.ts";

const lazyMocks = vi.hoisted(() => ({
  importAttempts: 0,
  retryDocument: vi.fn(async () => true),
}));

vi.mock("./components/chat-sidebar-region.runtime.ts", () => {
  lazyMocks.importAttempts += 1;
  throw new Error("Failed to fetch dynamically imported module: sidebar-region.js");
});

vi.mock("../../app/stale-chunk-reload.ts", () => ({
  isStaleChunkImportError: () => true,
  retryStaleChunkReloadWhenReachable: lazyMocks.retryDocument,
  scheduleStaleChunkReload: vi.fn(async () => false),
}));

import { renderSidebarRegion } from "./chat-pane-sidebar-layout.ts";

afterEach(() => {
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
    const renderCurrent = () => {
      render(
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
              content: definition.slot === "detail" ? html`<aside>Review</aside>` : null,
            }),
          ),
          primary: html`<main data-primary>Primary chat</main>`,
          requestUpdate: renderCurrent,
        }),
        container,
      );
    };

    renderCurrent();

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
