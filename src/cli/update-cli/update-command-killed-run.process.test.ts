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
import {
  getUpdateRun,
  listUpdateRuns,
  reconcileAbandonedUpdateRunsAsync,
} from "../../infra/update-run-ledger.js";
import { loadPluginCohortRecovery } from "../../infra/update-run-recovery-store.js";
import { loadUpdateRecovery } from "../../infra/update-run-recovery.js";
import { defaultRuntime } from "../../runtime.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import {
  beginRollback,
  candidate,
  config,
  ctx,
  expectFinishFailure,
  finalization,
  finalizationRuns,
  fixtures,
  installation,
  killedPublication,
  managedGateway,
  mocks,
  nextUpdate,
  recorded,
  repair,
  reserved,
  settled,
  shape,
  unleased,
  updater,
  type Dead,
  type Updater,
} from "./update-command-killed-run.process.test-support.js";
import { updateRepairCommand } from "./update-repair-command.js";

// Settlement and finishing; refusals, the restart rule and source checkouts have their own suites.
describe.skipIf(process.platform === "win32")("next update after a killed update run", () => {
  it("settles the dead run's plugin recovery itself and proceeds", () =>
    fixtures.lifetime.run(async () => {
      const killed = await updater(await installation());

      await nextUpdate(killed.slot);

      expect(mocks.proceed).toHaveBeenCalledOnce();
      expect(loadPluginCohortRecovery(killed.runId)).toBeUndefined();
      // The dead update never installed its candidate, so its config change is undone.
      expect(config()).toEqual({ plugins: { enabled: false } });
      const note = settled(ctx.admitted[0]);
      expect(note).toMatch(
        new RegExp(`^Settled interrupted update ${killed.runId}.*rolled back, because`, "u"),
      );
      expect(defaultRuntime.error).toHaveBeenCalledWith(note);
      // The admitted update's own history reconciliation can now close the dead run.
      await reconcileAbandonedUpdateRunsAsync({});
      expect(getUpdateRun(killed.runId)).toMatchObject({ status: "failed", reason: "abandoned" });

      // A second update finds nothing left to settle or to refuse.
      await nextUpdate(killed.slot);
      expect(mocks.proceed).toHaveBeenCalledTimes(2);
      expect(ctx.admitted[1]?.packageActivationSteps).toBeUndefined();
    }));

  it("keeps the plugin changes of a dead run whose candidate was verified serving", () =>
    fixtures.lifetime.run(async () => {
      // Killed in post-update maintenance: the Gateway it stopped is running the candidate.
      const dead = { installed: "candidate", gateway: "restarted" } as const;
      const killed = await updater(await installation(), dead);

      await nextUpdate(killed.slot);

      expect(mocks.proceed).toHaveBeenCalledOnce();
      expect(loadPluginCohortRecovery(killed.runId)).toBeUndefined();
      expect(config().gateway).toEqual({ mode: "local" });
      expect(settled(ctx.admitted[0])).toMatch(/kept, because its Gateway was verified/u);
    }));

  it.runIf(expectedPathExchangeRoute)(
    "settles a killed publication and then the same run's plugin recovery",
    () =>
      fixtures.lifetime.run(async () => {
        const killed = await updater(await killedPublication());

        await nextUpdate(killed.slot);

        expect(ctx.admitted[0]?.packageActivationSteps?.map((step) => step.name)).toEqual([
          "package-publication-recovery",
          "interrupted-update-recovery",
        ]);
        expect(packageVersion(killed.slot)).toBe("2026.11.3");
        expect(loadPluginCohortRecovery(killed.runId)).toBeUndefined();
        expect(config()).toEqual({ plugins: { enabled: false } });
      }),
  );

  // Repair finishes these installed versions; an update that found its core current would not.
  const unfinished: Array<{ name: string; dead: Updater; rollback?: true; restart?: true }> = [
    { name: "replaced the installed version unconfirmed", dead: { installed: "candidate" } },
    {
      // The cohort owner finishes a rollback that restored anything, even over a verified candidate.
      name: "had begun rolling back on the version it installed",
      dead: { installed: "candidate", gateway: "restarted" },
      rollback: true,
    },
    {
      name: "left the Gateway stopped",
      dead: { installed: "candidate", gateway: "stopped" },
      restart: true,
    },
  ];
  async function unfinishedUpdate(state: (typeof unfinished)[number], name?: string) {
    const killed = await updater(await installation(name), state.dead);
    if (state.rollback) {
      beginRollback(killed);
    }
    if (state.dead.gateway === "stopped") {
      managedGateway(killed.slot);
    }
    return killed;
  }
  const finish = (killed: Dead, state: (typeof unfinished)[number]) =>
    nextUpdate(killed.slot, state.restart ? { restart: true } : {});

  it.each(unfinished)("finishes a dead update that $name as repair does, then proceeds", (state) =>
    fixtures.lifetime.run(async () => {
      const killed = await unfinishedUpdate(state);

      await finish(killed, state);

      expect(mocks.proceed).toHaveBeenCalledOnce();
      // The installed version's Doctor ran and its Gateway started before this update went on,
      // and nothing printed a result document on the way: the update's own stays the only one.
      const started = state.dead.gateway === "stopped" ? 1 : 0;
      expect(ctx.observedAtAdmission).toEqual([{ doctor: 1, json: 0, started }]);
      expect(loadPluginCohortRecovery(killed.runId)).toBeUndefined();
      expect(packageVersion(killed.slot)).toBe(candidate);
      // Repair keeps the change of a rollback that began over the verified candidate.
      expect(config().gateway).toEqual(state.rollback ? { mode: "local" } : undefined);
      expect(config().plugins).toEqual({ enabled: false });
      const [stage, ...others] = finalizationRuns();
      expect(others).toEqual([]);
      expect(stage).toMatchObject({ trigger: "cli", status: "succeeded" });
      expect(ctx.admitted[0]?.packageActivationSteps?.map((step) => step.name)).toEqual([
        "interrupted-update-recovery",
        "interrupted-update-finalization",
      ]);
      expect(recorded(ctx.admitted[0], "interrupted-update-finalization")).toBe(
        `Finished interrupted update ${killed.runId} as ${repair} does (Doctor, plugin convergence and Gateway restoration); recorded as update run ${stage?.runId} (ok).`,
      );
      expect(getUpdateRun(killed.runId)).toMatchObject({ status: "failed", reason: "abandoned" });
      expect(getUpdateRun(killed.runId)?.steps).toContainEqual(
        expect.objectContaining({ step: "reconcile:acknowledged", status: "completed" }),
      );
    }),
  );

  it.each(unfinished)("records what repair records when the dead update $name", (state) =>
    fixtures.lifetime.run(async () => {
      const finished = await unfinishedUpdate(state);
      await finish(finished, state);
      const [stage] = finalizationRuns();
      // Each killed updater's own config write stamps `meta`; compare what settlement decides.
      const settledConfig = () => ({ plugins: config().plugins, gateway: config().gateway });
      const configAfterUpdate = settledConfig();
      const repaired = await unfinishedUpdate(state, "repaired");
      mocks.root.mockResolvedValue(repaired.slot);

      await updateRepairCommand({ json: true, yes: true });

      const [repairRun] = finalizationRuns();
      expect(repairRun?.runId).not.toBe(stage?.runId);
      expect(shape(stage)).toEqual(shape(repairRun));
      expect(settledConfig()).toEqual(configAfterUpdate);
      expect(shape(getUpdateRun(finished.runId))).toEqual(shape(getUpdateRun(repaired.runId)));
      // Repair reports its own result; the update's stage reported none.
      expect(defaultRuntime.writeJson).toHaveBeenCalledOnce();
    }),
  );

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
      const killed = await unfinishedUpdate(unfinished[0]!);
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
      const killed = await updater(await installation(), unfinished[2]!.dead);

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
