import type { CDPSession } from "@vitest/browser-playwright";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, expect, it } from "vitest";
import { cdp } from "vitest/browser";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush } from "../../../test-helpers/solid-settle.ts";
import "../../../components/tooltip.ts";
import { buildCompactionDividerItem } from "../chat-progress.ts";
import { renderFallbackIndicatorSolid } from "./chat-composer-status.tsx";
import { ChatDivider } from "./chat-divider.tsx";
import baseStyles from "../../../styles/base.css?inline";
import composerStatusStyles from "../../../styles/chat/composer-status.css?inline";
import chatComposerStyles from "../../../styles/chat/composer.css?inline";
import groupedStyles from "../../../styles/chat/grouped.css?inline";
import chatLayoutStyles from "../../../styles/chat/layout.css?inline";
import componentStyles from "../../../styles/components.css?inline";

function mountCompaction(container: HTMLElement) {
  const [phase, setPhase] = createSignal<"active" | "complete">("active");
  mountSolid(() => <ChatDivider item={buildCompactionDividerItem({}, 1_000, 0, phase())} />, {
    container,
  });
  return (nextPhase: "active" | "complete") => {
    setPhase(nextPhase);
    flush();
  };
}

const expectIdle = (indicator: HTMLElement) =>
  expect
    .poll(() => indicator.getAnimations({ subtree: true }).some((a) => a.playState === "running"))
    .toBe(false);

let container: HTMLDivElement;
let styles: HTMLStyleElement;
let session: CDPSession;

beforeEach(async () => {
  session = cdp();
  await session.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "no-preference" }],
  });
  styles = document.createElement("style");
  styles.textContent = [
    baseStyles,
    componentStyles,
    groupedStyles,
    chatLayoutStyles,
    chatComposerStyles,
    composerStatusStyles,
  ].join("\n");
  document.head.append(styles);
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(async () => {
  container.replaceChildren();
  container.remove();
  styles.remove();
  await session.send("Emulation.setEmulatedMedia", { features: [] });
});

it("folds lines inline without a floating scrim, then reveals the completion check", async () => {
  const setPhase = mountCompaction(container);
  const indicator = container.querySelector<HTMLElement>(".chat-compaction")!;
  const lines = Array.from(container.querySelectorAll(".chat-compaction__line"));
  const check = container.querySelector<SVGElement>(".chat-compaction__glyph svg")!;
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

  setPhase("complete");
  for (const line of lines) {
    expect(getComputedStyle(line).visibility).toBe("hidden");
    expect(getComputedStyle(line).animationName).toBe("none");
  }
  await expect.poll(() => getComputedStyle(check).opacity).toBe("1");
  await expectIdle(indicator);
});

it("keeps active and complete states readable without reduced-motion animations", async () => {
  await session.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  expect(matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(true);
  const setPhase = mountCompaction(container);
  for (const phase of ["active", "complete"] as const) {
    setPhase(phase);
    const indicator = container.querySelector<HTMLElement>(".chat-compaction")!;
    const label = container.querySelector<HTMLElement>(".chat-divider__title")!;
    const check = container.querySelector<SVGElement>(".chat-compaction__glyph svg")!;
    expect(label.textContent?.trim()).not.toBe("");
    expect(getComputedStyle(label).webkitTextFillColor).not.toBe("rgba(0, 0, 0, 0)");
    expect(getComputedStyle(label).backgroundImage).toBe("none");
    await expect.poll(() => getComputedStyle(check).opacity).toBe(phase === "complete" ? "1" : "0");
    for (const element of container.querySelectorAll("*")) {
      expect(getComputedStyle(element).animationName).toBe("none");
    }
    await expectIdle(indicator);
  }
});

it.each(["active", "cleared"] as const)("preserves the %s fallback pill", async (phase) => {
  mountSolid(
    () =>
      renderFallbackIndicatorSolid({
        phase,
        selected: "provider/selected",
        active: "provider/active",
        attempts: [],
        occurredAt: Date.now(),
      }),
    { container },
  );
  await container.querySelector("openclaw-tooltip")!.updateComplete;
  const indicator = container.querySelector<HTMLElement>(".compaction-indicator")!;
  const icon = indicator.querySelector("svg")!;
  expect(getComputedStyle(indicator).borderTopWidth).toBe("1px");
  expect(getComputedStyle(indicator).backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
  expect(getComputedStyle(icon).width).toBe("16px");
  expect(indicator.querySelector(".compaction-indicator__glyph")).toBeNull();
  expect(indicator.getAttribute("role")).toBe("status");
});
