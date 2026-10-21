import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  createGatewayHarness,
  createSessions,
  mountSidebar,
  TWO_AGENTS,
} from "../test-helpers/app-sidebar.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../test-helpers/gateway-client.ts";
import "../test-helpers/load-styles.ts";

afterEach(() => document.body.replaceChildren());

describe.runIf("__vitest_browser__" in globalThis)("navigation rail menus", () => {
  it("opens all three menus beside the rail and restores their real trigger on Escape", async () => {
    await import("./app-sidebar.tsx");
    // Browser shards share the registry even when the sidebar helper mocks this module.
    if (!customElements.get("openclaw-sidebar-attention")) {
      await vi.importActual("./sidebar-attention.tsx");
    }
    const { page, userEvent } = await import("vitest/browser");
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    onTestFinished(() => page.viewport(viewport.width, viewport.height));
    await page.viewport(1280, 900);
    const { sidebar, provider } = await mountSidebar(
      createGatewayHarness(createTestGatewayClient(createGatewayRequestMock())).gateway,
      createSessions("main", ["agent:main:main"]),
      "panel",
      TWO_AGENTS,
    );
    provider.className = "shell--navigation-rail";
    sidebar.hostElement.style.cssText = "display:block;width:340px;height:880px";
    sidebar.connected = true;
    await sidebar.updateComplete;
    const rail = sidebar.querySelector<HTMLElement>(".sidebar-rail")!;
    expect(rail).not.toBeNull();
    for (const [triggerSelector, panelSelector, edge] of [
      [".sidebar-agent-card__main", ".sidebar-agent-menu", "top"],
      [".sidebar-identity-card", ".sidebar-identity-menu", "bottom"],
      [".sidebar-issues-button", ".sidebar-issues-panel", "auto"],
    ] as const) {
      const trigger = rail.querySelector<HTMLButtonElement>(triggerSelector)!;
      expect(trigger).not.toBeNull();
      const eventType = edge === "auto" ? "focusin" : "overlay-after-show";
      const shown = new Promise<void>((resolve) => {
        const listener = (event: Event) => {
          if (!(event.target instanceof HTMLElement) || !event.target.closest(panelSelector)) {
            return;
          }
          sidebar.removeEventListener(eventType, listener, true);
          resolve();
        };
        sidebar.addEventListener(eventType, listener, true);
        onTestFinished(() => sidebar.removeEventListener(eventType, listener, true));
      });
      await page.elementLocator(trigger).click();
      await shown;
      const panel = () => sidebar.querySelector<HTMLElement>(panelSelector);
      expect(panel()!.getBoundingClientRect().width).toBeGreaterThan(0);
      expect(
        panel()!.getBoundingClientRect().left - rail.getBoundingClientRect().right,
      ).toBeCloseTo(8, 0);
      const panelBox = panel()!.getBoundingClientRect();
      const triggerBox = trigger.getBoundingClientRect();
      expect(panelBox.left).toBeGreaterThan(triggerBox.right);
      if (edge === "top" || (edge === "auto" && triggerBox.top < window.innerHeight / 2)) {
        expect(Math.abs(panelBox.top - triggerBox.top)).toBeLessThanOrEqual(1);
      } else {
        expect(panelBox.top).toBeLessThan(triggerBox.top);
        expect(panelBox.bottom).toBeLessThanOrEqual(triggerBox.bottom + 1);
      }
      expect(panel()!.contains(document.activeElement)).toBe(true);
      await userEvent.keyboard("{Escape}");
      await sidebar.updateComplete;
      expect(panel()).toBeNull();
      expect(document.activeElement).toBe(trigger);
    }
  });
});
