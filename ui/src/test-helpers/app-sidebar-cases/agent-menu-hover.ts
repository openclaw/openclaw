import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createGateway, createSessions, mountSidebar, TWO_AGENTS } from "../app-sidebar.ts";
import "../../components/app-sidebar.ts";

function pointerEvent(
  type: "pointerenter" | "pointerleave" | "pointermove",
  pointerType = "mouse",
) {
  const event = new Event(type);
  Object.defineProperty(event, "pointerType", { value: pointerType });
  return event;
}

describe("AppSidebar agent menu hover", () => {
  it.each(["chip", "roster"] as const)(
    "requires pointer motion for %s hover without stealing focus",
    async (mode) => {
      vi.useFakeTimers();
      vi.stubGlobal(
        "matchMedia",
        vi.fn(() => ({ matches: true, addEventListener() {}, removeEventListener() {} })),
      );
      try {
        const { sidebar } = await mountSidebar(
          createGateway({} as GatewayBrowserClient),
          createSessions("main", ["agent:main:main"]),
          "panel",
          TWO_AGENTS,
        );
        sidebar.sidebarAgentsMode = mode;
        await sidebar.updateComplete;
        const menus = (
          sidebar as unknown as {
            sidebarMenus: { preloadMenuRenderer: () => Promise<unknown> };
          }
        ).sidebarMenus;
        await menus.preloadMenuRenderer();
        const input = document.createElement("input");
        document.body.append(input);
        input.focus();
        const trigger = sidebar.querySelector<HTMLButtonElement>(
          mode === "chip" ? ".sidebar-agent-card__main" : ".sidebar-workspace-header__main",
        );
        if (!trigger) {
          throw new Error("Expected the sidebar agent card trigger");
        }

        // Revealing the sidebar beneath a stationary pointer is not hover intent.
        trigger.dispatchEvent(pointerEvent("pointerenter"));
        await vi.advanceTimersByTimeAsync(300);
        await sidebar.updateComplete;
        expect(sidebar.querySelector(".sidebar-agent-menu")).toBeNull();

        trigger.dispatchEvent(pointerEvent("pointermove"));
        await vi.advanceTimersByTimeAsync(299);
        await sidebar.updateComplete;
        expect(sidebar.querySelector(".sidebar-agent-menu")).toBeNull();
        trigger.dispatchEvent(pointerEvent("pointerleave"));
        await vi.advanceTimersByTimeAsync(1);
        await sidebar.updateComplete;
        expect(sidebar.querySelector(".sidebar-agent-menu")).toBeNull();

        trigger.dispatchEvent(pointerEvent("pointerenter"));
        trigger.dispatchEvent(pointerEvent("pointermove"));
        await vi.advanceTimersByTimeAsync(299);
        trigger.dispatchEvent(pointerEvent("pointermove"));
        await vi.advanceTimersByTimeAsync(1);
        await sidebar.updateComplete;
        const menu = sidebar.querySelector<HTMLElement>(".sidebar-agent-menu");
        if (!menu) {
          throw new Error("Expected the agent menu after hover intent");
        }
        menu.dispatchEvent(new Event("wa-after-show"));
        expect(document.activeElement).toBe(input);

        trigger.dispatchEvent(pointerEvent("pointerleave"));
        await vi.advanceTimersByTimeAsync(199);
        menu.dispatchEvent(pointerEvent("pointerenter"));
        await vi.advanceTimersByTimeAsync(1);
        expect(sidebar.querySelector(".sidebar-agent-menu")).toBe(menu);
        menu.dispatchEvent(pointerEvent("pointerleave"));
        await vi.advanceTimersByTimeAsync(199);
        trigger.dispatchEvent(pointerEvent("pointermove"));
        await vi.advanceTimersByTimeAsync(1);
        expect(sidebar.querySelector(".sidebar-agent-menu")).toBe(menu);
        trigger.dispatchEvent(pointerEvent("pointerleave"));
        await vi.advanceTimersByTimeAsync(200);
        await sidebar.updateComplete;
        expect(sidebar.querySelector(".sidebar-agent-menu")).toBeNull();

        trigger.dispatchEvent(pointerEvent("pointermove"));
        await vi.advanceTimersByTimeAsync(300);
        await sidebar.updateComplete;
        trigger.click();
        await sidebar.updateComplete;
        trigger.dispatchEvent(pointerEvent("pointerleave"));
        await vi.advanceTimersByTimeAsync(200);
        await sidebar.updateComplete;
        expect(sidebar.querySelector(".sidebar-agent-menu")).not.toBeNull();
        trigger.click();
        await sidebar.updateComplete;
        expect(sidebar.querySelector(".sidebar-agent-menu")).toBeNull();
      } finally {
        vi.useRealTimers();
        vi.unstubAllGlobals();
      }
    },
  );

  it.each([
    { finePointer: false, pointerType: "mouse" },
    { finePointer: true, pointerType: "touch" },
  ])(
    "keeps hover closed for $pointerType with fine pointer $finePointer",
    async ({ finePointer, pointerType }) => {
      vi.useFakeTimers();
      vi.stubGlobal(
        "matchMedia",
        vi.fn(() => ({ matches: finePointer, addEventListener() {}, removeEventListener() {} })),
      );
      try {
        const { sidebar } = await mountSidebar(
          createGateway({} as GatewayBrowserClient),
          createSessions("main", ["agent:main:main"]),
          "panel",
          TWO_AGENTS,
        );
        sidebar
          .querySelector<HTMLElement>(".sidebar-agent-card__main")
          ?.dispatchEvent(pointerEvent("pointermove", pointerType));
        await vi.advanceTimersByTimeAsync(500);
        await sidebar.updateComplete;
        expect(sidebar.querySelector(".sidebar-agent-menu")).toBeNull();
      } finally {
        vi.useRealTimers();
        vi.unstubAllGlobals();
      }
    },
  );
});
