import fs from "node:fs";
import { expect, it, vi } from "vitest";
import {
  CommandProcessCleanupError,
  hasCommandProcessCleanupError,
} from "../process/exec-result.js";
import { createUpdateErrorFact } from "./update-failure-facts.js";
import { createGitAdmissionFixture } from "./update-runner-git-admission.test-support.js";

it.each(["none", "start", "complete"] as const)(
  "retains post-stop failure and cleans candidate when reporting fails: %s",
  async (reportingFails) => {
    const fixture = createGitAdmissionFixture();
    const before = fixture.git(fixture.install, "rev-parse", "HEAD");
    const original = new Error("SYNTHETIC_POST_STOP_FAILURE");
    const reporting = new Error(
      'Could not record update step "preflight-cleanup": undergoing offline maintenance',
    );
    let validated = false;
    let stopped = false;
    const doctor = vi.fn();
    let error: unknown;
    try {
      await fixture.run({
        validateCandidate: async () => {
          validated = true;
        },
        beforeGitMutation: async () => {
          expect(validated).toBe(true);
          stopped = true;
          throw original;
        },
        runGitDoctor: doctor,
        progress: {
          onStepStart: ({ name }) => {
            if (reportingFails === "start" && name === "preflight-cleanup") {
              throw reporting;
            }
          },
          onStepComplete: ({ name }) => {
            if (reportingFails === "complete" && name === "preflight-cleanup") {
              throw reporting;
            }
          },
        },
      });
    } catch (caught) {
      error = caught;
    }
    expect(stopped).toBe(true);
    expect(fixture.git(fixture.install, "rev-parse", "HEAD")).toBe(before);
    expect(doctor).not.toHaveBeenCalled();
    expect(
      fixture.calls.filter((args) => args.includes("worktree") && args.includes("remove")),
    ).toHaveLength(1);
    if (reportingFails !== "none") {
      expect(error).toMatchObject({ cause: original, errors: [original, reporting] });
      const fact = createUpdateErrorFact("update", error);
      expect(fact.message).toContain("SYNTHETIC_POST_STOP_FAILURE");
      expect(fact.message).toContain("offline maintenance");
    } else {
      expect(error).toBe(original);
    }
    const removed = fixture.calls
      .find((args) => args.includes("worktree") && args.includes("remove"))
      ?.at(-1);
    expect(removed).toBeDefined();
    expect(fs.existsSync(removed!)).toBe(false);
  },
);

it("keeps a successful update successful when cleanup reporting is unavailable", async () => {
  const fixture = createGitAdmissionFixture();
  const result = await fixture.run({
    progress: {
      onStepStart: ({ name }) => {
        if (name === "preflight-cleanup") {
          throw new Error("offline maintenance");
        }
      },
      onStepComplete: ({ name }) => {
        if (name === "preflight-cleanup") {
          throw new Error("completion reporting unavailable");
        }
      },
    },
  });
  expect(result.status).toBe("ok");
  expect(fixture.git(fixture.install, "rev-parse", "HEAD")).toBe(fixture.target);
  expect(result.steps).toContainEqual(
    expect.objectContaining({
      name: "preflight-cleanup-reporting",
      exitCode: 0,
      advisory: expect.objectContaining({ kind: "recoverable-maintenance" }),
      failureFacts: [
        expect.objectContaining({ message: "offline maintenance" }),
        expect.objectContaining({ message: "completion reporting unavailable" }),
      ],
    }),
  );
});

it("preserves uncertain process cleanup and the original failure without removing live scratch", async () => {
  const fixture = createGitAdmissionFixture();
  const original = new Error("SYNTHETIC_POST_STOP_FAILURE");
  const uncertain = new CommandProcessCleanupError();
  const error = await fixture
    .run({
      beforeGitMutation: async () => {
        throw original;
      },
      progress: {
        onStepStart: ({ name }) => {
          if (name === "preflight-cleanup") {
            throw uncertain;
          }
        },
      },
    })
    .catch((caught: unknown) => caught);
  expect(error).toMatchObject({ cause: original, errors: [original, uncertain] });
  expect(hasCommandProcessCleanupError(error)).toBe(true);
  expect(fixture.calls.some((args) => args.includes("worktree") && args.includes("remove"))).toBe(
    false,
  );
});
