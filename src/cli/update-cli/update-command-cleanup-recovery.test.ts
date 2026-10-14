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
      expect(boundary.admission).not.toHaveBeenCalled();
      expect(restore).not.toHaveBeenCalled();
      expect(complete).not.toHaveBeenCalled();
      expect(boundary.prepareFailure).not.toHaveBeenCalled();
    } finally {
      cleanup.resolve(cleanupResult);
      await work;
    }
    const error = await work;
    expect(hasCommandProcessCleanupError(error)).toBe(cleanupResult === "uncertain");
    if (cleanupResult === "uncertain") {
      expect(collectNestedErrorCandidates(error)).toContain(original);
      expect(boundary.admission).not.toHaveBeenCalled();
      expect(restore).not.toHaveBeenCalled();
      expect(complete).toHaveBeenCalledExactlyOnceWith(false, { preserveState: true });
      expect(boundary.prepareFailure).not.toHaveBeenCalled();
    } else {
      expect(error).toBe(prepared);
      expect(collectNestedErrorCandidates(error)).toContain(original);
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
  "preserves runtime recovery metadata without authorizing uncertain cleanup (%s)",
  async (uncertain) => {
    const report = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    const error = new UpdatePreMutationError("node-runtime-preflight", "Select a supported Node", {
      ...(uncertain ? { cause: new CommandProcessCleanupError() } : {}),
      recoverySteps: [{ kind: "continue-update", command: "node /synthetic/openclaw.mjs update" }],
    });
    const originalRecovery = vi.fn(async () => ({
      serviceRestartSafe: true as const,
      version: "2026.9.4",
    }));
    const work = resolveMutableUpdateFailure({
      cause: error,
      durationMs: 1,
      mode: "npm",
      root: "/synthetic",
      originalRecovery,
    });
    try {
      if (uncertain) {
        await expect(work).rejects.toBe(error);
        expect(originalRecovery).not.toHaveBeenCalled();
        expect(report).not.toHaveBeenCalled();
      } else {
        const { result, failure } = await work;
        expect(failure.cause).toBe(error);
        expect(originalRecovery).toHaveBeenCalledOnce();
        expect(result.failedStep).toMatchObject({
          name: "node-runtime-preflight",
          recoverySteps: error.recoverySteps,
          failureFacts: error.failureFacts,
        });
        expect(result.steps).toEqual([result.failedStep]);
      }
    } finally {
      report.mockRestore();
    }
  },
);
