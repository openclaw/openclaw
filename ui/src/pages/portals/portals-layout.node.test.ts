// @vitest-environment node
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";

it("grows the portals layout to the viewport instead of capping its height", () => {
  const styles = readFileSync(path.resolve(import.meta.dirname, "portals.css"), "utf8");
  const layoutRule = styles.match(/\.portals-layout\s*\{[^}]*\}/u);
  expect(layoutRule).toBeTruthy();
  // A capped min() keeps tall viewports empty below the frame; the layout must
  // track the available viewport height for every window size.
  expect(layoutRule?.[0]).not.toMatch(/min-height:\s*min\(/u);
  expect(layoutRule?.[0]).toMatch(/min-height:\s*calc\(100vh - 190px\)/u);
});
