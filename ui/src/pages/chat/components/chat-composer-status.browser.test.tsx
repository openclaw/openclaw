import { createSignal } from "solid-js";
import { afterEach, beforeEach, expect, it } from "vitest";
import { cdp } from "vitest/browser";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush } from "../../../test-helpers/solid-settle.ts";
import "../../../components/tooltip.ts";
import { buildCompactionDividerItem } from "../chat-progress.ts";
import { renderFallbackIndicatorSolid } from "./chat-composer-status.tsx";
import { ChatDivider } from "./chat-divider.tsx";
import "../../../styles/base.css";
import "../../../styles/components.css";
import "../../../styles/chat/grouped.css";
import "../../../styles/chat/layout.css";
import "../../../styles/chat/composer.css";
import "../../../styles/chat/composer-status.css";

function mountCompaction() {
  const [phase, setPhase] = createSignal<"active" | "complete">("active");
  container = mountSolid(() => (
    <ChatDivider item={buildCompactionDividerItem({}, 1_000, 0, phase())} />
  )).container;
  return (nextPhase: "active" | "complete") => {
    setPhase(nextPhase);
    flush();
  };
}

const expectIdle = (indicator: HTMLElement) =>
  expect
    .poll(() => indicator.getAnimations({ subtree: true }).some((a) => a.playState === "running"))
    .toBe(false);

let container: HTMLElement;
let session: ReturnType<typeof cdp>;
const setMotion = (value: string) =>
  session.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value }],
  });

beforeEach(() => {
  session = cdp();
  return setMotion("no-preference");
});

afterEach(() => session.send("Emulation.setEmulatedMedia", { features: [] }));

it.each(["no-preference", "reduce"])("animates compaction with motion=%s", async (motion) => {
  await setMotion(motion);
  expect(matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(motion === "reduce");
  const setPhase = mountCompaction();
  const indicator = container.querySelector<HTMLElement>(".chat-compaction")!;
  const lines = Array.from(container.querySelectorAll(".chat-compaction__line"));
  const label = container.querySelector<HTMLElement>(".chat-divider__title")!;
  const check = container.querySelector<SVGElement>(".chat-compaction__glyph svg")!;
  if (motion === "no-preference") {
    expect(lines.length).toBeGreaterThan(0);
    expect(getComputedStyle(indicator)).toMatchObject({
      backgroundColor: "rgba(0, 0, 0, 0)",
      boxShadow: "none",
      borderTopWidth: "0px",
      animationName: "none",
    });
    expect(getComputedStyle(check).opacity).toBe("0");
    for (const line of lines) {
      expect(getComputedStyle(line).animationName).not.toBe("none");
      expect(getComputedStyle(line).animationIterationCount).toBe("infinite");
    }
    for (const element of container.querySelectorAll("*")) {
      expect(getComputedStyle(element).animationName).not.toContain("spin");
    }
  }
  for (const phase of ["active", "complete"] as const) {
    setPhase(phase);
    if (motion === "reduce") {
      expect(label.textContent?.trim()).not.toBe("");
      expect(getComputedStyle(label).webkitTextFillColor).not.toBe("rgba(0, 0, 0, 0)");
      expect(getComputedStyle(label).backgroundImage).toBe("none");
      for (const element of container.querySelectorAll("*")) {
        expect(getComputedStyle(element).animationName).toBe("none");
      }
    }
    if (phase === "complete") {
      for (const line of lines) {
        const { visibility, animationName } = getComputedStyle(line);
        expect([visibility, animationName]).toEqual(["hidden", "none"]);
      }
    }
    await expect.poll(() => getComputedStyle(check).opacity).toBe(phase === "complete" ? "1" : "0");
    if (motion === "reduce" || phase === "complete") {
      await expectIdle(indicator);
    }
  }
});

it.each(["active", "cleared"] as const)("preserves the %s fallback pill", async (phase) => {
  const fallback = {
    phase,
    selected: "provider/selected",
    active: "provider/active",
    attempts: [],
    occurredAt: Date.now(),
  };
  container = mountSolid(() => renderFallbackIndicatorSolid(fallback)).container;
  await container.querySelector("openclaw-tooltip")!.updateComplete;
  const indicator = container.querySelector<HTMLElement>(".compaction-indicator")!;
  const icon = indicator.querySelector("svg")!;
  expect(getComputedStyle(indicator).borderTopWidth).toBe("1px");
  expect(getComputedStyle(indicator).backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
  expect(getComputedStyle(icon).width).toBe("16px");
  expect(indicator.querySelector(".compaction-indicator__glyph")).toBeNull();
  expect(indicator.getAttribute("role")).toBe("status");
});
