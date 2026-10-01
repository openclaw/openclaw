import { expect } from "vitest";
import { ensureCustomElementDefined } from "../app/lazy-custom-element.ts";
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

export function webAwesomeTooltip(tooltip: TooltipElement) {
  return tooltip.shadowRoot?.querySelector<HTMLElementTagNameMap["wa-tooltip"]>("wa-tooltip");
}

export async function expectOpenCount(count: number) {
  await Promise.all(
    [...document.querySelectorAll<TooltipElement>("openclaw-tooltip")].map(settleTooltip),
  );
  const open = [...document.querySelectorAll<TooltipElement>("openclaw-tooltip")].filter(
    (tooltip) => webAwesomeTooltip(tooltip)?.open,
  );
  expect(open).toHaveLength(count);
}

export async function settleTooltip(tooltip: TooltipElement) {
  await tooltip.updateComplete;
  if (!webAwesomeTooltip(tooltip)) {
    return;
  }
  await ensureCustomElementDefined(
    "wa-tooltip",
    () => import("@awesome.me/webawesome/dist/components/tooltip/tooltip.js"),
  );
  await tooltip.updateComplete;
  await webAwesomeTooltip(tooltip)?.updateComplete;
}
