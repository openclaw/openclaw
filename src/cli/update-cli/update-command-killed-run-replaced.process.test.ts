import fs from "node:fs";
import path from "node:path";
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
import { writeConfigMachineState } from "../../state/config-machine-state-write.js";
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

        // Recovery settled, the update goes on to prepare its release.
        expect(mocks.release).toHaveBeenCalledOnce();
        expect(loadPluginCohortRecovery(killed.runId)).toBeUndefined();
        // The candidate's plugin and config changes are kept: it was verified serving.
        expect(config().gateway).toEqual({ mode: "local" });
        // The retained warning names the replaced directory, the path and successor, and the version.
        const warning = replacedWarning(killed.runId);
        for (const fact of [home(install.key), home(install.slot), home(successor), candidate]) {
          expect(warning).toContain(fact);
        }
        // History reconciliation then closes the dead run and keeps the warning.
        await reconcileAbandonedUpdateRunsAsync({});
        expect(getUpdateRun(killed.runId)).toMatchObject({ status: "failed", reason: "abandoned" });
        expect(replacedWarning(killed.runId)).toContain(home(install.key));
      }));

    // 2026.11.10 ends this way after losing its plugin lifecycle lease (#205167).
    it("is settled by the next update after its driver released its lease", () =>
      fixtures.lifetime.run(async () => {
        const install = await linkedInstallation();
        const killed = await updater(install.key, { ...verified, root: install.slot });
        // The driver exited through its own unwind, which releases its lease.
        await lease(install.key);
        await replacePackageDirectory(install);

        await nextUpdate(install.slot);

        expect(mocks.release).toHaveBeenCalledOnce();
        expect(loadPluginCohortRecovery(killed.runId)).toBeUndefined();
        expect(config().gateway).toEqual({ mode: "local" });
        expect(replacedWarning(killed.runId)).toMatch(
          /^Plugin recovery was settled from a replacing/u,
        );
        await reconcileAbandonedUpdateRunsAsync({});
        expect(getUpdateRun(killed.runId)).toMatchObject({ status: "failed", reason: "abandoned" });
      }));

    it("finishes a released update that had begun rolling back, as repair would", () =>
      fixtures.lifetime.run(async () => {
        const install = await linkedInstallation();
        const killed = await updater(install.key, { ...verified, root: install.slot });
        // Rollback had restored some state before its updater unwound; the owner would finish it.
        writeConfigMachineState(`update.pluginCohort.${killed.runId}`, {
          ...loadPluginCohortRecovery(killed.runId)!.cohort,
          disposition: "rollback",
        });
        await lease(install.key);
        await replacePackageDirectory(install);

        await nextUpdate(install.slot);

        expect(loadPluginCohortRecovery(killed.runId)).toBeUndefined();
        expect(mocks.release).toHaveBeenCalledOnce();
      }));

    it("leaves a released lease to repair once its verified candidate is no longer installed", () =>
      fixtures.lifetime.run(async () => {
        const install = await linkedInstallation();
        const killed = await updater(install.key, { ...verified, root: install.slot });
        await lease(install.key);
        await replacePackageDirectory(install, { version: "2026.12.2" });
        const before = reserved(killed.runId);

        // Nothing shows the build that update verified is the one installed; it names repair.
        await expect(nextUpdate(install.slot)).rejects.toThrow(unleased);
        expect(reserved(killed.runId)).toEqual(before);

        await runRepair(install.slot);

        expect(loadPluginCohortRecovery(killed.runId)).toBeUndefined();
        expect(config().gateway).toEqual({ mode: "local" });
        expect(getUpdateRun(killed.runId)).toMatchObject({ status: "failed", reason: "abandoned" });
        expect(getUpdateRun(killed.runId)?.steps).toContainEqual(
          expect.objectContaining({ step: "reconcile:acknowledged", status: "completed" }),
        );
        expect(replacedWarning(killed.runId)).toMatch(
          /^Plugin recovery was settled from a replacing/u,
        );

        await nextUpdate(install.slot);
        expect(mocks.release).toHaveBeenCalledOnce();
      }));

    it("finishes a commit the dead update had begun after a later build replaced it", () =>
      fixtures.lifetime.run(async () => {
        const install = await linkedInstallation();
        const killed = await updater(install.key, { ...verified, root: install.slot });
        // It died after selecting commit and before removing its recovery; the operator
        // then installed a later fixed build, which is not the version that update verified.
        writeConfigMachineState(`update.pluginCohort.${killed.runId}`, {
          ...loadPluginCohortRecovery(killed.runId)!.cohort,
          disposition: "commit",
        });
        await replacePackageDirectory(install, { version: "2026.12.2" });

        await runRepair(install.slot);

        expect(loadPluginCohortRecovery(killed.runId)).toBeUndefined();
        expect(config().gateway).toEqual({ mode: "local" });
        expect(replacedWarning(killed.runId)).toContain(`recorded OpenClaw ${candidate} serving.`);
      }));

    // The original core in a fresh directory: committing would keep the candidate's changes over
    // it. Without the original build ID, the same version still does not show that core gone.
    it.each([
      { name: "with the same identity", previousBuildId: undefined },
      { name: "without the build ID it had", previousBuildId: "build-previous" },
    ])(
      "keeps a begun commit's refusal when the earlier version is installed again $name",
      ({ previousBuildId }) =>
        fixtures.lifetime.run(async () => {
          const install = await linkedInstallation();
          if (previousBuildId) {
            fs.writeFileSync(
              path.join(install.key, "dist", "build-info.json"),
              JSON.stringify({ buildId: previousBuildId }),
            );
          }
          const killed = await updater(install.key, { ...verified, root: install.slot });
          writeConfigMachineState(`update.pluginCohort.${killed.runId}`, {
            ...loadPluginCohortRecovery(killed.runId)!.cohort,
            disposition: "commit",
          });
          await replacePackageDirectory(install, { version: "2026.11.3" });
          const before = reserved(killed.runId);

          await expect(runRepair(install.slot)).rejects.toThrow(
            "Plugin cohort commit does not match the installed candidate version and build.",
          );

          expect(reserved(killed.runId)).toEqual(before);
          expect(replacedWarning(killed.runId)).toBeUndefined();
        }),
    );

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
      otherInstallation?: true;
      control?: (killed: Dead) => unknown;
      /** The missing fact, given the install path the dead update ran from. */
      why: string | ((slot: string) => string);
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
        why: (slot) => `its update ran from ${slot}, which is not this installation.`,
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
        const why = typeof control.why === "string" ? control.why : control.why(install.slot);

        const refusal = `which no longer exists, and this installation cannot show it replaced that one: `;
        const updateRefusal = String(await nextUpdate(asking).catch((error: unknown) => error));
        const repairRefusal = String(await runRepair(asking).catch((error: unknown) => error));

        expect(updateRefusal).toContain(`${refusal}${why} ${triage}`);
        expect(updateRefusal).toContain(next.update);
        expect(repairRefusal).toContain(`${refusal}${why} ${next.repair}`);

        expect(mocks.proceed).not.toHaveBeenCalled();
        expect(reserved(killed.runId)).toEqual(before);
        expect(replacedWarning(killed.runId)).toBeUndefined();
      }),
    );

    // A path that cannot be read is not evidence that the directory is gone.
    const keepsTodaysRefusals = (leave: (key: string) => void) =>
      fixtures.lifetime.run(async () => {
        const install = await linkedInstallation();
        const killed = await updater(install.key, { ...verified, root: install.slot });
        await replacePackageDirectory(install, { keepPrevious: true });
        leave(install.key);
        const before = reserved(killed.runId);
        try {
          await expect(nextUpdate(install.slot)).rejects.toThrow(
            `It belongs to the installation at ${install.key}. Run openclaw triage for an agent that reads this update history and settles it. By hand: Run ${repair} from that installation.`,
          );
          await expect(runRepair(install.slot)).rejects.toThrow(
            /^Plugin cohort recovery belongs to a different installation\.$/u,
          );
        } finally {
          // The fixture's cleanup must be able to remove what a case made unsearchable.
          const parent = path.dirname(install.key);
          if (fs.statSync(parent, { throwIfNoEntry: false })?.isDirectory()) {
            fs.chmodSync(parent, 0o755);
          }
        }

        expect(mocks.proceed).not.toHaveBeenCalled();
        expect(reserved(killed.runId)).toEqual(before);
        expect(replacedWarning(killed.runId)).toBeUndefined();
      });

    it.each<{ name: string; leave: (key: string) => void }>([
      { name: "its package directory still exists", leave: () => undefined },
      {
        // lstat fails with ENOTDIR, not ENOENT.
        name: "a file stands where its package directory's parent was",
        leave: (key) => {
          fs.rmSync(path.dirname(key), { recursive: true });
          fs.writeFileSync(path.dirname(key), "");
        },
      },
    ])("keeps today's refusals when $name", ({ leave }) => keepsTodaysRefusals(leave));

    // lstat fails with EACCES; root reads through the mode, so it cannot see this.
    it.skipIf(process.getuid?.() === 0)(
      "keeps today's refusals when its package directory's parent cannot be searched",
      () => keepsTodaysRefusals((key) => fs.chmodSync(path.dirname(key), 0o000)),
    );
  },
);
