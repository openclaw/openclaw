import fs from "node:fs";
import { expect, it, vi } from "vitest";
import {
  CommandProcessCleanupError,
  hasCommandProcessCleanupError,
} from "../process/exec-result.js";
import { createUpdateErrorFact } from "./update-failure-facts.js";
import { createGitAdmissionFixture } from "./update-runner-git-admission.test-support.js";

function cleanupReporting(start?: Error, complete?: Error) {
  const report =
    (error?: Error) =>
    ({ name }: { name: string }) => {
      if (name === "preflight-cleanup" && error) {
        throw error;
      }
    };
  return { onStepStart: report(start), onStepComplete: report(complete) };
}
const removals = (fixture: ReturnType<typeof createGitAdmissionFixture>) =>
  fixture.calls.filter((args) => args.includes("worktree") && args.includes("remove"));

it.each(["none", "start", "complete", "uncertain"] as const)(
  "retains post-stop failure with %s cleanup reporting",
  async (reportingFails) => {
    const fixture = createGitAdmissionFixture();
    const before = fixture.git(fixture.install, "rev-parse", "HEAD");
    const original = new Error("SYNTHETIC_POST_STOP_FAILURE");
    const reporting =
      reportingFails === "uncertain"
        ? new CommandProcessCleanupError()
        : new Error(
            'Could not record update step "preflight-cleanup": undergoing offline maintenance',
          );
    let validated = false;
    const doctor = vi.fn();
    const error = await fixture
      .run({
        validateCandidate: async () => {
          validated = true;
        },
        beforeGitMutation: async () => {
          expect(validated).toBe(true);
          throw original;
        },
        runGitDoctor: doctor,
        progress: cleanupReporting(
          reportingFails === "start" || reportingFails === "uncertain" ? reporting : undefined,
          reportingFails === "complete" ? reporting : undefined,
        ),
      })
      .catch((caught: unknown) => caught);
    expect(fixture.git(fixture.install, "rev-parse", "HEAD")).toBe(before);
    expect(doctor).not.toHaveBeenCalled();
    if (reportingFails === "uncertain") {
      expect(error).toMatchObject({ cause: original, errors: [original, reporting] });
      expect(hasCommandProcessCleanupError(error)).toBe(true);
      expect(removals(fixture)).toEqual([]);
      return;
    }
    expect(removals(fixture)).toHaveLength(1);
    if (reportingFails !== "none") {
      expect(error).toMatchObject({ cause: original, errors: [original, reporting] });
      const fact = createUpdateErrorFact("update", error);
      expect(fact.message).toContain("SYNTHETIC_POST_STOP_FAILURE");
      expect(fact.message).toContain("offline maintenance");
    } else {
      expect(error).toBe(original);
    }
    const removed = removals(fixture)[0]?.at(-1);
    expect(removed).toBeDefined();
    expect(fs.existsSync(removed!)).toBe(false);
  },
);

it("keeps a successful update successful when cleanup reporting is unavailable", async () => {
  const fixture = createGitAdmissionFixture();
  const result = await fixture.run({
    progress: cleanupReporting(
      new Error("offline maintenance"),
      new Error("completion reporting unavailable"),
    ),
  });
  expect(result.status).toBe("ok");
  expect(fixture.git(fixture.install, "rev-parse", "HEAD")).toBe(fixture.target);
  expect(result.steps.find(({ name }) => name === "preflight-cleanup-reporting")).toMatchObject({
    exitCode: 0,
    advisory: { kind: "recoverable-maintenance" },
    failureFacts: [
      { message: "offline maintenance" },
      { message: "completion reporting unavailable" },
    ],
  });
});
