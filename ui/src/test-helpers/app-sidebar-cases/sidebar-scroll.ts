import { html } from "lit";
import { describe, expect, it } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createGateway, createSessions, mountSidebar } from "../app-sidebar.ts";
import "../../components/app-sidebar.ts";

describe("AppSidebar scroll", () => {
  it("swaps only the lower content and restores each destination's scroll position", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway, createSessions("main", ["agent:main:main"]));
    const nav = sidebar.querySelector(".sidebar-nav");
    const footer = sidebar.querySelector(".sidebar-shell__footer");
    const scroller = sidebar.querySelector<HTMLElement>(".sidebar-shell__body")!;
    const sessions = sidebar.querySelector<HTMLElement>(".sidebar-session-content")!;
    scroller.scrollTop = 75;
    scroller.dispatchEvent(new Event("scroll"));
    sidebar.contextualSidebar = {
      key: "systems",
      data: undefined,
      loaderPending: false,
      render: () => html`<p>Gateway machine</p>`,
    };
    await sidebar.updateComplete;
    expect(sessions.hidden).toBe(true);
    expect(scroller.textContent).toContain("Gateway machine");
    expect(scroller.scrollTop).toBe(0);
    scroller.scrollTop = 35;
    scroller.dispatchEvent(new Event("scroll"));
    sidebar.contextualSidebar = undefined;
    await sidebar.updateComplete;
    expect(sidebar.querySelector(".sidebar-session-content")).toBe(sessions);
    expect(sessions.hidden).toBe(false);
    expect(scroller.scrollTop).toBe(75);
    sidebar.contextualSidebar = {
      key: "systems",
      data: undefined,
      loaderPending: false,
      render: () => html`<p>Gateway machine</p>`,
    };
    await sidebar.updateComplete;
    expect(scroller.scrollTop).toBe(35);
    expect(sidebar.querySelector(".sidebar-nav")).toBe(nav);
    expect(sidebar.querySelector(".sidebar-shell__footer")).toBe(footer);
  });

  it.each(["sessions", "systems"])(
    "shows fades only toward additional %s content",
    async (content) => {
      const gateway = createGateway({} as GatewayBrowserClient);
      const { sidebar } = await mountSidebar(gateway, createSessions("main", ["agent:main:main"]));
      if (content === "systems") {
        sidebar.contextualSidebar = {
          key: "systems",
          data: undefined,
          loaderPending: false,
          render: () => html`<p>Gateway machine</p>`,
        };
        await sidebar.updateComplete;
      }
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
        await sidebar.updateComplete;
        expect(scroller.classList.contains(`sidebar-shell__body--scroll-${expected}`)).toBe(true);
      };

      await expectScrollState(0, "none");
      scrollHeight = 300;
      await expectScrollState(0, "top");
      await expectScrollState(80, "middle");
      await expectScrollState(200, "bottom");
    },
  );
});
