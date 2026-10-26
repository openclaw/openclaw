import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  CommandProcessCleanupError,
  hasCommandProcessCleanupError,
} from "../process/exec-result.js";
import { createUpdateErrorFact } from "./update-failure-facts.js";
import { isFailedUpdateStep } from "./update-run-step.js";
import { createGitAdmissionFixture } from "./update-runner-git-admission.test-support.js";
import type { UpdateStepResult } from "./update-step-result.js";

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

it.each(["result", "exception", "uncertain-warning"] as const)(
  "settles a failed candidate and throwing cleanup (%s)",
  async (failure) => {
    const fixture = createGitAdmissionFixture();
    const before = fixture.git(fixture.install, "rev-parse", "HEAD");
    const dist = path.join(fixture.install, "dist");
    fs.mkdirSync(path.join(dist, "control-ui"), { recursive: true });
    for (const [name, content] of Object.entries({
      "entry.js": "export {};",
      "control-ui/index.html": "ready",
      "build-info.json": JSON.stringify({ commit: before, buildId: "retained-build" }),
      ".buildstamp": JSON.stringify({ head: before }),
      ".runtime-postbuildstamp": JSON.stringify({ head: before }),
    })) {
      fs.writeFileSync(path.join(dist, name), content);
    }
    const original = new TypeError("synthetic candidate validation failure");
    const uncertain = new CommandProcessCleanupError();
    const observed: Omit<UpdateStepResult, "cwd">[] = [];
    let candidateRoot: string | undefined;
    try {
      const pending = fixture.run(
        {
          validateCandidate: async (root) => {
            candidateRoot = root;
            if (failure !== "result") {
              throw original;
            }
          },
          progress: {
            onStepComplete: (step) => {
              observed.push(step);
              if (failure === "uncertain-warning" && step.advisory) {
                throw uncertain;
              }
            },
          },
        },
        async (argv, options) => {
          if (argv.includes("worktree") && argv.includes("remove")) {
            throw Object.assign(new Error("synthetic cleanup spawn failure"), { code: "ENOENT" });
          }
          if (candidateRoot && argv.includes("status") && argv.includes(candidateRoot)) {
            return { code: 128, stdout: "", stderr: "fatal: not a git repository: (null)" };
          }
          return fixture.runCommand(argv, options);
        },
      );
      if (failure !== "result") {
        await expect(pending).rejects.toBe(failure === "exception" ? original : uncertain);
      } else {
        const result = await pending;
        expect(result).toMatchObject({
          status: "error",
          reason: "preflight-no-good-commit",
          recovery: { serviceRestartSafe: true, buildId: "retained-build" },
        });
        expect(result.steps.filter(isFailedUpdateStep).map((step) => step.name)).toEqual([
          "preflight-update-clean-check",
        ]);
        expect(result.steps).toContainEqual(
          expect.objectContaining({
            name: "preflight-update-clean-check",
            exitCode: 128,
            stderrTail: "fatal: not a git repository: (null)",
          }),
        );
      }
      expect(fixture.git(fixture.install, "rev-parse", "HEAD")).toBe(before);
      const warning = observed.find((step) =>
        step.advisory?.message.includes("synthetic cleanup spawn failure"),
      );
      expect(warning?.advisory).toMatchObject({ kind: "recoverable-maintenance" });
      expect(warning?.advisory?.message).toContain(path.dirname(candidateRoot!));
      expect(warning?.advisory?.message).toContain("Error");
    } finally {
      if (candidateRoot) {
        fs.rmSync(path.dirname(candidateRoot), { recursive: true, force: true });
      }
    }
  },
);

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
