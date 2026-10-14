import { expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { GatewaySessionRow } from "../api/types.ts";
import { rosterActivityStore } from "../lib/agents/roster-activity-store.ts";
import {
  mountRoster,
  settleRoster,
} from "../test-helpers/app-sidebar-cases/roster.test-support.ts";
import { setupSidebarTest } from "../test-helpers/app-sidebar-setup.ts";
import {
  createGateway,
  createSessionState,
  createSessionsHarness,
  mountSidebar,
} from "../test-helpers/app-sidebar.ts";
import "../test-helpers/load-styles.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import "./app-sidebar.tsx";

setupSidebarTest();

function visibilityProbe() {
  const NativeObserver = IntersectionObserver;
  const observers: IntersectionObserver[] = [];
  const activeObservers = new Set<IntersectionObserver>();
  const observed = new Set<Element>();
  const intersections = new Map<Element, IntersectionObserverEntry>();
  let delivery = Promise.withResolvers<void>();
  let deliveryReady = () => true;
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
            if (deliveryReady()) {
              delivery.resolve();
            }
          }
        }, options);
        if (options?.root instanceof Element && options.root.matches(".sidebar-shell__body")) {
          observers.push(this);
          activeObservers.add(this);
        }
      }
      override disconnect() {
        activeObservers.delete(this);
        super.disconnect();
      }
      override observe(target: Element) {
        if (this.root instanceof Element && this.root.matches(".sidebar-shell__body")) {
          observed.add(target);
        }
        super.observe(target);
      }
      override unobserve(target: Element) {
        observed.delete(target);
        super.unobserve(target);
      }
    },
  );
  return {
    observers,
    activeObservers,
    observed,
    intersections,
    get delivered() {
      return delivery.promise;
    },
    reset(ready = () => true) {
      deliveryReady = ready;
      delivery = Promise.withResolvers<void>();
    },
  };
}

it("pauses offscreen session indicators and resumes them when their rows scroll into view", async () => {
  const probe = visibilityProbe();
  const { observers, activeObservers, intersections } = probe;
  const harness = createSessionsHarness("main", []);
  const roster = createSessionState(
    "main",
    Array.from({ length: 301 }, (_, index) => `agent:main:run-${index}`),
  );
  roster.result!.sessions.forEach((row, index) => {
    const running = index === 0 || (index >= 20 && index < 30);
    Object.assign(row, {
      createdAt: 1000 - index,
      hasActiveRun: running,
      status: running ? "running" : "done",
      icon: "🦞",
    });
  });
  roster.result!.owners = [
    { type: "human", id: "ada", label: "Ada" },
    { type: "human", id: "bob", label: "Bob" },
  ];
  const { sidebar, provider } = await mountSidebar(
    createGateway({} as GatewayBrowserClient),
    harness.sessions,
  );
  sidebar.style.cssText =
    "display:block;position:fixed;inset:0 auto auto 0;width:280px;height:240px";
  let scroller = sidebar.querySelector<HTMLElement>(".sidebar-shell__body")!;
  scroller.style.cssText = "height:600px;flex:none;overflow:auto";
  expect(observers).toHaveLength(0);
  harness.publishList(roster);
  await settleRoster(sidebar);
  const revealRunningRows = async () => {
    for (let page = 0; page < 2; page++) {
      sidebar.querySelector<HTMLButtonElement>(".sidebar-session-pagination__button")!.click();
      await settleRoster(sidebar);
    }
    await waitForSolid(() => {
      const runningRows = [...sidebar.querySelectorAll<HTMLElement>(".session-row-host")].filter(
        (row) => row.querySelector(".session-glyph__ring, .session-glyph__trace-run"),
      );
      // Solid retains observed rows, so existing entries also satisfy readiness.
      expect(runningRows).toHaveLength(11);
      expect(runningRows.every((row) => intersections.has(row))).toBe(true);
    });
  };
  await revealRunningRows();
  expect(observers).toHaveLength(1);
  expect(observers[0]!.root).toBe(scroller);
  const rows = [...sidebar.querySelectorAll<HTMLElement>(".session-row-host")].filter((row) =>
    row.querySelector(".session-glyph__ring"),
  );
  expect(rows).toHaveLength(11);
  expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight);
  const first = rows[0]!;
  const last = rows.at(-1)!;
  const ring = (row: HTMLElement) => row.querySelector<HTMLElement>(".session-glyph__ring")!;
  const scrollTo = async (row: HTMLElement, ready = () => true) => {
    probe.reset(ready);
    scroller.scrollTop += row.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    await waitForSolid(() =>
      expect(ring(first).classList.contains("session-run-indicator--offscreen")).toBe(true),
    );
  };
  expect(first.getBoundingClientRect().top).toBeLessThan(scroller.getBoundingClientRect().bottom);
  expect(ring(first).classList.contains("session-run-indicator--offscreen")).toBe(false);
  expect(getComputedStyle(ring(first)).animationPlayState).toBe("running");
  await waitForSolid(() =>
    expect(ring(last).classList.contains("session-run-indicator--offscreen")).toBe(true),
  );
  expect(getComputedStyle(ring(last)).animationPlayState).toBe("paused");

  scroller.scrollTop += last.getBoundingClientRect().top - scroller.getBoundingClientRect().bottom;
  await waitForSolid(() => expect(intersections.get(last)?.isIntersecting).toBe(true));
  expect(intersections.get(last)?.intersectionRatio).toBe(0);
  expect(ring(last).classList.contains("session-run-indicator--offscreen")).toBe(false);

  await scrollTo(last, () => intersections.get(first)?.isIntersecting === false);
  expect(ring(first).classList.contains("session-run-indicator--offscreen")).toBe(true);
  expect(getComputedStyle(ring(first)).animationPlayState).toBe("paused");
  expect(ring(last).classList.contains("session-run-indicator--offscreen")).toBe(false);
  expect(getComputedStyle(ring(last)).animationPlayState).toBe("running");

  const updateRows = async (patch: Partial<GatewaySessionRow>) => {
    const result = harness.sessions.state.result!;
    harness.publishList({
      result: {
        ...result,
        sessions: result.sessions.map((row) =>
          rows.some((element) => element.dataset.sessionKey === row.key)
            ? Object.assign({}, row, patch)
            : row,
        ),
      },
    });
    await settleRoster(sidebar);
    if (patch.hasActiveRun !== false) {
      await probe.delivered;
    }
  };
  // Queuing replaces the ring's class binding without moving its observed row.
  await updateRows({ status: "queued" });
  await waitForSolid(() =>
    expect(ring(first).classList.contains("session-run-indicator--offscreen")).toBe(true),
  );
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
  await waitForSolid(() =>
    expect(trace(first).classList.contains("session-run-indicator--offscreen")).toBe(true),
  );
  expect(getComputedStyle(trace(first)).animationPlayState).toBe("paused");
  expect(trace(last).classList.contains("session-run-indicator--offscreen")).toBe(false);
  expect(getComputedStyle(trace(last)).animationPlayState).toBe("running");

  expect(activeObservers.size).toBe(1);
  const unobserve = vi.spyOn([...activeObservers][0]!, "unobserve");
  await updateRows({ hasActiveRun: false, status: "done" });
  expect(unobserve).toHaveBeenCalledTimes(11);
  expect(sidebar.querySelector(".session-glyph__trace-run, .session-glyph__ring")).toBeNull();
  expect(activeObservers.size).toBe(0);
  await updateRows({ hasActiveRun: true, status: "running" });
  expect(activeObservers.size).toBe(1);
  await waitForSolid(() =>
    expect(trace(first).classList.contains("session-run-indicator--offscreen")).toBe(true),
  );

  const disconnect = vi.spyOn([...activeObservers][0]!, "disconnect");
  sidebar.remove();
  await sidebar.updateComplete;
  expect(disconnect).toHaveBeenCalledOnce();
  expect(activeObservers.size).toBe(0);
  probe.reset();
  provider.append(sidebar.hostElement);
  await settleRoster(sidebar);
  sidebar.style.cssText =
    "display:block;position:fixed;inset:0 auto auto 0;width:280px;height:240px";
  scroller = sidebar.querySelector<HTMLElement>(".sidebar-shell__body")!;
  scroller.style.cssText = "height:600px;flex:none;overflow:auto";
  await revealRunningRows();
  expect(activeObservers.size).toBe(1);
  const reconnectedRows = [...sidebar.querySelectorAll<HTMLElement>(".session-row-host")].filter(
    (row) => row.querySelector(".session-glyph__trace-run"),
  );
  expect(reconnectedRows).toHaveLength(11);
  probe.reset();
  scroller.scrollTop +=
    reconnectedRows.at(-1)!.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  await probe.delivered;
  await waitForSolid(() =>
    expect(trace(reconnectedRows[0]!).classList.contains("session-run-indicator--offscreen")).toBe(
      true,
    ),
  );
  expect(getComputedStyle(trace(reconnectedRows.at(-1)!)).animationPlayState).toBe("running");
});

it("registers running rows rendered by the real roster child after its parent update", async () => {
  const probe = visibilityProbe();
  const rows = createSessionState(
    "main",
    Array.from({ length: 301 }, (_, index) => `agent:main:roster-${index}`),
  ).result!.sessions;
  rows.forEach((row, index) => {
    const running = index === 0 || (index >= 20 && index < 30);
    Object.assign(row, {
      agentId: "main",
      isMain: false,
      createdAt: 1000 - index,
      hasActiveRun: running,
      status: running ? "running" : "done",
    });
  });
  const { sidebar } = await mountRoster(
    {
      defaultId: "main",
      mainKey: "main",
      scope: "per-sender",
      agents: [{ id: "main", name: "Main" }],
    },
    rows,
  );
  sidebar.style.cssText =
    "display:block;position:fixed;inset:0 auto auto 0;width:280px;height:800px";
  const scroller = sidebar.querySelector<HTMLElement>(".sidebar-shell__body")!;
  scroller.style.cssText = "height:600px;flex:none;overflow:auto";
  sidebar.sidebarAgentsMode = "roster";
  await settleRoster(sidebar);
  for (let page = 0; page < 2; page++) {
    sidebar.querySelector<HTMLButtonElement>(".sidebar-session-pagination__button")!.click();
    await settleRoster(sidebar);
  }
  const roster = sidebar.querySelector("openclaw-sidebar-agent-roster")!;
  const runningRows = [...roster.querySelectorAll<HTMLElement>(".session-row-host")].filter((row) =>
    row.querySelector(".session-glyph__ring"),
  );
  expect(runningRows).toHaveLength(11);
  expect(probe.activeObservers.size).toBe(1);
  expect(runningRows.filter((row) => probe.observed.has(row))).toHaveLength(11);
  expect(probe.observed.size).toBe(11);
  const ring = (row: HTMLElement) => row.querySelector<HTMLElement>(".session-glyph__ring")!;
  const first = runningRows[0]!;
  const offscreen = runningRows.slice(1);
  expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight);
  expect(first.getBoundingClientRect().bottom).toBeLessThan(
    scroller.getBoundingClientRect().bottom,
  );
  expect(offscreen[0]!.getBoundingClientRect().top).toBeGreaterThan(
    scroller.getBoundingClientRect().bottom,
  );
  expect(ring(first).classList.contains("session-run-indicator--offscreen")).toBe(false);
  expect(getComputedStyle(ring(first)).animationPlayState).toBe("running");
  await waitForSolid(() =>
    expect(
      offscreen.every((row) => ring(row).classList.contains("session-run-indicator--offscreen")),
    ).toBe(true),
  );
  expect(offscreen.map((row) => getComputedStyle(ring(row)).animationPlayState)).toEqual(
    Array(10).fill("paused"),
  );
  scroller.scrollTop = scroller.scrollHeight;
  await waitForSolid(() => {
    expect(ring(first).classList.contains("session-run-indicator--offscreen")).toBe(true);
    expect(
      offscreen.every((row) => !ring(row).classList.contains("session-run-indicator--offscreen")),
    ).toBe(true);
  });
  expect(offscreen.map((row) => getComputedStyle(ring(row)).animationPlayState)).toEqual(
    Array(10).fill("running"),
  );
});

it.each(["chip", "roster"] as const)(
  "preserves running animations through %s session refreshes",
  async (mode) => {
    const roster = createSessionState(
      "main",
      ["bare", "icon", "owner", "pair"].map((kind) => "agent:main:" + kind),
    );
    roster.result!.sessions.forEach((row, index) => {
      Object.assign(row, {
        label: ["Review changes", "Run focused tests", "Check documentation", "Verify the fix"][
          index
        ],
        agentId: "main",
        isMain: false,
        hasActiveRun: true,
        status: "running",
        createdAt: 1000 - index,
        ...(index === 1 ? { icon: "🦞" } : {}),
        ...(index >= 2 ? { owner: { actor: { type: "human", id: "ada", label: "Ada" } } } : {}),
        ...(index === 3
          ? {
              participants: [{ identity: { type: "profile", id: "bob" }, label: "Bob" }],
              participantCount: 1,
            }
          : {}),
      });
    });
    const {
      sidebar,
      sessions: harness,
      result,
      context,
    } = await mountRoster(
      {
        defaultId: "main",
        mainKey: "main",
        scope: "per-sender",
        agents: [{ id: "main", name: "Main" }],
      },
      roster.result!.sessions,
    );
    sidebar.style.cssText =
      "display:block;position:fixed;inset:0 auto auto 0;width:320px;height:900px";
    sidebar.sidebarAgentsMode = mode;
    await settleRoster(sidebar);
    const indicators = () => [
      ...sidebar.querySelectorAll<HTMLElement>(
        ".sidebar-recent-session .session-glyph__ring, .sidebar-recent-session .session-glyph__trace-run",
      ),
    ];
    await waitForSolid(() => expect(indicators()).toHaveLength(4));
    const original = indicators();
    const keys = original.map(
      (element) => element.closest<HTMLElement>("[data-session-key]")!.dataset.sessionKey,
    );
    const animations = original.map((element) => element.getAnimations()[0]!);
    expect(animations.every(Boolean)).toBe(true);
    animations.forEach((animation) => {
      animation.pause();
      animation.currentTime = 500;
    });
    for (let update = 1; update <= 3; update++) {
      const refreshed = {
        ...result,
        sessions: roster.result!.sessions.map((row) =>
          Object.assign({}, row, {
            label: row.label + " " + update,
            updatedAt: 1000 + update,
            lastMessagePreview: "Progress update " + update,
          }),
        ),
      };
      result.sessions = refreshed.sessions;
      harness.publishList({ result: refreshed });
      if (mode === "roster") {
        await rosterActivityStore(context).refresh();
      }
      await settleRoster(sidebar);
      expect(sidebar.textContent).toContain("Review changes " + update);
      const current = keys.map((key) =>
        sidebar.querySelector<HTMLElement>(
          '[data-session-key="' +
            key +
            '"] .session-glyph__ring, [data-session-key="' +
            key +
            '"] .session-glyph__trace-run',
        )!,
      );
      expect(current).toHaveLength(4);
      current.forEach((element, index) => {
        expect(element).toBe(original[index]);
        expect(element.getAnimations()[0]).toBe(animations[index]);
        expect(animations[index]!.currentTime).toBe(500);
      });
    }
  },
);
