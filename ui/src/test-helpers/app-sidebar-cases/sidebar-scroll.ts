import { html } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createGateway, createSessions, mountSidebar } from "../app-sidebar.ts";
import "../../components/app-sidebar.tsx";

describe("AppSidebar scroll", () => {
  it("shows fades only toward additional content", async () => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway, createSessions("main", ["agent:main:main"]));
    sidebar.contextualSidebar = {
      key: "systems",
      data: undefined,
      loaderPending: false,
      render: () => html`<p>Gateway machine</p>`,
    };
    await sidebar.updateComplete;
    const scroller = sidebar.querySelector<HTMLElement>(".sidebar-shell__body");
    if (!scroller) {
      throw new Error("Expected sidebar body scroller");
    }

    let scrollHeight = 100;
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
    });

    const expectScrollState = async (
      scrollTop: number,
      expected: "none" | "top" | "middle" | "bottom",
    ) => {
      scroller.scrollTop = scrollTop;
      scroller.dispatchEvent(new Event("scroll"));
      vi.advanceTimersToNextFrame();
      await sidebar.updateComplete;
      expect(scroller.classList.contains(`sidebar-shell__body--scroll-${expected}`)).toBe(true);
    };

    await expectScrollState(0, "none");
    scrollHeight = 300;
    await expectScrollState(0, "top");
    await expectScrollState(80, "middle");
    await expectScrollState(200, "bottom");
  });
});
