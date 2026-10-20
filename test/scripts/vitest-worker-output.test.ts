import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createVitestWorkerOutput } from "../../scripts/lib/vitest-worker-output.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const roots = useAutoCleanupTempDirTracker(afterEach);

it("writes only changed outputs and removes retired chunks from a private generation", () => {
  const directory = roots.make("vitest-worker-output-");
  const first = createVitestWorkerOutput(directory);
  first.write("unchanged.js", "export const value = 1;\n");
  first.write("changed.js", "export const value = 1;\n");
  first.write("retired.js", "export {};\n");
  first.finish();
  const unchanged = path.join(directory, "dist/unchanged.js");
  fs.utimesSync(unchanged, new Date(1000), new Date(1000));

  const next = createVitestWorkerOutput(directory, first.outputs);
  next.write("unchanged.js", "export const value = 1;\n");
  next.write("changed.js", "export const value = 2;\n");
  next.write("added.js", "export const added = true;\n");
  next.finish();

  expect(fs.statSync(unchanged).mtimeMs).toBe(1000);
  expect(fs.readFileSync(path.join(directory, "dist/changed.js"), "utf8")).toBe(
    "export const value = 2;\n",
  );
  expect(fs.readFileSync(path.join(directory, "dist/added.js"), "utf8")).toBe(
    "export const added = true;\n",
  );
  expect(fs.existsSync(path.join(directory, "dist/retired.js"))).toBe(false);
});
