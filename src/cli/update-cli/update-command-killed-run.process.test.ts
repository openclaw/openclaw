import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  openPackageActivationJournal,
  resolvePackageActivationAnchor,
} from "../../infra/package-update-activation-journal.js";
import { mockInertSealedHelper } from "../../infra/package-update-activation-lifetime.test-support.js";
import { packageVersion } from "../../infra/package-update-kill-sweep.test-support.js";
import { expectedPathExchangeRoute } from "../../infra/path-exchange.test-support.js";
import { DoctorMaintenanceRefusalError } from "../../infra/update-doctor-result.js";
import { createRetainedUpdateRecovery } from "../../infra/update-retained-recovery.test-support.js";
import { listUpdateRuns } from "../../infra/update-run-ledger.js";
import { loadPluginCohortRecovery } from "../../infra/update-run-recovery-store.js";
import { loadUpdateRecovery } from "../../infra/update-run-recovery.js";
import { defaultRuntime } from "../../runtime.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import {
  ctx,
  expectFinishFailure,
  finalization,
  finalizationRuns,
  fixtures,
  installation,
  killedPublication,
  mocks,
  nextUpdate,
  reserved,
  unleased,
  updater,
} from "./update-command-killed-run.process.test-support.js";

// Pre-routing recovery refusals; restart and source-checkout refusals have their own suites.
describe.skipIf(process.platform === "win32")("next update after a killed update run", () => {
  it.each([
    {
      name: "Doctor fails on the installed version",
      error: new Error("synthetic Doctor failure"),
      detail: "synthetic Doctor failure",
      stage: { status: "failed" },
    },
    {
      // Repair exits 2 here; the stage hands the same outcome to this update as a refusal.
      name: "Doctor maintenance must wait",
      error: new DoctorMaintenanceRefusalError("synthetic maintenance deferral", {
        kind: "deferred",
        reason: "coordinator-contention",
      }),
      detail: "Doctor maintenance remains pending. Stop the Gateway",
      stage: { status: "skipped", reason: "doctor-maintenance-pending" },
    },
  ])("stops and names repair when finishing fails: $name", ({ error, detail, stage }) =>
    fixtures.lifetime.run(async () => {
      const killed = await updater(await installation(), { installed: "candidate" });
      finalization.doctor.mockRejectedValue(error);

      const refused = await nextUpdate(killed.slot).catch((cause: unknown) => cause);

      expectFinishFailure(refused, killed.runId, detail);
      expect(mocks.proceed).not.toHaveBeenCalled();
      expect(defaultRuntime.writeJson).not.toHaveBeenCalled();
      // Left as repair leaves it: the plugin recovery settled and its own run not successful.
      expect(loadPluginCohortRecovery(killed.runId)).toBeUndefined();
      expect(finalizationRuns()).toEqual([expect.objectContaining(stage)]);
      expect(listUpdateRuns({ limit: 100 }).filter((run) => run.status === "succeeded")).toEqual(
        [],
      );
    }),
  );

  it("stops and names repair when repair's finish leaves that Gateway stopped", () =>
    fixtures.lifetime.run(async () => {
      // No managed service this update may restore: repair warns, the Gateway stays stopped.
      const killed = await updater(await installation(), {
        installed: "candidate",
        gateway: "stopped",
      });

      const refused = await nextUpdate(killed.slot, { restart: true }).catch(
        (cause: unknown) => cause,
      );

      const [stage] = finalizationRuns();
      expect(stage).toMatchObject({ status: "succeeded" });
      expectFinishFailure(
        refused,
        killed.runId,
        `the Gateway that update stopped is still not running (update run ${stage?.runId}, warning).`,
      );
      expect(mocks.proceed).not.toHaveBeenCalled();
      expect(ctx.service.start).not.toHaveBeenCalled();
      expect(defaultRuntime.writeJson).not.toHaveBeenCalled();
    }));

  it("refuses while another updater holds the installation", () =>
    fixtures.lifetime.run(async () => {
      const killed = await updater(await installation());
      const before = reserved(killed.runId);
      await withUpdateCommandExecutor(randomUUID(), async (executor) => {
        await executor.enter(killed.slot);
        // The holder's claim retired the dead updater's lease: the proof is gone.
        await expect(nextUpdate(killed.slot)).rejects.toThrow(unleased);
      });
      expect(mocks.proceed).not.toHaveBeenCalled();
      expect(reserved(killed.runId)).toEqual(before);
    }));

  it("leaves recovery that repair cannot settle to the unchanged refusal", () =>
    fixtures.lifetime.run(async () => {
      // A second reserved recovery without a plugin cohort: repair settles neither.
      const killed = await updater(await installation());
      const core = { root: killed.slot, nodePath: process.execPath, buildId: null };
      const other = createRetainedUpdateRecovery({
        runId: randomUUID(),
        from: { ...core, version: "2026.11.2" },
        to: { ...core, version: "2026.11.3" },
      });
      const before = reserved(killed.runId);

      await expect(nextUpdate(killed.slot)).rejects.toThrow(
        /has unfinished recovery; reconcile it before starting another update\.$/u,
      );

      expect(mocks.proceed).not.toHaveBeenCalled();
      expect(reserved(killed.runId)).toEqual(before);
      expect(loadUpdateRecovery(other.runId)).toEqual(other);
    }));

  // The package refusals come first and are unchanged; nothing is settled on the way to them.
  it.runIf(expectedPathExchangeRoute).each<{
    name: string;
    refusal: RegExp;
    control: (slot: string) => unknown;
  }>([
    {
      name: "a rollback in progress",
      refusal: /Package restoration is unfinished/u,
      control: (slot) =>
        withUpdateCommandExecutor(randomUUID(), async (executor) => {
          const fence = await executor.enter(slot);
          const writer = openPackageActivationJournal(resolvePackageActivationAnchor(slot));
          writer.transition(writer.read(), "rollback-in-progress", null, fence.assertCurrent);
        }),
    },
    {
      name: "a publication journal from another build",
      refusal: /Package publication is incomplete; its original continuation cannot run/u,
      control: () => mockInertSealedHelper(ctx.root),
    },
  ])(
    "with $name: the package refusal stands and the recovery stays reserved",
    ({ refusal, control }) =>
      fixtures.lifetime.run(async () => {
        const killed = await updater(await killedPublication());
        await control(killed.slot);
        const before = reserved(killed.runId);

        // The command reports this refusal itself, then exits.
        await expect(nextUpdate(killed.slot)).rejects.toThrow("exit 1");

        const outputs = (["error", "writeJson", "log"] as const).flatMap(
          (output) => vi.mocked(defaultRuntime[output]).mock.calls,
        );
        expect(JSON.stringify(outputs)).toMatch(refusal);
        expect(mocks.proceed).not.toHaveBeenCalled();
        expect(reserved(killed.runId)).toEqual(before);
        expect(packageVersion(killed.slot)).toBe("2026.11.3");
      }),
  );
});
