import fs from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import {
  resolveMutableUpdateFailure,
  UpdateCommandPendingRecoveryFailure,
} from "../cli/update-cli/update-command-result.js";
import {
  CommandProcessCleanupError,
  hasCommandProcessCleanupError,
} from "../process/exec-result.js";
import * as failureFacts from "./update-failure-facts.js";
import { UpdatePreMutationError } from "./update-pre-mutation-error.js";
import { createGitAdmissionFixture } from "./update-runner-git-admission.test-support.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

type FailureCase = {
  name: string;
  failure: () => unknown;
  reporting?: "start" | "complete";
  recovery?: "admission" | "pending";
};
const failureCases: FailureCase[] = [
  { name: "control", failure: () => new Error("SYNTHETIC_POST_STOP_FAILURE") },
  {
    name: "start reporting",
    failure: () => new Error("SYNTHETIC_POST_STOP_FAILURE"),
    reporting: "start",
  },
  {
    name: "completion reporting",
    failure: () => new Error("SYNTHETIC_POST_STOP_FAILURE"),
    reporting: "complete",
  },
  {
    name: "admission",
    failure: () => new UpdatePreMutationError("node-runtime-preflight", "Unsupported runtime"),
    reporting: "start",
    recovery: "admission",
  },
  {
    name: "pending recovery",
    failure: () =>
      new UpdateCommandPendingRecoveryFailure({
        status: "error",
        mode: "git",
        reason: "update-failed",
        steps: [],
        durationMs: 0,
      }),
    reporting: "start",
    recovery: "pending",
  },
  {
    name: "frozen error",
    failure: () => Object.freeze(new Error("immutable original")),
    reporting: "start",
  },
  { name: "primitive rejection", failure: () => "primitive original", reporting: "start" },
];

it.each(failureCases)(
  "preserves failure identity and cleanup: $name",
  async ({ failure, reporting, recovery }) => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fixture = createGitAdmissionFixture();
    const before = fixture.git(fixture.install, "rev-parse", "HEAD");
    const original = failure();
    const reject = vi.fn<() => Promise<void>>().mockRejectedValue(original);
    const reportingError = new Error("Cleanup history is undergoing offline maintenance");
    const doctor = vi.fn();
    let validated = false;
    let stopped = false;
    const error = await fixture
      .run({
        validateCandidate: async () => {
          validated = true;
        },
        beforeGitMutation: async () => {
          expect(validated).toBe(true);
          stopped = true;
          await reject();
        },
        runGitDoctor: doctor,
        progress: {
          onStepStart: ({ name }) => {
            if (reporting === "start" && name === "preflight-cleanup") {
              throw reportingError;
            }
          },
          onStepComplete: ({ name }) => {
            if (reporting === "complete" && name === "preflight-cleanup") {
              throw reportingError;
            }
          },
        },
      })
      .catch((caught: unknown) => caught);
    expect(stopped).toBe(true);
    expect(error).toBe(original);
    expect(doctor).not.toHaveBeenCalled();
    expect(fixture.git(fixture.install, "rev-parse", "HEAD")).toBe(before);
    const removals = fixture.calls.filter(
      (args) => args.includes("worktree") && args.includes("remove"),
    );
    expect(removals).toHaveLength(1);
    expect(fs.existsSync(removals[0]!.at(-1)!)).toBe(false);
    if (reporting) {
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("offline maintenance"));
    } else {
      expect(warning).not.toHaveBeenCalled();
    }
    if (recovery) {
      const originalRecovery = vi.fn(async () => ({
        serviceRestartSafe: true as const,
        version: "2026.9.4",
      }));
      const resolved = resolveMutableUpdateFailure({
        cause: error,
        durationMs: 0,
        mode: "git",
        root: fixture.install,
        originalRecovery,
      });
      if (recovery === "pending") {
        await expect(resolved).rejects.toBe(original);
        expect(originalRecovery).not.toHaveBeenCalled();
      } else {
        expect((await resolved).result.recovery?.serviceRestartSafe).toBe(true);
        expect(originalRecovery).toHaveBeenCalledOnce();
      }
    }
  },
);

it("keeps a successful update successful when cleanup reporting is unavailable", async () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
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
      name: "preflight-cleanup",
      exitCode: 0,
      warnings: [
        expect.stringContaining("offline maintenance"),
        expect.stringContaining("completion reporting unavailable"),
      ],
    }),
  );
  expect(warning).toHaveBeenCalledTimes(2);
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

it.each(["admission", "pending"] as const)(
  "blocks $0 recovery after actual cleanup rejection",
  async (kind) => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fixture = createGitAdmissionFixture();
    const original =
      kind === "admission"
        ? new UpdatePreMutationError("node-runtime-preflight", "Original admission failure")
        : new UpdateCommandPendingRecoveryFailure({
            status: "error",
            mode: "git",
            reason: "update-failed",
            steps: [],
            durationMs: 0,
          });
    const cleanup = new Error("Cleanup ownership changed");
    const error = await fixture
      .run(
        {
          beforeGitMutation: async () => {
            throw original;
          },
        },
        async (argv, options) => {
          if (argv.includes("worktree") && argv.includes("remove")) {
            throw cleanup;
          }
          return fixture.runCommand(argv, options);
        },
      )
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ cause: original, errors: [original, cleanup] });
    expect(warning).not.toHaveBeenCalled();
    const originalRecovery = vi.fn(async () => ({
      serviceRestartSafe: true as const,
      version: "2026.7.1",
    }));
    const resolved = resolveMutableUpdateFailure({
      cause: error,
      durationMs: 0,
      mode: "git",
      root: fixture.install,
      originalRecovery,
    });
    if (kind === "pending") {
      const failure = await resolved.catch((caught: unknown) => caught);
      expect(failure).toBeInstanceOf(UpdateCommandPendingRecoveryFailure);
      expect(failure).toMatchObject({ cause: error });
    } else {
      expect((await resolved).result.recovery?.serviceRestartSafe).toBe(false);
    }
    expect(originalRecovery).not.toHaveBeenCalled();
  },
);

it("uses the frozen command environment when redacting cleanup warnings", async () => {
  const redact = vi.spyOn(failureFacts, "createUpdateErrorFact");
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const state = "/synthetic/frozen-cleanup-state";
  vi.stubEnv("OPENCLAW_STATE_DIR", state);
  const fixture = createGitAdmissionFixture();
  vi.stubEnv("OPENCLAW_STATE_DIR", "/synthetic/later-process-state");
  const original = new Error("Original failure");
  const error = await fixture
    .run({
      beforeGitMutation: async () => {
        throw original;
      },
      progress: {
        onStepStart: ({ name }) => {
          if (name === "preflight-cleanup") {
            throw new Error("Offline maintenance at " + state + "/private.sqlite");
          }
        },
      },
    })
    .catch((caught: unknown) => caught);
  expect(error).toBe(original);
  const output = warning.mock.calls.flat().join(" ");
  expect(output).not.toContain(state);
  expect(output).toContain("[redacted-path]");
  // Public diagnostics hide every path; also check the supplied redaction context.
  expect(redact).toHaveBeenCalledWith(
    "preflight-cleanup",
    expect.any(Error),
    expect.objectContaining({ OPENCLAW_STATE_DIR: state }),
  );
});
