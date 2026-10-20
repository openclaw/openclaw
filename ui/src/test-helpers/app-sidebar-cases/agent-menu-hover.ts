import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createGateway, createSessions, mountSidebar, TWO_AGENTS } from "../app-sidebar.ts";
import "../../components/app-sidebar.tsx";

function pointerEvent(
  type: "pointerenter" | "pointerleave" | "pointermove",
  pointerType = "mouse",
) {
  return new PointerEvent(type, { bubbles: type === "pointermove", pointerType });
}

describe("AppSidebar agent menu hover", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setFinePointer(true);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  function setFinePointer(matches: boolean) {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches, addEventListener() {}, removeEventListener() {} })),
    );
  }
  async function mountHover() {
    const { sidebar } = await mountSidebar(
      createGateway({} as GatewayBrowserClient),
      createSessions("main", ["agent:main:main"]),
      "panel",
      TWO_AGENTS,
    );
    const advance = async (ms: number) => {
      await vi.advanceTimersByTimeAsync(ms);
      await sidebar.updateComplete;
    };
    return { sidebar, advance };
  }
  it.each(["chip", "roster"] as const)(
    "requires pointer motion for %s hover without stealing focus",
    async (mode) => {
      const { sidebar, advance } = await mountHover();
      sidebar.sidebarAgentsMode = mode;
      await sidebar.updateComplete;
      await sidebar.sidebarMenus.preloadMenuRenderer();
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
      await advance(300);
      expect(sidebar.querySelector(".sidebar-agent-menu")).toBeNull();

      trigger.dispatchEvent(pointerEvent("pointermove"));
      await advance(299);
      expect(sidebar.querySelector(".sidebar-agent-menu")).toBeNull();
      trigger.dispatchEvent(pointerEvent("pointerleave"));
      await advance(1);
      expect(sidebar.querySelector(".sidebar-agent-menu")).toBeNull();

      trigger.dispatchEvent(pointerEvent("pointerenter"));
      trigger.dispatchEvent(pointerEvent("pointermove"));
      await vi.advanceTimersByTimeAsync(299);
      trigger.dispatchEvent(pointerEvent("pointermove"));
      await advance(1);
      const menu = sidebar.querySelector<HTMLElement>(".sidebar-agent-menu");
      if (!menu) {
        throw new Error("Expected the agent menu after hover intent");
      }
      await vi.waitFor(() => expect(document.activeElement).toBe(input));

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
      await advance(200);
      expect(sidebar.querySelector(".sidebar-agent-menu")).toBeNull();

      trigger.dispatchEvent(pointerEvent("pointermove"));
      await advance(300);
      trigger.click();
      await sidebar.updateComplete;
      trigger.dispatchEvent(pointerEvent("pointerleave"));
      await advance(200);
      expect(sidebar.querySelector(".sidebar-agent-menu")).not.toBeNull();
      trigger.click();
      await sidebar.updateComplete;
      expect(sidebar.querySelector(".sidebar-agent-menu")).toBeNull();
    },
  );

  it.each([
    { finePointer: false, pointerType: "mouse" },
    { finePointer: true, pointerType: "touch" },
  ])(
    "keeps hover closed for $pointerType with fine pointer $finePointer",
    async ({ finePointer, pointerType }) => {
      setFinePointer(finePointer);
      const { sidebar, advance } = await mountHover();
      sidebar
        .querySelector<HTMLElement>(".sidebar-agent-card__main")
        ?.dispatchEvent(pointerEvent("pointermove", pointerType));
      await advance(500);
      expect(sidebar.querySelector(".sidebar-agent-menu")).toBeNull();
    },
  );
});
