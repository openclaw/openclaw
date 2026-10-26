import { afterEach, describe, expect, it, onTestFailed, onTestFinished, vi } from "vitest";
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
import { registryFor } from "./overlay-registry.ts";

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
    const pointerParking = document.createElement("div");
    pointerParking.style.cssText = "position:fixed;right:0;bottom:0;width:32px;height:32px";
    document.body.append(pointerParking);
    await page.elementLocator(pointerParking).hover();
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
    const events: Record<string, unknown>[] = [];
    onTestFailed(() => console.error("[rail-menu-escape]", JSON.stringify(events)));
    const identify = (target: EventTarget | null) =>
      target instanceof Element
        ? (target.tagName + "#" + target.id + "." + (target.getAttribute("class") ?? "")).slice(
            0,
            200,
          )
        : null;
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
      const surface = panel()!;
      const registry = registryFor(document);
      const overlay = [...registry.members.keys()].find((entry) => entry.surface === surface);
      let escape: KeyboardEvent | undefined;
      const record = (stage: string, detail: Record<string, unknown> = {}) => {
        const top = registry.stack.at(-1);
        if (events.length === 64) {
          events.shift();
        }
        events.push({
          stage,
          menu: panelSelector,
          at: performance.now(),
          trigger: identify(trigger),
          panel: identify(surface),
          present: panel() === surface,
          connected: surface.isConnected,
          phase: surface.dataset.phase,
          open: overlay?.open,
          agentMenuOpen: sidebar.sidebarMenus.agentMenuPosition !== null,
          hasFocus: document.hasFocus(),
          active: identify(document.activeElement),
          top: top && {
            id: top.id,
            open: top.open,
            phase: top.phase,
            connected: top.surface.isConnected,
          },
          ...detail,
        });
      };
      const keydown = (event: KeyboardEvent) => {
        if (event.key === "Escape") {
          escape = event;
          record("escape-capture", {
            target: identify(event.target),
            trusted: event.isTrusted,
            composing: event.isComposing,
            defaultPrevented: event.defaultPrevented,
          });
        }
      };
      const lifecycle = (event: Event) => record(event.type);
      const lifecycleEvents = ["overlay-hide", "beforetoggle", "toggle"] as const;
      const unsubscribe = overlay?.subscribe((open) => record("accepted-open", { open }));
      document.addEventListener("keydown", keydown, { capture: true, passive: true });
      for (const type of lifecycleEvents) {
        surface.addEventListener(type, lifecycle, { passive: true });
      }
      const stop = () => {
        document.removeEventListener("keydown", keydown, true);
        lifecycleEvents.forEach((type) => surface.removeEventListener(type, lifecycle));
        unsubscribe?.();
        escape = undefined;
      };
      onTestFinished(stop);
      try {
        // Escape belongs to an active tooltip first; test menu dismissal without one.
        await page.elementLocator(pointerParking).hover();
        await expect.poll(() => document.querySelector("openclaw-tooltip[open]")).toBeNull();
        record("before-keyboard");
        await userEvent.keyboard("{Escape}");
        record("after-keyboard", {
          escapeReceived: Boolean(escape),
          defaultPrevented: escape?.defaultPrevented,
        });
        escape = undefined;
        await sidebar.updateComplete;
        record("after-sidebar-update");
        expect(panel()).toBeNull();
        expect(document.activeElement).toBe(trigger);
      } finally {
        // Freeze live-state evidence before afterEach removes the fixture; failure hooks run later.
        stop();
      }
    }
  });
});
