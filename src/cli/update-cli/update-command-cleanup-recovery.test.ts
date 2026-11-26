import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { afterEach, expect, it, vi } from "vitest";
import {
  CommandProcessCleanupError,
  hasCommandProcessCleanupError,
} from "../../process/exec-result.js";
import {
  resolveCommandProcessSignal,
  retainCommandProcessCleanup,
} from "../../process/exec-spawn.js";
import { defaultRuntime } from "../../runtime.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { expectNoCalls } from "../../test-utils/mock-call-assertions.js";
import { UpdatePreMutationError } from "./shared.js";
import { resolveMutableUpdateFailure, UpdateCommandFailure } from "./update-command-result.js";
import { withUpdateCommandRecoveryUnwind } from "./update-command-unwind.js";

const boundary = vi.hoisted(() => ({ admission: vi.fn(), prepareFailure: vi.fn() }));
vi.mock("../../infra/update-run-recovery-admission.js", () => ({
  assertUpdateRecoveryAdmission: boundary.admission,
}));
vi.mock("./update-command-run.js", () => ({
  completeUpdateCommandRun: vi.fn(),
}));
vi.mock("./update-command-terminal.js", () => ({
  hasDeferredUpdateCommandTerminalResult: () => false,
  prepareUnexpectedUpdateCommandFailure: boundary.prepareFailure,
}));
afterEach(() => vi.clearAllMocks());

function resolveFailure(
  cause: unknown,
  originalRecovery: Parameters<typeof resolveMutableUpdateFailure>[0]["originalRecovery"],
  mode: "npm" | "git" = "npm",
) {
  return resolveMutableUpdateFailure({
    cause,
    originalRecovery,
    mode,
    root: "/synthetic",
    durationMs: 1,
  });
}

it.each(["forced", "uncertain"] as const)(
  "joins command cleanup before updater compensation (%s)",
  async (cleanupResult) => {
    const cleanup = createDeferredCore<"forced" | "uncertain">();
    const joining = createDeferredCore();
    const original = new Error("mutation cancelled");
    const prepared = new UpdateCommandFailure(
      { status: "error", mode: "unknown", reason: "update-failed", steps: [], durationMs: 0 },
      1,
      original.message,
      { cause: original },
    );
    boundary.prepareFailure.mockResolvedValue(prepared);
    const restore = vi.fn(async () => {});
    const complete = vi.fn(async () => {});
    const work = withUpdateCommandRecoveryUnwind(
      { run: { runId: "synthetic", env: {}, executorFence: { assertCurrent: () => {} } } },
      {
        triageTarget: { root: "/synthetic", env: {} },
        windowsTaskAutoStartRecovery: {
          restore,
          complete,
          suspended: Promise.resolve(true),
          beginMutation: () => {},
          assertRecoveryCurrent: () => {},
          handoff: () => {},
          interrupted: () => false,
        },
      },
      async () => {
        retainCommandProcessCleanup(cleanup.promise);
        resolveCommandProcessSignal()?.addEventListener("abort", () => joining.resolve(), {
          once: true,
        });
        throw original;
      },
    ).catch((error: unknown) => error);
    try {
      await Promise.race([
        joining.promise,
        work.then(() => {
          throw new Error("compensation escaped cleanup ownership");
        }),
      ]);
      expectNoCalls(boundary.admission, restore, complete, boundary.prepareFailure);
    } finally {
      cleanup.resolve(cleanupResult);
      await work;
    }
    const error = await work;
    expect(hasCommandProcessCleanupError(error)).toBe(cleanupResult === "uncertain");
    expect(collectNestedErrorCandidates(error)).toContain(original);
    if (cleanupResult === "uncertain") {
      expectNoCalls(boundary.admission, restore, boundary.prepareFailure);
      expect(complete).toHaveBeenCalledExactlyOnceWith(false, { preserveState: true });
    } else {
      expect(error).toBe(prepared);
      expect(restore).toHaveBeenCalledOnce();
      expect(complete).toHaveBeenCalledOnce();
      expect(boundary.prepareFailure).toHaveBeenCalledExactlyOnceWith(
        original,
        expect.objectContaining({ run: expect.objectContaining({ runId: "synthetic" }) }),
      );
      expect(complete.mock.invocationCallOrder[0]).toBeLessThan(
        boundary.prepareFailure.mock.invocationCallOrder[0]!,
      );
    }
  },
);

it.each([false, true])(
  "preserves recovery metadata without authorizing uncertain cleanup (%s)",
  async (uncertain) => {
    using report = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    const original = new UpdatePreMutationError(
      "node-runtime-preflight",
      "Select a supported Node",
      {
        ...(uncertain ? { cause: new CommandProcessCleanupError() } : {}),
        recoverySteps: [
          { kind: "continue-update", command: "node /synthetic/openclaw.mjs update" },
        ],
      },
    );
    const error = original;
    const originalRecovery = vi.fn(async () => ({
      serviceRestartSafe: true as const,
      version: "2026.9.4",
    }));
    const work = resolveFailure(error, originalRecovery);
    if (uncertain) {
      await expect(work).rejects.toBe(error);
      expectNoCalls(originalRecovery, report);
    } else {
      const { result, failure } = await work;
      expect(failure.cause).toBe(error);
      expect(originalRecovery).toHaveBeenCalledOnce();
      expect(result.failedStep).toMatchObject({
        name: "node-runtime-preflight",
        recoverySteps: original.recoverySteps,
        failureFacts: original.failureFacts,
      });
      expect(result.steps).toEqual([result.failedStep]);
    }
  },
);
