import { flush } from "solid-js";
import { expect } from "vitest";
import "./tooltip.ts";

export type TooltipElement = HTMLElementTagNameMap["openclaw-tooltip"];

export function createTooltip(content: string, triggerText = "trigger") {
  const tooltip = document.createElement("openclaw-tooltip");
  tooltip.content = content;
  const trigger = document.createElement("button");
  trigger.textContent = triggerText;
  tooltip.append(trigger);
  return { tooltip, trigger };
}

export function createRichTooltip(content: string, triggerText = "trigger") {
  const tooltip = document.createElement("openclaw-tooltip");
  const trigger = document.createElement("button");
  trigger.textContent = triggerText;
  const card = document.createElement("div");
  card.slot = "content";
  card.textContent = content;
  tooltip.append(trigger, card);
  return { tooltip, trigger, card };
}

export function createProvider() {
  return document.createElement("openclaw-tooltip-provider");
}

export function focusTrigger(trigger: HTMLElement) {
  trigger.dispatchEvent(new FocusEvent("focusin", { bubbles: true, composed: true }));
}

export function dispatchMousePointer(
  target: EventTarget,
  type: "pointerenter" | "pointerleave" | "pointerover" | "pointerdown",
) {
  const event = new MouseEvent(type, { bubbles: true, composed: true, buttons: 0 });
  Object.defineProperty(event, "pointerType", { value: "mouse" });
  target.dispatchEvent(event);
}

export function dispatchTouchPointer(target: EventTarget, type: "pointerdown" | "pointerup") {
  const event = new MouseEvent(type, { bubbles: true });
  Object.defineProperty(event, "pointerType", { value: "touch" });
  target.dispatchEvent(event);
}

export function hoverTrigger(trigger: HTMLElement) {
  dispatchMousePointer(trigger, "pointerenter");
}

export function tooltipSurface(tooltip: TooltipElement) {
  return tooltip.shadowRoot?.querySelector<HTMLElement>(".tooltip-surface") ?? null;
}

export async function expectOpenCount(count: number) {
  await Promise.all(
    [...document.querySelectorAll<TooltipElement>("openclaw-tooltip")].map(settleTooltip),
  );
  expect(
    [...document.querySelectorAll<TooltipElement>("openclaw-tooltip")].filter((tooltip) =>
      tooltipSurface(tooltip)?.matches(":popover-open"),
    ),
  ).toHaveLength(count);
}

export async function settleTooltip(tooltip: TooltipElement) {
  await tooltip.updateComplete;
  await Promise.resolve();
  flush();
}

export function expectSharedTooltipSkin(tooltip: TooltipElement) {
  const root = tooltip.shadowRoot!;
  const styles = [
    ...[...root.querySelectorAll("style")].map((style) => style.textContent),
    ...[...(root.adoptedStyleSheets ?? [])].flatMap((sheet) =>
      [...sheet.cssRules].map((rule) => rule.cssText),
    ),
  ].join("\n");
  expect(styles).toContain("--openclaw-tooltip-background-color");
  expect(styles).toContain("--openclaw-tooltip-border-color");
  expect(styles).toContain("border: 1px solid");
  expect(styles).toContain(".tooltip-surface");
  expect(styles).not.toContain("::part(");
  expect(styles).toContain("var(--overlay-border, var(--border-strong))");
  expect(styles).toContain("var(--overlay-shadow, var(--shadow-md))");
  expect(styles).toContain("@media (prefers-reduced-motion: reduce)");
  if (root.adoptedStyleSheets?.length) {
    const animationNames = root.adoptedStyleSheets
      .flatMap((sheet) => Array.from(sheet.cssRules))
      .filter(
        (rule): rule is CSSMediaRule =>
          rule instanceof CSSMediaRule && rule.conditionText === "(prefers-reduced-motion: reduce)",
      )
      .flatMap((rule) => Array.from(rule.cssRules))
      .filter((rule): rule is CSSStyleRule => rule instanceof CSSStyleRule)
      .map((rule) => rule.style.animationName);
    // WebKit serializes the `animation: none` shorthand as `animation: auto`.
    expect(animationNames).toContain("none");
  } else {
    expect(styles).toContain("animation: none");
  }
}
