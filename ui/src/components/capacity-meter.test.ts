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
  // total, available, unavailable, filled pips, bar width, tone
  [8, 8, false, 0, undefined, "accent"],
  [8, 5, false, 3, undefined, "accent"],
  [8, 0, false, 8, undefined, "warn"],
  [8, 0, true, 0, undefined, "stale"],
  [12, 6, false, 6, undefined, "accent"],
  [13, 0, false, 0, "100%", "warn"],
  [1024, 512, false, 0, "50%", "accent"],
  [13, 0, true, 0, "0%", "stale"],
] as const)(
  "renders %i total/%i available slots (unavailable=%s)",
  (total, available, unavailable, filled, width, tone) => {
    const container = renderCapacity({ workerSlots: { total, available }, unavailable });
    const meter = container.querySelector('[role="img"]');
    const fill = container.querySelector<HTMLElement>(".session-context-meter__fill");
    expect(container.querySelectorAll(".capacity-meter-pips__pip")).toHaveLength(
      total <= 12 ? total : 0,
    );
    expect(container.querySelectorAll(".capacity-meter-pips__pip--filled")).toHaveLength(filled);
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
