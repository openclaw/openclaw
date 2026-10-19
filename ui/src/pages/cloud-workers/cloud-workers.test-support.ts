import { expectDefined } from "@openclaw/normalization-core/expect";
import { flush } from "solid-js";
import { afterEach, expect } from "vitest";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  button,
  mountPage,
  setupSnapshotsDomSuite,
} from "./cloud-worker-snapshots-dom.test-support.ts";

export function setupSnapshotTests() {
  const disposers: Array<() => void> = [];
  afterEach(() => {
    for (const dispose of disposers.splice(0).toReversed()) {
      dispose();
    }
  });
  setupSnapshotsDomSuite();
  return (...args: Parameters<typeof mountPage>) => {
    const fixture = mountPage(...args);
    disposers.push(fixture.dispose);
    return fixture;
  };
}

export function sheet(page: Element) {
  return expectDefined(page.querySelector(".cloud-environments__sheet"), "Environment sheet");
}

export function field<T extends Element>(page: Element, selector: string) {
  return expectDefined(page.querySelector<T>(selector), selector);
}

export function change(
  element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
  value: string,
) {
  element.value = value;
  element.dispatchEvent(
    new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }),
  );
  flush();
}

export function click(page: Element, label: string) {
  button(page, label).click();
  flush();
}

export function configSnapshot(config: Record<string, unknown>, hash: string) {
  return {
    config,
    sourceConfig: config,
    raw: JSON.stringify(config),
    hash,
    appliedConfigHash: hash,
    valid: true,
    issues: [],
  };
}

export async function configPatch(request: ReturnType<typeof mountPage>["request"]) {
  await waitForSolid(() =>
    expect(request.mock.calls.some(([method]) => method === "config.patch")).toBe(true),
  );
  return expectDefined(
    request.mock.calls.find(([method]) => method === "config.patch"),
    "Config patch request",
  )[1];
}

export function waitText(element: () => Element, text: string) {
  return waitForSolid(() => expect(element().textContent).toContain(text));
}

export function waitRequest(
  request: ReturnType<typeof mountPage>["request"],
  method: string,
  params: Record<string, unknown>,
) {
  return waitForSolid(() => expect(request).toHaveBeenCalledWith(method, params));
}
