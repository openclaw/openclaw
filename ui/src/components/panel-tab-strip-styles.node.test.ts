// @vitest-environment node
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";

it("keeps the new-tab control from shrinking when the strip overflows", () => {
  const styles = readFileSync(path.resolve(import.meta.dirname, "panel-tab-strip.css"), "utf8");
  expect(styles).toMatch(/\.tabstrip-new\s*\{[^}]*flex:\s*none/u);
});
