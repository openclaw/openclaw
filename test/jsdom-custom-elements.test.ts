/* @vitest-environment jsdom */
import { customElement } from "lit/decorators.js";
import { describe, expect, it, vi } from "vitest";
import {
  dropRepoOwnedCustomElements,
  isRepoOwnedDefineStack,
  jsdomCustomElementDefinitions,
  trackCustomElementRegistry,
} from "./jsdom-custom-elements.ts";

describe("jsdom custom element tracking", () => {
  it("reaches the live jsdom definition list", () => {
    // Contract with jsdom internals: losing this silently restores the stale-class
    // flake, because the shared runner would stop dropping repo-owned tags.
    const definitions = jsdomCustomElementDefinitions(customElements);
    expect(Array.isArray(definitions)).toBe(true);
    customElements.define("openclaw-jsdom-contract-probe", class extends HTMLElement {});
    expect(definitions?.some((entry) => entry.name === "openclaw-jsdom-contract-probe")).toBe(true);
  });

  it.each(["direct", "spy", "forwarding-spy"] as const)(
    "drops repo-owned tags and keeps dependency-owned ones (%s define)",
    (wrapper) => {
      const tracking = trackCustomElementRegistry(customElements);
      if (!tracking) {
        throw new Error("expected a jsdom registry");
      }
      const tag = `openclaw-repo-owned-probe-${wrapper}`;
      const dependencyTag = `wa-dependency-probe-${crypto.randomUUID()}`;
      const define = customElements.define.bind(customElements);
      const registration = wrapper === "direct" ? undefined : vi.spyOn(customElements, "define");
      if (wrapper === "forwarding-spy") {
        // Fixtures that cold-import modules tolerate re-registration this way.
        registration?.mockImplementation((name, constructor, options) => {
          if (!customElements.get(name)) {
            define(name, constructor, options);
          }
        });
      }
      try {
        customElements.define(tag, class extends HTMLElement {});
        // Dependency packages are externalized and register once per worker, so their
        // definitions must survive a reset that the module graph cannot replay.
        customElement(dependencyTag)(class extends HTMLElement {});
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

  it.each(["", "    at Mock (/repo/node_modules/vitest/dist/chunks/spy.DQ0ZsPbi.js:320:40)\n"])(
    "attributes a define call to its owner behind %j",
    (forwarder) => {
      const stack = (caller: string) =>
        `Error\n    at define (/repo/test/jsdom-custom-elements.ts:58:9)\n${forwarder}${caller}`;

      expect(
        isRepoOwnedDefineStack(stack("    at /repo/ui/src/components/tooltip.ts:576:18")),
      ).toBe(true);
      expect(
        isRepoOwnedDefineStack(
          stack(
            "    at file:///repo/node_modules/@lit/reactive-element/decorators/custom-element.js:27:24",
          ),
        ),
      ).toBe(false);
      expect(isRepoOwnedDefineStack(undefined)).toBe(false);
    },
  );
});
