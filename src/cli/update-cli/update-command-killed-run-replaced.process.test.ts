import { describe, expect, it } from "vitest";
import { PLUGIN_COHORT_REPLACED_INSTALLATION_STEP } from "../../infra/update-run-codec.js";
import {
  finishUpdateRun,
  getUpdateRun,
  reconcileAbandonedUpdateRunsAsync,
  recordUpdateRunStep,
  recordUpdateRunVerification,
} from "../../infra/update-run-ledger.js";
import { loadPluginCohortRecovery } from "../../infra/update-run-recovery-store.js";
import {
  candidate,
  config,
  ctx,
  fixtures,
  lease,
  linkedInstallation,
  mocks,
  nextUpdate,
  replacePackageDirectory,
  repair,
  reserved,
  settled,
  unleased,
  updater,
  type Dead,
  type Updater,
} from "./update-command-killed-run.process.test-support.js";
import { updateRepairCommand } from "./update-repair-command.js";

// pnpm gives each package version its own directory, and activation moves the
// previous one away. An update that verified its candidate and then died leaves its
// plugin recovery keyed to a directory that no longer exists; the installation that
// replaced it settles that recovery only on evidence.
const verified: Updater = { installed: "candidate", gateway: "restarted" };
const replacedWarning = (runId: string) =>
  getUpdateRun(runId)?.steps.find((step) => step.step === PLUGIN_COHORT_REPLACED_INSTALLATION_STEP)
    ?.detail;
// Update history records paths under the account home as `~`.
const home = (file: string) => file.replace(ctx.root, "~");
const runRepair = (slot: string) => {
  mocks.root.mockResolvedValue(slot);
  return updateRepairCommand({ json: true, yes: true });
};

describe.skipIf(process.platform === "win32")(
  "an update whose package directory its own activation replaced",
  () => {
    it("is settled by the next update while the store holds its dead driver's lease", () =>
      fixtures.lifetime.run(async () => {
        const install = await linkedInstallation();
        const killed = await updater(install.key, { ...verified, root: install.slot });
        const successor = await replacePackageDirectory(install);

        await nextUpdate(install.slot);

        expect(mocks.proceed).toHaveBeenCalledOnce();
        expect(loadPluginCohortRecovery(killed.runId)).toBeUndefined();
        // The candidate's plugin and config changes are kept: it was verified serving.
        expect(config().gateway).toEqual({ mode: "local" });
        expect(settled(ctx.admitted[0])).toMatch(/kept, because its Gateway was verified/u);
        expect(replacedWarning(killed.runId)).toBe(
          `Plugin recovery was settled (commit) from a replacing installation: the package directory this update recorded, ${home(install.key)}, no longer exists, its install path ${home(install.slot)} resolves to the installation at ${home(successor)}, its driver exited, and it recorded OpenClaw ${candidate} serving.`,
        );
        // History reconciliation then closes the dead run and keeps the warning.
        await reconcileAbandonedUpdateRunsAsync({});
        expect(getUpdateRun(killed.runId)).toMatchObject({ status: "failed", reason: "abandoned" });
        expect(replacedWarning(killed.runId)).toContain(home(install.key));
      }));

    it("is settled by repair after its driver released its lease, and the next update proceeds", () =>
      fixtures.lifetime.run(async () => {
        const install = await linkedInstallation();
        const killed = await updater(install.key, { ...verified, root: install.slot });
        // The driver exited through its own unwind, which releases its lease.
        await lease(install.key);
        await replacePackageDirectory(install);
        const before = reserved(killed.runId);

        // Without that lease the update cannot show the driver's children gone; it names repair.
        await expect(nextUpdate(install.slot)).rejects.toThrow(unleased);
        expect(reserved(killed.runId)).toEqual(before);

        await runRepair(install.slot);

        expect(loadPluginCohortRecovery(killed.runId)).toBeUndefined();
        expect(config().gateway).toEqual({ mode: "local" });
        expect(getUpdateRun(killed.runId)).toMatchObject({ status: "failed", reason: "abandoned" });
        expect(getUpdateRun(killed.runId)?.steps).toContainEqual(
          expect.objectContaining({ step: "reconcile:acknowledged", status: "completed" }),
        );
        expect(replacedWarning(killed.runId)).toMatch(/^Plugin recovery was settled \(commit\)/u);

        await nextUpdate(install.slot);
        expect(mocks.proceed).toHaveBeenCalledOnce();
        expect(settled(ctx.admitted[0])).toBeUndefined();
      }));

    // Each control removes one piece of evidence; both entries refuse and change nothing.
    const triage = "Run openclaw triage";
    const wait = {
      update: "By hand: Wait for that update",
      repair: "Wait for that update to finish",
    };
    const notServing = `its update did not record OpenClaw ${candidate} serving.`;
    it.each<{
      name: string;
      dead?: Updater;
      /** Run the dead update from its package directory rather than the install path. */
      fromPackageDirectory?: true;
      keepPrevious?: true;
      otherInstallation?: true;
      control?: (killed: Dead) => unknown;
      why: string;
      next?: { update: string; repair: string };
    }>([
      {
        name: "its updater is still alive",
        dead: { end: "stalled" },
        why: "its update is not known to have exited.",
        next: wait,
      },
      {
        name: "its driver's identity was not recorded",
        control: (killed) =>
          recordUpdateRunStep(killed.runId, {
            step: "driver:identity-unavailable",
            status: "completed",
          }),
        why: "its update is not known to have exited.",
        next: wait,
      },
      {
        name: "its run is no longer recorded as running",
        control: (killed) =>
          finishUpdateRun(killed.runId, { status: "failed", reason: "update-failed" }),
        why: "its update is not recorded as running.",
      },
      {
        name: "it recorded no verification",
        dead: { installed: "candidate", gateway: "stopped" },
        why: notServing,
      },
      {
        name: "it recorded its candidate without a running service",
        control: (killed) =>
          recordUpdateRunVerification(killed.runId, {
            serviceRunning: false,
            versionMatch: true,
            runningVersion: candidate,
            settled: true,
          }),
        why: notServing,
      },
      {
        name: "it recorded another version serving",
        control: (killed) =>
          recordUpdateRunVerification(killed.runId, {
            serviceRunning: true,
            versionMatch: true,
            runningVersion: "2026.11.3",
            settled: true,
          }),
        why: notServing,
      },
      {
        name: "it recorded only its package directory",
        fromPackageDirectory: true,
        why: "its update recorded only that directory, not the install path it ran from.",
      },
      {
        name: "another installation is asking",
        otherInstallation: true,
        why: "which is not this installation.",
      },
    ])("is refused when $name", (control) =>
      fixtures.lifetime.run(async () => {
        const install = await linkedInstallation();
        const killed = await updater(install.key, {
          ...verified,
          ...control.dead,
          ...(control.fromPackageDirectory ? {} : { root: install.slot }),
        });
        await control.control?.(killed);
        await replacePackageDirectory(install);
        const asking = control.otherInstallation
          ? (await linkedInstallation("other")).slot
          : install.slot;
        const before = reserved(killed.runId);
        const next = control.next ?? { update: triage, repair: triage };

        const refusal = `this installation cannot show it replaced that one: `;
        await expect(nextUpdate(asking)).rejects.toThrow(refusal);
        await expect(nextUpdate(asking)).rejects.toThrow(`${control.why} ${triage}`);
        await expect(nextUpdate(asking)).rejects.toThrow(next.update);
        await expect(runRepair(asking)).rejects.toThrow(refusal);
        await expect(runRepair(asking)).rejects.toThrow(`${control.why} ${next.repair}`);

        expect(mocks.proceed).not.toHaveBeenCalled();
        expect(reserved(killed.runId)).toEqual(before);
        expect(replacedWarning(killed.runId)).toBeUndefined();
      }),
    );

    it("keeps today's refusals while its package directory still exists", () =>
      fixtures.lifetime.run(async () => {
        const install = await linkedInstallation();
        const killed = await updater(install.key, { ...verified, root: install.slot });
        await replacePackageDirectory(install, { keepPrevious: true });
        const before = reserved(killed.runId);

        await expect(nextUpdate(install.slot)).rejects.toThrow(
          `It belongs to the installation at ${install.key}. Run openclaw triage for an agent that reads this update history and settles it. By hand: Run ${repair} from that installation.`,
        );
        await expect(runRepair(install.slot)).rejects.toThrow(
          /^Plugin cohort recovery belongs to a different installation\.$/u,
        );

        expect(mocks.proceed).not.toHaveBeenCalled();
        expect(reserved(killed.runId)).toEqual(before);
      }));
  },
);
