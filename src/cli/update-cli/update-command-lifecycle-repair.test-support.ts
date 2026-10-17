import { expect, it, vi, type Mock } from "vitest";
import { note } from "../../../packages/terminal-core/src/note.js";
import { createDoctorMaintenanceFixture } from "../../commands/doctor-maintenance.test-support.js";
import { noteStaleUpdateRuns } from "../../commands/doctor-update-run.js";
import { collectNestedErrorCandidates } from "../../infra/error-graph-internal.js";
import * as updateCheck from "../../infra/update-check.js";
import {
  createUpdateRun,
  finishUpdateRun,
  getUpdateRun,
  listUpdateRuns,
} from "../../infra/update-run-ledger.js";
import { hasCommandProcessCleanupError } from "../../process/exec-result.js";
import {
  resolveCommandProcessSignal,
  retainCommandProcessCleanup,
} from "../../process/exec-spawn.js";
import { defaultRuntime } from "../../runtime.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  expectNoCalls,
  expectPartialCall,
} from "../daemon-cli/lifecycle-assertions.test-support.js";
import { updateFinalizeCommand } from "./update-command-finalize.js";
import {
  completePostCorePluginUpdate,
  runUpdateFinalizationDoctorInFreshProcess,
} from "./update-command-fresh-doctor.js";
import {
  successfulPluginUpdate,
  validConfigSnapshot,
} from "./update-command-lifecycle.test-support.js";
import { updateRepairCommand } from "./update-repair-command.js";

/** Keep physical cleanup pending while inspecting the command's publication boundary. */
export function createRetainedCleanupFixture() {
  const physical = createDeferredCore<"forced" | "uncertain">();
  const joining = createDeferredCore();
  return {
    retain() {
      retainCommandProcessCleanup(physical.promise);
      const signal = resolveCommandProcessSignal();
      if (!signal) {
        throw new Error("Finalization lost its command scope");
      }
      signal.addEventListener("abort", () => joining.resolve(), { once: true });
    },
    async settle(work: Promise<unknown>, cleanup: "forced" | "uncertain", pending: () => void) {
      let finished = false;
      const observe = (error: unknown) => {
        finished = true;
        return error;
      };
      const command = work.then(() => observe(undefined), observe);
      try {
        await Promise.race([
          joining.promise,
          command.then(() => {
            throw new Error("Finalization returned before physical settlement");
          }),
        ]);
        expect(finished).toBe(false);
        pending();
      } finally {
        physical.resolve(cleanup);
        await command;
      }
      return await command;
    },
  };
}

export function registerAbandonedRepairHistoryTests(): void {
  const notes = vi.mocked(note);
  it.each([false, true])(
    "acknowledges aged abandoned history only after successful repair (failed=%s)",
    async (failed) => {
      const now = Date.now();
      const clock = vi.spyOn(Date, "now");
      const abandoned = [3, 2].map((hours) => {
        clock.mockReturnValue(now - hours * 3_600_000);
        const run = createUpdateRun({ trigger: "cli", before: { version: "2026.9.5" } });
        return finishUpdateRun(run.runId, { status: "failed", reason: "abandoned" });
      });
      clock.mockReturnValue(now - 3_600_000);
      const newer = createUpdateRun({ trigger: "cli" });
      finishUpdateRun(newer.runId, { status: "succeeded" });
      clock.mockRestore();

      await noteStaleUpdateRuns({ migrateState: false });
      for (const run of abandoned) {
        expect(note).toHaveBeenCalledWith(
          expect.stringContaining(`Update ${run.runId} remains abandoned:`),
          "Update history",
        );
      }
      notes.mockClear();
      if (failed) {
        vi.mocked(runUpdateFinalizationDoctorInFreshProcess).mockRejectedValueOnce(
          new Error("Doctor failed"),
        );
      }

      const repair = updateRepairCommand({
        json: true,
        yes: true,
        timeout: "5",
        deferCompletionCache: true,
      });
      if (failed) {
        await expect(repair).rejects.toThrow("Doctor failed");
      } else {
        await repair;
      }
      for (const run of abandoned) {
        const current = getUpdateRun(run.runId)!;
        expect(current).toMatchObject({
          status: "failed",
          reason: "abandoned",
          finishedAtMs: run.finishedAtMs,
        });
        expect(
          current.steps.some(
            (step) => step.step === "reconcile:acknowledged" && step.status === "completed",
          ),
        ).toBe(!failed);
      }
      await noteStaleUpdateRuns({ migrateState: false });
      expect(
        notes.mock.calls.filter(([message]) => String(message).includes("remains abandoned:")),
      ).toHaveLength(failed ? 2 : 0);
    },
  );
}

export function registerRepairCustodyTests(mocks: {
  maintenance: Mock<typeof import("../../commands/doctor-maintenance.js").beginDoctorMaintenance>;
  triage: Mock;
}): void {
  it.each(
    (["doctor", "convergence", "restoration"] as const).flatMap((phase) =>
      (["forced", "uncertain"] as const).map((cleanup) => ({ phase, cleanup })),
    ),
  )(
    "settles repair custody before restoration and publication ($phase, $cleanup)",
    async ({ phase, cleanup }) => {
      const custody = createRetainedCleanupFixture();
      const originalError = new Error("Repair Doctor failed");
      const maintenance = createDoctorMaintenanceFixture();
      const { finish, release, releaseState } = maintenance;
      vi.mocked(finish).mockImplementation(async () => {
        if (phase === "restoration") {
          custody.retain();
        }
      });
      mocks.maintenance.mockResolvedValue(maintenance);
      vi.spyOn(updateCheck, "resolveUpdateInstallKind").mockResolvedValue("package");
      // Reconciliation is observed; the invocation still uses its real ledger.
      const ledger = await import("../../infra/update-run-ledger.js");
      const reconcile = vi.spyOn(ledger, "reconcileAbandonedUpdateRunsAsync").mockResolvedValue([]);
      const acknowledge = vi.spyOn(ledger, "acknowledgeAbandonedUpdateRun").mockReturnValue(true);
      const expectUnpublished = () => {
        expectNoCalls(reconcile, acknowledge, defaultRuntime.writeJson);
      };
      const expectCustodyHeld = () => {
        expect(finish).toHaveBeenCalledTimes(phase === "restoration" ? 1 : 0);
        expectUnpublished();
        expectNoCalls(release, mocks.triage);
      };
      if (phase === "convergence") {
        vi.mocked(completePostCorePluginUpdate).mockImplementationOnce(async () => {
          custody.retain();
          return { pluginUpdate: successfulPluginUpdate, configSnapshot: validConfigSnapshot };
        });
      } else {
        vi.mocked(runUpdateFinalizationDoctorInFreshProcess).mockImplementationOnce(async () => {
          if (phase === "doctor") {
            custody.retain();
          }
          throw originalError;
        });
      }
      const error = await custody.settle(
        updateFinalizeCommand({ json: true, yes: true, timeout: "5", deferCompletionCache: true }, [
          "synthetic-retained-run",
        ]),
        cleanup,
        () => {
          expectCustodyHeld();
          expect(listUpdateRuns()[0]?.status).toBe("running");
        },
      );
      expect(releaseState).toHaveBeenCalledOnce();
      if (cleanup === "uncertain") {
        expect(hasCommandProcessCleanupError(error)).toBe(true);
        if (phase !== "convergence") {
          expect(collectNestedErrorCandidates(error)).toContain(originalError);
        }
        expectCustodyHeld();
        expect(listUpdateRuns()[0]?.status).not.toBe("succeeded");
      } else {
        expect(vi.mocked(finish).mock.calls).toEqual([[validConfigSnapshot.config]]);
        const converged = phase === "convergence";
        expect(error).toBe(converged ? undefined : originalError);
        expect(release).toHaveBeenCalledTimes(converged ? 0 : 1);
        expect(mocks.triage).toHaveBeenCalledTimes(converged ? 0 : 1);
        expect(listUpdateRuns()[0]?.status).toBe(converged ? "succeeded" : "failed");
        if (converged) {
          expect(reconcile).toHaveBeenCalledWith({
            explicit: true,
            runIds: ["synthetic-retained-run"],
          });
          expect(acknowledge).toHaveBeenCalledWith("synthetic-retained-run");
          expectPartialCall(defaultRuntime.writeJson, { status: "ok", mode: "finalize" });
        } else {
          expectUnpublished();
        }
      }
    },
  );
}
