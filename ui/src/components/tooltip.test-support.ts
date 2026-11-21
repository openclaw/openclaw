import { flush } from "solid-js";
import { expect } from "vitest";
import "./tooltip.ts";

export type TooltipElement = HTMLElementTagNameMap["openclaw-tooltip"];

export function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  ...children: Node[]
) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

export function createTooltip(content: string, triggerText = "trigger") {
  const trigger = element("button", { textContent: triggerText });
  return { tooltip: element("openclaw-tooltip", { content }, trigger), trigger };
}

export function createRichTooltip(content: string, triggerText = "trigger") {
  const { tooltip, trigger } = createTooltip("", triggerText);
  const card = element("div", { slot: "content", textContent: content });
  tooltip.append(card);
  return { tooltip, trigger, card };
}

export const createProvider = () => element("openclaw-tooltip-provider");

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

export const hoverTrigger = (trigger: HTMLElement) => dispatchMousePointer(trigger, "pointerenter");

export const tooltipSurface = (tooltip: TooltipElement) =>
  tooltip.shadowRoot?.querySelector<HTMLElement>(".tooltip-surface") ?? null;

export async function expectOpenCount(count: number) {
  const tooltips = () => [...document.querySelectorAll<TooltipElement>("openclaw-tooltip")];
  await Promise.all(tooltips().map(settleTooltip));
  expect(
    tooltips().filter((tooltip) => tooltipSurface(tooltip)?.matches(":popover-open")),
  ).toHaveLength(count);
}

export async function settleTooltip(tooltip: TooltipElement) {
  await tooltip.updateComplete;
  await Promise.resolve();
  flush();
}

export function expectSharedTooltipSkin(tooltip: TooltipElement) {
  const root = tooltip.shadowRoot!;
  const rules = (root.adoptedStyleSheets ?? []).flatMap((sheet) => Array.from(sheet.cssRules));
  const styles = [
    ...[...root.querySelectorAll("style")].map((style) => style.textContent),
    ...rules.map((rule) => rule.cssText),
  ].join("\n");
  expect(styles).toContain("--openclaw-tooltip-background-color");
  expect(styles).toContain("border: 1px solid");
  expect(styles).toContain(".tooltip-surface");
  expect(styles).not.toContain("::part(");
  expect(styles).toContain("@media (prefers-reduced-motion: reduce)");
  if (root.adoptedStyleSheets?.length) {
    const animationNames = rules.flatMap((rule) =>
      rule instanceof CSSMediaRule && rule.conditionText === "(prefers-reduced-motion: reduce)"
        ? [...rule.cssRules].flatMap((style) =>
            style instanceof CSSStyleRule ? [style.style.animationName] : [],
          )
        : [],
    );
    // WebKit serializes the `animation: none` shorthand as `animation: auto`.
    expect(animationNames).toContain("none");
  } else {
    expect(styles).toContain("animation: none");
  }
}
