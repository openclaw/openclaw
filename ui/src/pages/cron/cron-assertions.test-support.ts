import { expect } from "vitest";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";

export function text(root: ParentNode, selector: string) {
  return root.querySelector(selector)?.textContent;
}

export function attribute(root: ParentNode, selector: string, name: string) {
  return root.querySelector(selector)?.getAttribute(name);
}

export function inputValue(root: ParentNode, selector: string) {
  return root.querySelector<HTMLInputElement>(selector)?.value;
}

export function testId(id: string) {
  return `[data-test-id="${id}"]`;
}

export function click(root: ParentNode, selector: string) {
  root.querySelector<HTMLElement>(selector)!.click();
}

export function fillInput(root: ParentNode, selector: string, value: string) {
  const element = root.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
  element.value = value;
  element.dispatchEvent(new Event("input", { bubbles: true }));
  return element;
}

export async function waitForElement<T extends HTMLElement = HTMLElement>(
  root: ParentNode,
  selector: string,
) {
  await waitForSolid(() => expect(root.querySelector(selector)).not.toBeNull());
  return root.querySelector<T>(selector)!;
}

type RecordedRequest = { mock: { calls: readonly (readonly unknown[])[] } };

export function callsFor(request: RecordedRequest, method: string) {
  return request.mock.calls.filter(([called]) => called === method);
}

export function expectCalls(request: RecordedRequest, methods: readonly string[], count: number) {
  for (const method of methods) {
    expect(callsFor(request, method), method).toHaveLength(count);
  }
}
