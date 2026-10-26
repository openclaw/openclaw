/* @vitest-environment jsdom */

import { createRoot } from "solid-js";
import { expect, it } from "vitest";
import { connectedElementRef, elementRef } from "./element-ref.ts";

it("retires replaced ref registrations and releases the last one before first settlement", () => {
  const elements = new Set<HTMLElement>();
  const first = document.createElement("button");
  const replacement = document.createElement("button");
  createRoot((dispose) => {
    const ref = elementRef((element: HTMLElement) => {
      elements.add(element);
      return () => elements.delete(element);
    });
    ref(first);
    expect([...elements]).toEqual([first]);
    ref(replacement);
    expect([...elements]).toEqual([replacement]);
    dispose();
    expect([...elements]).toEqual([]);
  });
});

it("exposes only connected bindings and keeps a replacement when its predecessor retires", () => {
  const slot = connectedElementRef<HTMLButtonElement>();
  const first = document.createElement("button");
  const next = document.createElement("button");
  expect(slot.read()).toBeNull();
  const releaseFirst = slot.bind(first);
  expect(slot.read()).toBeNull();
  document.body.append(first, next);
  try {
    expect(slot.read()).toBe(first);
    const releaseNext = slot.bind(next);
    releaseFirst();
    expect(slot.read()).toBe(next);
    next.remove();
    expect(slot.read()).toBeNull();
    document.body.append(next);
    expect(slot.read()).toBe(next);
    releaseNext();
    releaseNext();
    expect(slot.read()).toBeNull();
  } finally {
    first.remove();
    next.remove();
  }
});
