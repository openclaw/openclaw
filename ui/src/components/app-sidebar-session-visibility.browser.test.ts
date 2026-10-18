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

const agents = {
  defaultId: "main",
  mainKey: "main",
  scope: "per-sender" as const,
  agents: [{ id: "main", name: "Main" }],
};
const ring = (row: HTMLElement) => row.querySelector<HTMLElement>(".session-glyph__ring")!;
const trace = (row: HTMLElement) => row.querySelector<SVGElement>(".session-glyph__trace-run")!;
const indicatorSelector = ".session-glyph__ring, .session-glyph__trace-run";
const owner = { actor: { type: "human", id: "ada", label: "Ada" } } as const;
const pair: Pick<GatewaySessionRow, "owner" | "participants" | "participantCount"> = {
  owner,
  participants: [{ identity: { type: "profile", id: "bob" }, label: "Bob" }],
  participantCount: 1,
};
const offscreen = (indicator: Element) =>
  indicator.classList.contains("session-run-indicator--offscreen");
function expectIndicator(indicator: Element, hidden: boolean, animation: string) {
  expect(offscreen(indicator)).toBe(hidden);
  expect(getComputedStyle(indicator).animationPlayState).toBe(animation);
}
function runningRows(root: ParentNode, indicator = ".session-glyph__ring") {
  return [...root.querySelectorAll<HTMLElement>(".session-row-host")].filter((row) =>
    row.querySelector(indicator),
  );
}
function sizeSidebar(sidebar: Parameters<typeof settleRoster>[0], height: number) {
  sidebar.style.cssText = `display:block;position:fixed;inset:0 auto auto 0;width:280px;height:${height}px`;
  const scroller = sidebar.querySelector<HTMLElement>(".sidebar-shell__body")!;
  scroller.style.cssText = "height:600px;flex:none;overflow:auto";
  return scroller;
}
async function revealPages(sidebar: Parameters<typeof settleRoster>[0]) {
  for (let page = 0; page < 2; page++) {
    sidebar.querySelector<HTMLButtonElement>(".sidebar-session-pagination__button")!.click();
    await settleRoster(sidebar);
  }
}
function runState(
  extra: Partial<GatewaySessionRow> | ((index: number) => Partial<GatewaySessionRow>),
  count = 301,
) {
  const state = createSessionState(
    "main",
    Array.from({ length: count }, (_, i) => `agent:main:run-${i}`),
  );
  state.result!.sessions.forEach((row, index) => {
    const running = index === 0 || (index >= 20 && index < 30);
    Object.assign(row, {
      createdAt: 1000 - index,
      hasActiveRun: running,
      status: running ? "running" : "done",
      ...(typeof extra === "function" ? extra(index) : extra),
    });
  });
  return state;
}

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
  const roster = runState({ icon: "🦞" });
  roster.result!.owners = [
    { type: "human", id: "ada", label: "Ada" },
    { type: "human", id: "bob", label: "Bob" },
  ];
  const { sidebar, provider } = await mountSidebar(
    createGateway({} as GatewayBrowserClient),
    harness.sessions,
  );
  let scroller = sizeSidebar(sidebar, 240);
  expect(observers).toHaveLength(0);
  harness.publishList(roster);
  await settleRoster(sidebar);
  const revealRunningRows = async () => {
    await revealPages(sidebar);
    await waitForSolid(() => {
      const running = runningRows(sidebar, indicatorSelector);
      expect(running).toHaveLength(11);
      expect(running.every((row) => intersections.has(row))).toBe(true);
    });
  };
  await revealRunningRows();
  expect(observers).toHaveLength(1);
  expect(observers[0]!.root).toBe(scroller);
  const rows = runningRows(sidebar);
  expect(rows).toHaveLength(11);
  expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight);
  const first = rows[0]!;
  const last = rows.at(-1)!;
  const scrollTo = async (row: HTMLElement, ready = () => true) => {
    probe.reset(ready);
    scroller.scrollTop += row.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    await waitForSolid(() => expect(offscreen(ring(first))).toBe(true));
  };
  expect(first.getBoundingClientRect().top).toBeLessThan(scroller.getBoundingClientRect().bottom);
  expectIndicator(ring(first), false, "running");
  await waitForSolid(() => expect(offscreen(ring(last))).toBe(true));
  expect(getComputedStyle(ring(last)).animationPlayState).toBe("paused");

  scroller.scrollTop += last.getBoundingClientRect().top - scroller.getBoundingClientRect().bottom;
  await waitForSolid(() => expect(intersections.get(last)?.isIntersecting).toBe(true));
  expect(intersections.get(last)?.intersectionRatio).toBe(0);
  expect(offscreen(ring(last))).toBe(false);

  await scrollTo(last, () => intersections.get(first)?.isIntersecting === false);
  expectIndicator(ring(first), true, "paused");
  expectIndicator(ring(last), false, "running");

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
  await updateRows({ status: "queued" });
  await waitForSolid(() => expect(offscreen(ring(first))).toBe(true));
  expectIndicator(ring(last), false, "paused");
  expect(ring(first).classList.contains("session-glyph__ring--queued")).toBe(true);
  expect(getComputedStyle(ring(first)).animationPlayState).toBe("paused");
  await updateRows({ status: "running", icon: "", ...pair });
  await waitForSolid(() => expect(offscreen(trace(first))).toBe(true));
  expect(getComputedStyle(trace(first)).animationPlayState).toBe("paused");
  expectIndicator(trace(last), false, "running");

  expect(activeObservers.size).toBe(1);
  const unobserve = vi.spyOn([...activeObservers][0]!, "unobserve");
  await updateRows({ hasActiveRun: false, status: "done" });
  expect(unobserve).toHaveBeenCalledTimes(11);
  expect(sidebar.querySelector(indicatorSelector)).toBeNull();
  expect(activeObservers.size).toBe(0);
  await updateRows({ hasActiveRun: true, status: "running" });
  expect(activeObservers.size).toBe(1);
  await waitForSolid(() => expect(offscreen(trace(first))).toBe(true));

  const disconnect = vi.spyOn([...activeObservers][0]!, "disconnect");
  sidebar.remove();
  await sidebar.updateComplete;
  expect(disconnect).toHaveBeenCalledOnce();
  expect(activeObservers.size).toBe(0);
  probe.reset();
  provider.append(sidebar.hostElement);
  await settleRoster(sidebar);
  scroller = sizeSidebar(sidebar, 240);
  await revealRunningRows();
  expect(activeObservers.size).toBe(1);
  const reconnectedRows = runningRows(sidebar, ".session-glyph__trace-run");
  expect(reconnectedRows).toHaveLength(11);
  probe.reset();
  scroller.scrollTop +=
    reconnectedRows.at(-1)!.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  await probe.delivered;
  await waitForSolid(() => expect(offscreen(trace(reconnectedRows[0]!))).toBe(true));
  expect(getComputedStyle(trace(reconnectedRows.at(-1)!)).animationPlayState).toBe("running");
});

it("registers the aggregate agent run ring without exposing session rows", async () => {
  const probe = visibilityProbe();
  const rows = runState({ agentId: "main", isMain: false }).result!.sessions;
  const { sidebar, context, result } = await mountRoster(agents, rows);
  const scroller = sizeSidebar(sidebar, 800);
  sidebar.sidebarAgentsMode = "roster";
  await settleRoster(sidebar);
  const roster = sidebar.querySelector("openclaw-sidebar-agent-roster")!;
  await waitForSolid(() => expect(runningRows(roster)).toHaveLength(1));
  const visibleRuns = runningRows(roster);
  expect(probe.activeObservers.size).toBe(1);
  expect(visibleRuns.filter((row) => probe.observed.has(row))).toHaveLength(1);
  expect(probe.observed.size).toBe(1);
  const first = visibleRuns[0]!;
  expect(first.closest('[data-agent-group="main"]')).not.toBeNull();
  expect(first.querySelector("[data-session-key]")).toBeNull();
  expect(first.getBoundingClientRect().bottom).toBeLessThan(
    scroller.getBoundingClientRect().bottom,
  );
  expectIndicator(ring(first), false, "running");
  result.sessions = result.sessions.map((row) =>
    Object.assign({}, row, { hasActiveRun: false, status: "done" }),
  );
  await rosterActivityStore(context).refresh();
  await settleRoster(sidebar);
  expect(runningRows(roster)).toHaveLength(0);
  expect(probe.observed.size).toBe(0);
});

it.each(["chip", "roster"] as const)(
  "preserves running animations through %s session refreshes",
  async (mode) => {
    const variants: Partial<GatewaySessionRow>[] = [{}, { icon: "🦞" }, { owner }, pair];
    const roster = runState(
      (index) => ({
        label: `Run ${index}`,
        agentId: "main",
        isMain: false,
        hasActiveRun: true,
        status: "running",
        ...variants[index],
      }),
      4,
    );
    const {
      sidebar,
      sessions: harness,
      result,
      context,
    } = await mountRoster(agents, roster.result!.sessions);
    sidebar.style.cssText =
      "display:block;position:fixed;inset:0 auto auto 0;width:320px;height:900px";
    sidebar.sidebarAgentsMode = mode;
    await settleRoster(sidebar);
    const indicators = () => [
      ...sidebar.querySelectorAll<HTMLElement>(
        mode === "chip"
          ? `.sidebar-recent-session :is(${indicatorSelector})`
          : `.sidebar-agent-roster__avatar :is(${indicatorSelector})`,
      ),
    ];
    await waitForSolid(() => expect(indicators()).toHaveLength(mode === "chip" ? 4 : 1));
    const original = indicators();
    const keys = original.map((element) =>
      mode === "chip"
        ? element.closest<HTMLElement>("[data-session-key]")!.dataset.sessionKey
        : element.closest<HTMLElement>("[data-agent-group]")!.dataset.agentGroup,
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
      if (mode === "chip") {
        expect(sidebar.textContent).toContain("Run 0 " + update);
      }
      const current = keys.map((key) =>
        sidebar.querySelector<HTMLElement>(
          mode === "chip"
            ? `[data-session-key="${key}"] :is(${indicatorSelector})`
            : `[data-agent-group="${key}"] .sidebar-agent-roster__avatar :is(${indicatorSelector})`,
        )!,
      );
      expect(current).toHaveLength(mode === "chip" ? 4 : 1);
      current.forEach((element, index) => {
        expect(element).toBe(original[index]);
        expect(element.getAnimations()[0]).toBe(animations[index]);
        expect(animations[index]!.currentTime).toBe(500);
      });
    }
  },
);
