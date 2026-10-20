/* @vitest-environment jsdom */
import { createComponent, createSignal, flush } from "solid-js";
import { expect, it } from "vitest";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { CapacityMeter } from "./solid/capacity-meter.tsx";
import { workerCapacityPresentation } from "./solid/worker-capacity.tsx";

const renderCapacity = (params: Parameters<typeof workerCapacityPresentation>[0]) =>
  mountSolid(() => workerCapacityPresentation(params)?.meter).container;
it("resizes filled pips while preserving retained slots", () => {
  const [capacity, setCapacity] = createSignal({ total: 2, used: 1 });
  const view = mountSolid(() =>
    createComponent(CapacityMeter, {
      mode: "discrete",
      label: "Workers",
      get total() {
        return capacity().total;
      },
      get used() {
        return capacity().used;
      },
      tone: "accent",
    }),
  );
  const pips = () => view.container.querySelectorAll(".capacity-meter-pips__pip");
  const first = pips()[0];
  setCapacity({ total: 4, used: 3 });
  flush();
  expect(pips()).toHaveLength(4);
  expect(pips()[0]).toBe(first);
  expect(view.container.querySelectorAll(".capacity-meter-pips__pip--filled")).toHaveLength(3);
  setCapacity({ total: 1, used: 0 });
  flush();
  expect(pips()).toHaveLength(1);
  expect(pips()[0]).toBe(first);
  expect(view.container.querySelectorAll(".capacity-meter-pips__pip--filled")).toHaveLength(0);
});

it.each([
  ["idle", 8, false, 0, "accent", "0 of 8 slots busy"],
  ["partially occupied", 5, false, 3, "accent", "3 of 8 slots busy"],
  ["at capacity", 0, false, 8, "warn", "8 of 8 slots busy"],
  ["ineligible and saturated", 0, true, 0, "stale", "Slot utilization unavailable"],
] as const)(
  "renders %s without reversing free and busy",
  (_name, available, unavailable, filled, tone, label) => {
    const container = renderCapacity({ workerSlots: { total: 8, available }, unavailable });
    const meter = container.querySelector('[role="img"]');
    expect(meter?.getAttribute("aria-label")).toBe(label);
    expect(meter?.classList.contains(`session-context-meter--${tone}`)).toBe(true);
    expect(container.querySelectorAll(".capacity-meter-pips__pip")).toHaveLength(8);
    expect(container.querySelectorAll(".capacity-meter-pips__pip--filled")).toHaveLength(filled);
  },
);

it.each([
  { total: 12, unavailable: false, pips: 12, width: undefined, tone: "accent" },
  { total: 13, unavailable: false, pips: 0, width: "100%", tone: "warn" },
  { total: 1024, unavailable: false, pips: 0, width: "50%", tone: "accent" },
  { total: 13, unavailable: true, pips: 0, width: "0%", tone: "stale" },
])(
  "bounds glyphs for $total slots (unavailable=$unavailable)",
  ({ total, unavailable, pips, width, tone }) => {
    const available = total === 13 ? 0 : total / 2;
    const container = renderCapacity({ workerSlots: { total, available }, unavailable });
    const meter = container.querySelector('[role="img"]');
    const fill = container.querySelector<HTMLElement>(".session-context-meter__fill");
    expect(container.querySelectorAll(".capacity-meter-pips__pip")).toHaveLength(pips);
    expect(fill?.style.width).toBe(width);
    expect(meter?.classList.contains(`session-context-meter--${tone}`)).toBe(true);
    expect(meter?.getAttribute("aria-label")).toBe(
      unavailable ? "Slot utilization unavailable" : `${total - available} of ${total} slots busy`,
    );
  },
);

it.each([
  { capabilities: ["codex.exec-server"], unavailable: false },
  { capabilities: ["codex.exec-server.stdio.v1"], unavailable: false },
  { commands: ["codex.exec-server.stdio.v1"], unavailable: false },
  { capabilities: ["codex.exec-server"], unavailable: true },
])("shows a terminal affordance for a slot-less exec host: %j", (params) => {
  const container = renderCapacity(params);
  expect(container.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe("Codex exec");
  expect(container.textContent).toContain("Codex exec");
  expect(container.querySelector("svg")).not.toBeNull();
  expect(container.querySelector(".capacity-meter-pips, .session-context-meter")).toBeNull();
});

it("prefers slots on dual hosts and renders nothing for an unmetered ordinary device", () => {
  const dualHost = renderCapacity({
    workerSlots: { total: 8, available: 5 },
    capabilities: ["codex.exec-server"],
    unavailable: false,
  });
  expect(dualHost.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe(
    "3 of 8 slots busy",
  );
  expect(dualHost.textContent).not.toContain("Codex exec");
  for (const unavailable of [false, true]) {
    const unmetered = renderCapacity({ capabilities: ["camera"], unavailable });
    expect(unmetered.querySelector('[role="img"]')).toBeNull();
    expect(unmetered.textContent).toBe("");
  }
});
