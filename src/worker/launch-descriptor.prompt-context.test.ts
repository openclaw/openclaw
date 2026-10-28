import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { testWorkerDescriptor } from "../node-host/node-worker-supervisor.test-support.js";
import { parseWorkerLaunchPlan } from "./launch-descriptor.js";
import { parseWorkerLaunchPlan as parseLegacyPlan } from "./launch-descriptor.pre-prompt-context.test-support.js";

// Exact pre-change parser from c828f7ed1d560295f78166a98fb54687dc162b28.
// This exercises historical parsing with current test dependencies, not an old node binary.
it("pins the real pre-prompt-context parser fixture", () => {
  const source = readFileSync(
    new URL("./launch-descriptor.pre-prompt-context.test-support.ts", import.meta.url),
  );
  expect(
    createHash("sha1").update(`blob ${source.byteLength}\0`).update(source).digest("hex"),
  ).toBe("680d91c1650988fadebec7f3cb9d85af07dd57ce");
});

it.each([
  { runtimeContext: [] },
  { inHistorySystemUpdates: false },
  { includeEmptySnapshots: false },
])("requires negotiated prompt context for new v4 assignment fields: %j", (context) => {
  const baseline = testWorkerDescriptor("/tmp/worker-workspace");
  expect(parseLegacyPlan(baseline)).toEqual(baseline);
  const candidate = {
    ...baseline,
    assignment: { ...baseline.assignment, ...context },
  };
  expect(parseWorkerLaunchPlan(candidate)).toEqual(candidate);
  expect(() => parseLegacyPlan(candidate)).toThrow("invalid worker launch descriptor");
});
