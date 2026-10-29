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
  const activeObservers = new Set<IntersectionObserver>();
  const observed = new Set<Element>();
  vi.stubGlobal(
    "IntersectionObserver",
    class extends NativeObserver {
      constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        super(callback, options);
        if (options?.root instanceof Element && options.root.matches(".sidebar-shell__body")) {
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
  return { activeObservers, observed };
}

it.each([30, 44])(
  "restores offscreen session content and live indicators with %i px rows",
  async (rowFloor) => {
    const probe = visibilityProbe();
    const harness = createSessionsHarness("main", []);
    const rows = runState({ icon: "🦞" });
    rows.result!.owners = [
      { type: "human", id: "ada", label: "Ada" },
      { type: "human", id: "bob", label: "Bob" },
    ];
    const { sidebar, provider } = await mountSidebar(
      createGateway({} as GatewayBrowserClient),
      harness.sessions,
    );
    const scroller = sizeSidebar(sidebar, 240);
    sidebar
      .querySelector<HTMLElement>(".sidebar-shell")!
      .style.setProperty("--sidebar-session-row-floor", `${rowFloor}px`);
    harness.publishList(rows);
    await settleRoster(sidebar);
    await revealPages(sidebar);
    const row = (index: number) =>
      sidebar.querySelector<HTMLElement>(`[data-session-key="agent:main:run-${index}"]`);
    await waitForSolid(() => {
      expect(row(0)).not.toBeNull();
      expect(row(0)!.getBoundingClientRect().height).toBe(rowFloor);
      expect(row(1)!.getBoundingClientRect().top - row(0)!.getBoundingClientRect().top).toBe(
        rowFloor + 2,
      );
      expect(row(29)).toBeNull();
      expect(sidebar.querySelectorAll("[data-session-key]").length).toBeLessThan(40);
    });
    const first = row(0)!;
    expectIndicator(ring(first), false, "running");
    expect(probe.activeObservers.size).toBe(1);
    const totalHeight = scroller.scrollHeight;
    scroller.scrollTop = 25 * (rowFloor + 2);
    scroller.dispatchEvent(new Event("scroll"));
    await waitForSolid(() => {
      expect(row(0)).toBeNull();
      expect(row(29)).not.toBeNull();
    });
    expect(first.isConnected).toBe(false);
    const last = row(29)!;
    await waitForSolid(() => expect(offscreen(ring(last))).toBe(false));
    expect(scroller.scrollHeight).toBe(totalHeight);
    const updateRows = async (patch: Partial<GatewaySessionRow>) => {
      const result = harness.sessions.state.result!;
      harness.publishList({
        result: {
          ...result,
          sessions: result.sessions.map((session) => Object.assign({}, session, patch)),
        },
      });
      await settleRoster(sidebar);
    };
    await updateRows({ status: "queued" });
    await waitForSolid(() =>
      expect(ring(row(29)!).classList.contains("session-glyph__ring--queued")).toBe(true),
    );
    expectIndicator(ring(row(29)!), false, "paused");
    await updateRows({ status: "running", icon: "", ...pair });
    await waitForSolid(() => expect(offscreen(trace(row(29)!))).toBe(false));
    expectIndicator(trace(row(29)!), false, "running");
    const viewportTop = scroller.getBoundingClientRect().top;
    const anchor = [...sidebar.querySelectorAll<HTMLElement>("[data-session-key]")].find(
      (element) => element.getBoundingClientRect().top >= viewportTop,
    )!;
    const anchorKey = anchor.dataset.sessionKey;
    const anchorOffset = anchor.getBoundingClientRect().top - viewportTop;
    sidebar.navigationView = "pages";
    await settleRoster(sidebar);
    sidebar.navigationView = "sessions";
    await settleRoster(sidebar);
    await waitForSolid(() => {
      const restored = sidebar.querySelector<HTMLElement>(`[data-session-key="${anchorKey}"]`);
      expect(restored).not.toBeNull();
      expect(
        Math.abs(restored!.getBoundingClientRect().top - viewportTop - anchorOffset),
      ).toBeLessThan(1);
    });
    scroller.scrollTop = 0;
    scroller.dispatchEvent(new Event("scroll"));
    await waitForSolid(() => expect(row(0)).not.toBeNull());
    await waitForSolid(() => expect(offscreen(trace(row(0)!))).toBe(false));
    expectIndicator(trace(row(0)!), false, "running");
    await updateRows({ hasActiveRun: false, status: "done" });
    expect(sidebar.querySelector(indicatorSelector)).toBeNull();
    expect(probe.activeObservers.size).toBe(0);
    await updateRows({ hasActiveRun: true, status: "running" });
    expect(probe.activeObservers.size).toBe(1);
    const disconnect = vi.spyOn([...probe.activeObservers][0]!, "disconnect");
    sidebar.remove();
    await sidebar.updateComplete;
    expect(disconnect).toHaveBeenCalledOnce();
    expect(probe.activeObservers.size).toBe(0);
    provider.append(sidebar.hostElement);
    await settleRoster(sidebar);
    sizeSidebar(sidebar, 240);
    await waitForSolid(() => expect(row(0)).not.toBeNull());
    expect(probe.activeObservers.size).toBe(1);
  },
);

it.each(["chip", "roster"] as const)(
  "preserves running animations through %s refreshes and retires their observations",
  async (mode) => {
    const probe = visibilityProbe();
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
    const scroller = sizeSidebar(sidebar, 900);
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
    expect(probe.activeObservers.size).toBe(1);
    if (mode === "roster") {
      const aggregate = original[0]!.closest<HTMLElement>(".session-row-host")!;
      expect(probe.observed.has(aggregate)).toBe(true);
      expect(probe.observed.size).toBe(1);
      expect(aggregate.closest('[data-agent-group="main"]')).not.toBeNull();
      expect(aggregate.querySelector("[data-session-key]")).toBeNull();
      expect(aggregate.getBoundingClientRect().bottom).toBeLessThan(
        scroller.getBoundingClientRect().bottom,
      );
      expectIndicator(original[0]!, false, "running");
    }
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
    result.sessions = result.sessions.map((row) => ({
      ...row,
      hasActiveRun: false,
      status: "done",
    }));
    harness.publishList({ result });
    if (mode === "roster") {
      await rosterActivityStore(context).refresh();
    }
    await settleRoster(sidebar);
    expect(indicators()).toHaveLength(0);
    expect(probe.observed.size).toBe(0);
  },
);
