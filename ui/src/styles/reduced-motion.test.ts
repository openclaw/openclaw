// @vitest-environment node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));

function readReducedMotionWildcardBody(css: string): string {
  const mediaIndex = css.lastIndexOf("@media (prefers-reduced-motion: reduce)");
  if (mediaIndex === -1) {
    throw new Error("missing reduced-motion media block in base.css");
  }
  const afterMedia = css.slice(mediaIndex);
  const match = afterMedia.match(/\*,\s*\*::before,\s*\*::after\s*\{([^}]*)\}/u);
  const body = match?.[1];
  if (!body) {
    throw new Error("missing reduced-motion wildcard rule in base.css");
  }
  return body;
}

describe("Control UI reduced motion", () => {
  const baseCss = readFileSync(path.join(here, "base.css"), "utf8");

  it("disarms transitions instead of shortening them (closes #150664)", () => {
    const wildcardBody = readReducedMotionWildcardBody(baseCss);

    // transition-duration alone keeps transition-property: all armed, so every
    // inherited property change (e.g. scrollbar-color on 1,000+ nodes) restarts
    // a transition. transition-property: none stops the storm at the source.
    expect(wildcardBody).toMatch(/transition-property:\s*none\s*!important/);
    expect(wildcardBody).toMatch(/transition-duration:\s*0\.01ms\s*!important/);
  });
});
