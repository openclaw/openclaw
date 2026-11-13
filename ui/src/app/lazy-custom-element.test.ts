/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import { ensureCustomElementDefined } from "./lazy-custom-element.ts";

let tagSequence = 0;

const uniqueTag = () => `openclaw-lazy-test-${++tagSequence}`;

function definedElement() {
  const tagName = uniqueTag();
  return {
    tagName,
    loadModule: vi.fn(async () => {
      customElements.define(tagName, class extends HTMLElement {});
    }),
  };
}

describe("ensureCustomElementDefined", () => {
  it("deduplicates concurrent module loads", async () => {
    const { tagName, loadModule } = definedElement();

    await Promise.all([
      ensureCustomElementDefined(tagName, loadModule),
      ensureCustomElementDefined(tagName, loadModule),
    ]);

    expect(loadModule).toHaveBeenCalledOnce();
    expect(customElements.get(tagName)).toBeDefined();
  });

  it("rejects modules that do not register their declared element", async () => {
    const tagName = uniqueTag();

    await expect(ensureCustomElementDefined(tagName, async () => undefined)).rejects.toThrow(
      `Custom element module did not define ${tagName}`,
    );
  });
});
