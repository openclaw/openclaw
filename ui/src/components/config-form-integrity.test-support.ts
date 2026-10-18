import { expect } from "vitest";
import type { JsonSchema } from "./config-form.shared.ts";

export function expectElement<T extends Element>(element: T | null | undefined, label: string): T {
  expect(element instanceof Element, label).toBe(true);
  if (!(element instanceof Element)) {
    throw new Error(`missing ${label}`);
  }
  return element;
}

export function query<T extends Element = HTMLElement>(parent: ParentNode, selector: string): T {
  return expectElement(parent.querySelector<T>(selector), selector);
}

export function edit(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

export function objectSchema(properties: Record<string, JsonSchema>): JsonSchema {
  return { type: "object", properties };
}
