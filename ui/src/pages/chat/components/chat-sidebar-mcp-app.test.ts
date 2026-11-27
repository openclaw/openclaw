import { expect, it, vi, onTestFinished } from "vitest";
import { presentMcpAppInSidebar } from "../../../components/mcp-app-sidebar.ts";
import { createReviewFixture } from "../../../test-helpers/chat-pane-embedded-panels.ts";
import { setNativeGatewayTestState } from "../../../test-helpers/native-gateways.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { openSlot } from "../sidebar-layout.ts";
import "../../../components/mcp-app-view.tsx";

it.each([true, false])(
  "presents the App's own label and optional icon through the production detail slot (%s)",
  async (configuredIcon) => {
    setNativeGatewayTestState(null);
    const fixture = createReviewFixture();
    onTestFinished(() => {
      fixture.mount.remove();
      vi.restoreAllMocks();
    });
    const icon =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nPcAAAAASUVORK5CYII=";
    fixture.state.sidebarContent = {
      kind: "mcp-app-preview",
      title: "Excalidraw",
      view: document.createElement("mcp-app-view"),
      appIdentity: { label: "Excalidraw", icons: configuredIcon ? [{ src: icon }] : [] },
    };
    fixture.state.sidebarLayout = openSlot({ columns: [] }, "detail");
    await fixture.renderPanels();
    const region = fixture.mount.querySelector("openclaw-chat-sidebar-region");
    expect(region?.readPanelHost("detail")).toBe(
      fixture.mount.querySelector("openclaw-chat-detail-panel"),
    );
    const tab = () => fixture.mount.querySelector('.side-panel__header [role="tab"]');
    await waitForSolid(() => expect(tab()?.textContent).toContain("Excalidraw"));
    await waitForSolid(() =>
      expect(tab()?.querySelector("img")?.getAttribute("src")).toBe(
        configuredIcon ? icon : undefined,
      ),
    );
    expect(Boolean(tab()?.querySelector("svg"))).toBe(!configuredIcon);
    fixture.state.sidebarContent = {
      kind: "mcp-app-preview",
      title: "Second App",
      view: document.createElement("mcp-app-view"),
    };
    await fixture.renderPanels();
    await waitForSolid(() => expect(tab()?.textContent).toContain("Second App"));
    expect(tab()?.querySelector("img")).toBeNull();
    fixture.state.sidebarContent = { kind: "markdown", content: "Ordinary Review content" };
    await fixture.renderPanels();
    await waitForSolid(() => expect(tab()?.textContent).toContain("Review"));
    fixture.state.sidebarContent = { kind: "loading" };
    await fixture.renderPanels();
    await waitForSolid(() => expect(region?.readPanelHost("detail")).toBeNull());
  },
);

it("re-expands the retained frame when Review is reopened and restores owned geometry", () => {
  const view = document.createElement("mcp-app-view");
  const target = document.createElement("div");
  view.displayMode = "inline";
  view.style.width = "420px";
  const close = presentMcpAppInSidebar(view, target);
  expect(view.displayMode).toBe("fullscreen");
  close();
  expect(view.displayMode).toBe("inline");
  expect(view.style.width).toBe("420px");
  const closeAgain = presentMcpAppInSidebar(view, target);
  expect(view.displayMode).toBe("fullscreen");
  closeAgain();
});
