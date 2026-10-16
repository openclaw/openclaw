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

export async function waitForElement(root: ParentNode, selector: string) {
  await waitForSolid(() => expect(root.querySelector(selector)).not.toBeNull());
  return root.querySelector<HTMLElement>(selector)!;
}

type RecordedRequest = { mock: { calls: readonly (readonly unknown[])[] } };

export function expectCalls(request: RecordedRequest, methods: readonly string[], count: number) {
  for (const method of methods) {
    expect(
      request.mock.calls.filter(([called]) => called === method),
      method,
    ).toHaveLength(count);
  }
}
