import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { readWorkflow } from "./ci-workflow.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("workflow fixture reads", () => {
  it("keeps nested fixture mutations local to each read", () => {
    const file = path.join(tempDirs.make("openclaw-workflow-read-"), "action.yml");
    writeFileSync(file, "runs:\n  steps:\n    - run: original\n");
    const fixture = readWorkflow(file);
    fixture.runs.steps[0].run = "mutated";
    fixture.runs.steps.push({ run: "extra" });
    expect(readWorkflow(file)).toEqual({ runs: { steps: [{ run: "original" }] } });
  });

  it("observes changed source at a previously read path", () => {
    const file = path.join(tempDirs.make("openclaw-workflow-read-"), "action.yml");
    writeFileSync(file, "name: before\n");
    expect(readWorkflow(file)).toEqual({ name: "before" });
    writeFileSync(file, "name: after\n");
    expect(readWorkflow(file)).toEqual({ name: "after" });
  });
});
