import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  createChangedNodeTestShards,
  selectedFiles,
} from "./ci-changed-node-test-plan.test-support.js";

const argvTempDirs = useAutoCleanupTempDirTracker(afterEach);

// Real-repository hub checks share the main planner suite's import graph.
describe("CI changed Node test plan", () => {
  it("protects caught and deferred owner contracts without widening a direct test edit", () => {
    const cwd = argvTempDirs.make("changed-protected-owner-contracts-");
    const source = "src/cli/fixture-command.ts";
    const sibling = "src/cli/fixture-command.test.ts";
    const caught = "src/cli/update-cli.test.ts";
    const deferred = "src/cli/claws-cli-legacy-resume.test.ts";
    const unrelated = "src/other/unprotected.test.ts";
    writeFileSync(path.join(cwd, "package.json"), "{}\n");
    for (const file of [source, sibling, caught, deferred, unrelated]) {
      mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
      writeFileSync(path.join(cwd, file), "export {};\n");
    }
    const options = {
      cwd,
      includePrExemptRuntimeTests: false,
      includeReleaseOnlyRuntimeTests: false,
    };
    const owner = createChangedNodeTestShards([source], options);
    expect(owner).not.toBeNull();
    expect(selectedFiles(owner).toSorted()).toEqual([sibling, caught, deferred].toSorted());
    const global = createChangedNodeTestShards(["package.json"], options);
    expect(global).not.toBeNull();
    expect(selectedFiles(global)).toEqual([caught]);
    for (const target of [sibling, caught, deferred]) {
      const leaf = createChangedNodeTestShards([target], options);
      expect(leaf, target).not.toBeNull();
      expect(selectedFiles(leaf), target).toEqual([target]);
    }
  });
});
