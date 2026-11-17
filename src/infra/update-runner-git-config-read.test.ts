import fs from "node:fs/promises";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { isFailedUpdateStep } from "./update-run-step.js";
import {
  createGitUpdateFixture,
  runFixtureGit as git,
} from "./update-runner-git-candidate.test-support.js";

const directories = useAutoCleanupTempDirTracker(afterEach);

it("records an unset upstream config key as a completed read, not a failing check", async () => {
  const directory = await fs.realpath(directories.make("openclaw-git-config-read-"));
  const fixture = await createGitUpdateFixture(directory);
  await fixture.advanceRemote();
  await git(fixture.root, "checkout", "-b", "feature");
  await git(fixture.root, "config", "--unset", "branch.main.remote");

  const result = await fixture.update({
    runGitDoctor: async () => {
      throw new Error("Doctor must not run for an unmanaged checkout");
    },
  });

  expect(result).toMatchObject({ status: "skipped", reason: "no-upstream" });
  const reads = result.steps.filter((step) => step.name === "git-config-update-upstream");
  expect(reads.map((step) => step.command)).toContainEqual(
    expect.stringContaining("config --get branch.main.remote"),
  );
  expect(reads.filter(isFailedUpdateStep)).toEqual([]);
  expect(reads.flatMap((step) => step.failureFacts ?? [])).toEqual([]);
  expect(fixture.events).toEqual([]);
});
