import { html } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createGateway, createSessions, mountSidebar } from "../app-sidebar.ts";
import "../../components/app-sidebar.ts";

describe("AppSidebar scroll", () => {
  it("shows fades only toward additional content", async () => {
    const observers = new Map<
      ResizeObserver,
      { callback: ResizeObserverCallback; targets: Set<Element> }
    >();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          observers.set(this as ResizeObserver, { callback, targets: new Set() });
        }
        observe(target: Element) {
          observers.get(this as ResizeObserver)!.targets.add(target);
        }
        unobserve(target: Element) {
          observers.get(this as ResizeObserver)!.targets.delete(target);
        }
        disconnect() {
          observers.get(this as ResizeObserver)!.targets.clear();
        }
      },
    );
    let visible: IntersectionObserverCallback | undefined;
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: IntersectionObserverCallback) {
          visible = callback;
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
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

    visible?.(
      [{ target: scroller, isIntersecting: true } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    );
    let scrollHeight = 100;
    Object.defineProperties(scroller, {
      checkVisibility: { configurable: true, value: () => true },
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
      for (const [observer, { callback, targets }] of observers) {
        if (targets.has(document.documentElement)) {
          callback([], observer);
        }
      }
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
