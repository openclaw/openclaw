import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  isPrExemptRuntimeTestFile,
  listPrExemptRuntimeTestFiles,
} from "../../scripts/lib/ci-proof-test-inventory.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("enumerates live audited files in the selected checkout without exempting renamed tests", () => {
  const cwd = tempDirs.make("pr-exempt-inventory-");
  const file = "extensions/acpx/src/runtime-mcp.process.test.ts";
  const renamed = "extensions/acpx/src/renamed-runtime-mcp.process.test.ts";
  const directory = "extensions/acpx/src/runtime-owner.process.test.ts";
  mkdirSync(dirname(join(cwd, file)), { recursive: true });
  mkdirSync(join(cwd, directory));

  expect(listPrExemptRuntimeTestFiles(cwd)).toEqual([]);
  writeFileSync(join(cwd, file), "");
  expect(listPrExemptRuntimeTestFiles(cwd)).toEqual([file]);

  renameSync(join(cwd, file), join(cwd, renamed));
  expect(listPrExemptRuntimeTestFiles(cwd)).toEqual([]);
  expect(isPrExemptRuntimeTestFile(renamed)).toBe(false);

  renameSync(join(cwd, renamed), join(cwd, file));
  expect(listPrExemptRuntimeTestFiles(cwd)).toEqual([file]);
});
