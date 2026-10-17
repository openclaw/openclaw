import { afterEach, beforeEach, expect, vi } from "vitest";
import { TEST_LINK_READER } from "../test-helpers/link-reader.ts";
import type { LinkReaderHovercardProvider } from "./link-reader-hovercard.ts";
import type { HovercardProperties } from "./link-reader-hovercard.types.ts";

export const hovercard = () => document.querySelector<HTMLElement>(".link-reader-hovercard");
export const cardPart = <T extends Element = HTMLElement>(name: string, root = hovercard()) =>
  root?.querySelector<T>(`.link-reader-hovercard__${name}`);
export const text = (root: ParentNode, selector: string) =>
  root.querySelector(selector)?.textContent;
export function expectIncludes(root: Node | null | undefined, ...values: string[]) {
  for (const value of values) {
    expect(root?.textContent).toContain(value);
  }
}
export function expectAttributes(node: Element, attributes: Record<string, string | null>) {
  for (const [name, value] of Object.entries(attributes)) {
    expect(node.getAttribute(name), name).toBe(value);
  }
}
export function expectPreview(request: unknown, calls: number, ...includes: string[]) {
  expect(request).toHaveBeenCalledTimes(calls);
  expectIncludes(hovercard(), ...includes);
}
export function pointer(target: Element, type: string, relatedTarget?: EventTarget) {
  return target.dispatchEvent(
    new MouseEvent(type, { bubbles: true, composed: true, relatedTarget }),
  );
}
export function key(target: Element, value: string, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { bubbles: true, key: value, ...options });
  target.dispatchEvent(event);
  return event;
}
export async function hover(anchor: HTMLAnchorElement) {
  await Promise.resolve(); // Let the bridge mount before dispatching intent.
  pointer(anchor, "pointerover");
  await vi.advanceTimersByTimeAsync(250);
}
export function leave(
  anchor: HTMLAnchorElement,
  relatedTarget: EventTarget | null = document.body,
  composed = true,
) {
  anchor.dispatchEvent(new MouseEvent("pointerout", { bubbles: true, composed, relatedTarget }));
}
export async function leaveAndWait(...args: Parameters<typeof leave>) {
  leave(...args);
  await vi.advanceTimersByTimeAsync(120);
}
export function hovercardTestClock(fixed = true) {
  beforeEach(() => {
    vi.useFakeTimers();
    if (fixed) {
      vi.setSystemTime(new Date("2026-07-05T10:00:00Z"));
    }
  });
  afterEach(async () => {
    document.body.replaceChildren();
    await Promise.resolve();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
}
export function createLinkFixture(
  tag: string,
  href: string,
  properties: Partial<HovercardProperties> = {},
  textContent = "Item",
) {
  const provider = document.createElement(tag) as LinkReaderHovercardProvider;
  Object.assign(provider, { readers: [TEST_LINK_READER] }, properties);
  const anchor = Object.assign(document.createElement("a"), { href, textContent });
  provider.append(anchor);
  document.body.append(provider);
  return { provider, anchor };
}
