import { expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { GatewaySessionRow } from "../api/types.ts";
import { setupSidebarTest } from "../test-helpers/app-sidebar-setup.ts";
import { createGateway, createSessionsHarness, mountSidebar } from "../test-helpers/app-sidebar.ts";
import "../test-helpers/load-styles.ts";
import "./app-sidebar.ts";

setupSidebarTest();

it("pauses offscreen session indicators and resumes them when their rows scroll into view", async () => {
  const NativeObserver = IntersectionObserver;
  const observers: IntersectionObserver[] = [];
  const intersections = new Map<Element, IntersectionObserverEntry>();
  let delivery = Promise.withResolvers<void>();
  vi.stubGlobal(
    "IntersectionObserver",
    class extends NativeObserver {
      constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        super((entries, observer) => {
          callback(entries, observer);
          if (options?.root instanceof Element && options.root.matches(".sidebar-shell__body")) {
            for (const entry of entries) {
              intersections.set(entry.target, entry);
            }
            delivery.resolve();
          }
        }, options);
        if (options?.root instanceof Element && options.root.matches(".sidebar-shell__body")) {
          observers.push(this);
        }
      }
    },
  );
  const harness = createSessionsHarness(
    "main",
    Array.from({ length: 8 }, (_, index) => `agent:main:run-${index}`),
  );
  for (const row of harness.sessions.state.result!.sessions) {
    Object.assign(row, { hasActiveRun: true, status: "running", icon: "🦞" });
  }
  harness.sessions.state.result!.owners = [
    { type: "human", id: "ada", label: "Ada" },
    { type: "human", id: "bob", label: "Bob" },
  ];
  const { sidebar, provider } = await mountSidebar(
    createGateway({} as GatewayBrowserClient),
    harness.sessions,
  );
  sidebar.style.cssText =
    "display:block;position:fixed;inset:0 auto auto 0;width:280px;height:240px";
  const scroller = sidebar.querySelector<HTMLElement>(".sidebar-shell__body")!;
  scroller.style.cssText = "height:120px;flex:none;overflow:auto";
  expect(observers).toHaveLength(1);
  expect(observers[0]!.root).toBe(scroller);
  await delivery.promise;
  const rows = [...sidebar.querySelectorAll<HTMLElement>(".session-row-host")];
  expect(rows).toHaveLength(8);
  const first = rows[0]!;
  const last = rows.at(-1)!;
  const ring = (row: HTMLElement) => row.querySelector<HTMLElement>(".session-glyph__ring")!;
  const scrollTo = async (row: HTMLElement) => {
    delivery = Promise.withResolvers<void>();
    scroller.scrollTop += row.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    await delivery.promise;
  };
  await scrollTo(first);
  expect(ring(first).classList.contains("session-run-indicator--offscreen")).toBe(false);
  expect(getComputedStyle(ring(first)).animationPlayState).toBe("running");
  expect(ring(last).classList.contains("session-run-indicator--offscreen")).toBe(true);
  expect(getComputedStyle(ring(last)).animationPlayState).toBe("paused");

  delivery = Promise.withResolvers<void>();
  scroller.scrollTop += last.getBoundingClientRect().top - scroller.getBoundingClientRect().bottom;
  await delivery.promise;
  expect(intersections.get(last)?.isIntersecting).toBe(true);
  expect(intersections.get(last)?.intersectionRatio).toBe(0);
  expect(ring(last).classList.contains("session-run-indicator--offscreen")).toBe(false);

  await scrollTo(last);
  expect(ring(first).classList.contains("session-run-indicator--offscreen")).toBe(true);
  expect(getComputedStyle(ring(first)).animationPlayState).toBe("paused");
  expect(ring(last).classList.contains("session-run-indicator--offscreen")).toBe(false);
  expect(getComputedStyle(ring(last)).animationPlayState).toBe("running");

  const updateRows = async (patch: Partial<GatewaySessionRow>) => {
    const result = harness.sessions.state.result!;
    harness.publishList({
      result: { ...result, sessions: result.sessions.map((row) => Object.assign({}, row, patch)) },
    });
    await sidebar.updateComplete;
  };
  // Queuing replaces the ring's class binding without moving its observed row.
  await updateRows({ status: "queued" });
  expect(ring(first).classList.contains("session-run-indicator--offscreen")).toBe(true);
  expect(ring(last).classList.contains("session-run-indicator--offscreen")).toBe(false);
  expect(ring(first).classList.contains("session-glyph__ring--queued")).toBe(true);
  expect(getComputedStyle(ring(first)).animationPlayState).toBe("paused");
  expect(getComputedStyle(ring(last)).animationPlayState).toBe("paused");

  // A shared session replaces its circular ring with the paired-avatar trace.
  await updateRows({
    status: "running",
    icon: "",
    owner: { actor: { type: "human", id: "ada", label: "Ada" } },
    participants: [{ identity: { type: "profile", id: "bob" }, label: "Bob" }],
    participantCount: 1,
  });
  const trace = (row: HTMLElement) => row.querySelector<SVGElement>(".session-glyph__trace-run")!;
  expect(trace(first).classList.contains("session-run-indicator--offscreen")).toBe(true);
  expect(getComputedStyle(trace(first)).animationPlayState).toBe("paused");
  expect(trace(last).classList.contains("session-run-indicator--offscreen")).toBe(false);
  expect(getComputedStyle(trace(last)).animationPlayState).toBe("running");

  const unobserve = vi.spyOn(observers[0]!, "unobserve");
  await updateRows({ hasActiveRun: false, status: "done" });
  expect(unobserve).toHaveBeenCalledTimes(8);
  expect(sidebar.querySelector(".session-glyph__trace-run, .session-glyph__ring")).toBeNull();
  delivery = Promise.withResolvers<void>();
  await updateRows({ hasActiveRun: true, status: "running" });
  await delivery.promise;
  expect(observers).toHaveLength(1);
  expect(trace(first).classList.contains("session-run-indicator--offscreen")).toBe(true);

  const disconnect = vi.spyOn(observers[0]!, "disconnect");
  sidebar.remove();
  expect(disconnect).toHaveBeenCalledOnce();
  delivery = Promise.withResolvers<void>();
  provider.append(sidebar);
  await sidebar.updateComplete;
  await delivery.promise;
  expect(observers).toHaveLength(2);
  const reconnectedRows = [...sidebar.querySelectorAll<HTMLElement>(".session-row-host")];
  expect(reconnectedRows).toHaveLength(8);
  await scrollTo(reconnectedRows.at(-1)!);
  expect(trace(reconnectedRows[0]!).classList.contains("session-run-indicator--offscreen")).toBe(
    true,
  );
  expect(getComputedStyle(trace(reconnectedRows.at(-1)!)).animationPlayState).toBe("running");
});
