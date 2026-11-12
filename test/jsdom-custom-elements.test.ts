/* @vitest-environment jsdom */
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { JSDOM } from "jsdom";
import { expect, it, vi } from "vitest";
import { isRepoOwnedRegistrationStack } from "./jsdom-compat.mts";
import {
  dropRepoOwnedCustomElements,
  trackCustomElementRegistry,
} from "./jsdom-custom-elements.ts";

it("reports a rejected registration without hiding the native failure", () => {
  const { window } = new JSDOM();
  const registry = window.customElements;
  trackCustomElementRegistry(registry);
  const report = vi.spyOn(console, "error").mockImplementation(() => {});
  const tag = "openclaw-duplicate-registration-probe";
  try {
    registry.define(tag, class extends window.HTMLElement {});
    expect(report).not.toHaveBeenCalled();
    expect(() => registry.define(tag, class extends window.HTMLElement {})).toThrow(
      "This name has already been registered in the registry.",
    );
    expect(report).toHaveBeenCalledExactlyOnceWith(
      "[jsdom-custom-elements:registration-failed]",
      expect.objectContaining({ tag, alreadyDefined: true, trackedForCleanup: true }),
    );
  } finally {
    report.mockRestore();
    window.close();
  }
});

it.each(["direct", "spy", "forwarding-spy"] as const)(
  "drops repo-owned tags and keeps dependency-owned ones (%s define)",
  (wrapper) => {
    const tracking = trackCustomElementRegistry(customElements);
    assert(tracking, "expected a jsdom registry");
    const tag = `openclaw-repo-owned-probe-${wrapper}`;
    const dependencyTag = `dependency-probe-${crypto.randomUUID()}`;
    const define = customElements.define.bind(customElements);
    const registration = wrapper === "direct" ? undefined : vi.spyOn(customElements, "define");
    if (wrapper === "forwarding-spy") {
      registration?.mockImplementation((name, constructor, options) => {
        if (!customElements.get(name)) {
          define(name, constructor, options);
        }
      });
    }
    try {
      customElements.define(tag, class extends HTMLElement {});
      // Externalized dependencies cannot replay registration after a module reset.
      runInNewContext(
        "registry.define(name, class extends base {})",
        { registry: customElements, name: dependencyTag, base: HTMLElement },
        { filename: "/repo/node_modules/custom-element-fixture/index.js" },
      );
    } finally {
      registration?.mockRestore();
    }

    dropRepoOwnedCustomElements(tracking);

    expect(customElements.get(tag)).toBeUndefined();
    expect(customElements.get(dependencyTag)).toBeDefined();
    // A repo module re-evaluated by the next file must be able to register again.
    expect(() => customElements.define(tag, class extends HTMLElement {})).not.toThrow();
  },
);

it("keeps registrations whose ownership cannot be read", () => {
  expect(isRepoOwnedRegistrationStack(undefined)).toBe(false);
});
