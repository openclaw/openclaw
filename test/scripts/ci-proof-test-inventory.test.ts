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

it("defers unmapped Control UI E2E files while preserving existing inventory classifications", () => {
  const cwd = tempDirs.make("ui-pr-exempt-inventory-");
  const file = "ui/src/e2e/new-route-flow.e2e.test.ts";
  mkdirSync(dirname(join(cwd, file)), { recursive: true });
  writeFileSync(join(cwd, file), "");

  expect(isPrExemptRuntimeTestFile(file)).toBe(true);
  expect(listPrExemptRuntimeTestFiles(cwd)).toEqual([file]);
  // The UI selector retains this smoke file independently of its older exemption.
  expect(isPrExemptRuntimeTestFile("ui/src/e2e/control-ui-route-readiness.e2e.test.ts")).toBe(true);
  expect(
    isPrExemptRuntimeTestFile("ui/src/e2e/activity-run-inspector.real-gateway.e2e.test.ts"),
  ).toBe(false);
});
