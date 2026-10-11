import path from "node:path";
import { expect, it } from "vitest";
import { listGitTrackedFiles } from "../src/test-utils/repo-files.js";
import { findSourceImportBackedges } from "./helpers/source-import-closure.js";
import { uiNodeDrivenBrowserTestFiles } from "./vitest/vitest.ui-paths.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");

it("keeps Control UI runtime imports off the state database", () => {
  const files = listGitTrackedFiles({ repoRoot, pathspecs: ["ui/src", "src/state"] });
  if (!files) {
    throw new Error("Cannot list Control UI import boundary sources");
  }
  // Node/E2E harnesses may exercise real Gateway owners outside the browser.
  const entries = files.filter(
    (file) =>
      file.startsWith("ui/src/") &&
      /\.tsx?$/.test(file) &&
      !file.startsWith("ui/src/e2e/") &&
      !/\.e2e\.test\.tsx?$/.test(file) &&
      !/\.node\.test\.tsx?$/.test(file) &&
      !uiNodeDrivenBrowserTestFiles.includes(file),
  );
  const forbidden = files.filter((file) =>
    /^src\/state\/openclaw-state-(?:db.*|schema)\.ts$/u.test(file),
  );

  expect(entries.length).toBeGreaterThan(0);
  expect(forbidden.length).toBeGreaterThan(0);
  expect(findSourceImportBackedges(entries, forbidden)).toEqual([]);
});
