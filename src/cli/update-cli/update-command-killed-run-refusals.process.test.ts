import path from "node:path";
import { describe, expect, it } from "vitest";
import { readUpdateRunDriver } from "../../infra/update-run-driver.js";
import {
  adoptUpdateRun,
  createUpdateRun,
  finishUpdateRun,
  getUpdateRun,
  recordUpdateRunStep,
} from "../../infra/update-run-ledger.js";
import { loadPluginCohortRecovery } from "../../infra/update-run-recovery-store.js";
import { writeConfigMachineState } from "../../state/config-machine-state-write.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import {
  beginRollback,
  ctx,
  finalizationRuns,
  fixtures,
  installation,
  lease,
  loseStore,
  mocks,
  nextUpdate,
  repair,
  running,
  stillRefuses,
  unleased,
  updater,
  type RefusalCase,
} from "./update-command-killed-run.process.test-support.js";
import { updateRepairCommand } from "./update-repair-command.js";

// Each control gives the same dead run one reason its recovery is not this update's to settle.
// The restart rule's controls are in the restart suite, a source checkout's in its own.
describe.skipIf(process.platform === "win32")("next update after a killed update run", () => {
  const otherHistory = new RegExp(
    `Other update history also needs repair \\(.+\\)\\. Run ${repair}`,
    "u",
  );
  it.each<RefusalCase>([
    { name: "the updater is still alive", refusal: running, dead: { end: "stalled" } },
    {
      name: "another update is running under a live process",
      refusal: running,
      control: () => createUpdateRun({ trigger: "cli", origin: { driver: readUpdateRunDriver() } }),
    },
    { name: "the update lease store was removed", refusal: unleased, control: loseStore },
    {
      // Another command has since created a new store at the same path.
      name: "the update lease store was replaced",
      refusal: unleased,
      control: () => loseStore().then(() => lease(path.join(ctx.root, "unrelated"))),
    },
    {
      // A recovery command claimed and released the installation: the lease that tied
      // this store to the dead updater is gone, as it is after a replacement.
      name: "another command already retired the dead updater's lease",
      refusal: unleased,
      control: (killed) => lease(killed.slot),
    },
    {
      // This process stands in for the Gateway's helper finishing the same run.
      name: "a managed helper has adopted the run",
      refusal: new RegExp(`not left by a killed openclaw update command.*${repair}`, "u"),
      control: (killed) =>
        adoptUpdateRun(killed.runId, { managedHandoffParent: readUpdateRunDriver() }),
    },
    {
      name: "the Gateway started the update and may still be finishing it",
      refusal: /not left by a killed openclaw update command.*Gateway is still finishing/u,
      dead: { trigger: "api" },
    },
    {
      // History cannot tell that update's stop from an operator's deliberate one.
      name: "the dead update had stopped the Gateway and this update will not restart it",
      refusal: new RegExp(
        `stopped the Gateway.*asked not to restart it\\. Run ${repair} to settle it and restart`,
        "u",
      ),
      dead: { gateway: "stopped", installed: "candidate" },
    },
    {
      name: "the dead update installed an unverified candidate but is still alive",
      refusal: running,
      dead: { installed: "candidate", end: "stalled" },
    },
    {
      name: "the dead update had begun rolling back and a managed helper has adopted it",
      refusal: new RegExp(`not left by a killed openclaw update command.*${repair}`, "u"),
      dead: { installed: "candidate", gateway: "restarted" },
      control: (killed) => {
        beginRollback(killed);
        adoptUpdateRun(killed.runId, { managedHandoffParent: readUpdateRunDriver() });
      },
    },
    {
      name: "the recorded settlement cannot be applied",
      refusal: new RegExp(
        `could not be settled \\(Plugin cohort commit does not match.*${repair}`,
        "u",
      ),
      control: (killed) =>
        writeConfigMachineState(`update.pluginCohort.${killed.runId}`, {
          ...loadPluginCohortRecovery(killed.runId)!.cohort,
          disposition: "commit",
        }),
    },
    {
      name: "the recovery belongs to another installation",
      refusal: /belongs to the installation at .*from that installation/u,
      control: async (killed) => {
        killed.slot = await installation("other");
      },
    },
    {
      name: "the update is a dry run",
      refusal: /A dry run changes nothing\. Run openclaw update to settle it/u,
      dryRun: true,
    },
    {
      // Repair would restart the Gateway an earlier update stopped; this update finishes one run.
      name: "an unverified candidate is installed and an earlier update left the Gateway stopped",
      refusal: otherHistory,
      dead: { installed: "candidate" },
      control: () => {
        const earlier = createUpdateRun({ trigger: "cli" });
        const stop = { step: "service-stop", status: "completed", endedAtMs: Date.now() } as const;
        recordUpdateRunStep(earlier.runId, stop);
        finishUpdateRun(earlier.runId, { status: "failed", reason: "update-failed" });
      },
    },
    {
      name: "the Gateway is stopped and another interrupted update is unacknowledged",
      refusal: otherHistory,
      dead: { installed: "candidate", gateway: "stopped" },
      restart: true,
      control: () => {
        const earlier = createUpdateRun({ trigger: "cli" });
        finishUpdateRun(earlier.runId, { status: "failed", reason: "abandoned" });
      },
    },
    {
      // Repair's own history rule: a full page ending after the killed run hides what is older.
      name: "an unverified candidate is installed and a full history page ends after the killed run",
      refusal: /Other update history also needs repair\. Run openclaw update repair/u,
      dead: { installed: "candidate" },
      control: () => settledHistory(100, "after"),
    },
  ])("still refuses when $name", stillRefuses);

  /** `count` finished, successful runs recorded before or after the killed one. */
  function settledHistory(count: number, when: "before" | "after") {
    const { db } = openOpenClawStateDatabase();
    const backdate = db.prepare("UPDATE update_runs SET created_at_ms = ? WHERE run_id = ?");
    for (let index = 0; index < count; index += 1) {
      const { runId } = createUpdateRun({ trigger: "cli" });
      finishUpdateRun(runId, { status: "succeeded" });
      if (when === "before") {
        // Distinctly older than the killed run.
        backdate.run(Date.now() - 60_000 - index, runId);
      }
    }
  }

  // An unacknowledged abandoned run older than the newest 100 rows is past the page
  // that update, repair and Doctor all read. Both entries finish the killed run and
  // leave that run exactly as they found it, so refusing would name a repair that
  // cannot clear the refusal.
  it.each(["openclaw update", "openclaw update repair"] as const)(
    "%s finishes a dead update past a full history page that reaches back before it",
    (entry) =>
      fixtures.lifetime.run(async () => {
        const killed = await updater(await installation(), { installed: "candidate" });
        const buried = createUpdateRun({ trigger: "cli" });
        finishUpdateRun(buried.runId, { status: "failed", reason: "abandoned" });
        const { db } = openOpenClawStateDatabase();
        db.prepare("UPDATE update_runs SET created_at_ms = ? WHERE run_id = ?").run(
          Date.now() - 120_000,
          buried.runId,
        );
        // Routine history: the killed run and 99 older successful runs fill one page.
        settledHistory(99, "before");
        const before = getUpdateRun(buried.runId);

        if (entry === "openclaw update") {
          await nextUpdate(killed.slot);
          expect(mocks.proceed).toHaveBeenCalledOnce();
          expect(ctx.admitted[0]?.packageActivationSteps?.map((step) => step.name)).toEqual([
            "interrupted-update-recovery",
            "interrupted-update-finalization",
          ]);
        } else {
          mocks.root.mockResolvedValue(killed.slot);
          await updateRepairCommand({ json: true, yes: true });
        }

        expect(loadPluginCohortRecovery(killed.runId)).toBeUndefined();
        expect(finalizationRuns()).toMatchObject([{ status: "succeeded" }]);
        expect(getUpdateRun(killed.runId)?.steps).toContainEqual(
          expect.objectContaining({ step: "reconcile:acknowledged", status: "completed" }),
        );
        expect(getUpdateRun(buried.runId)).toEqual(before);
      }),
  );
});
