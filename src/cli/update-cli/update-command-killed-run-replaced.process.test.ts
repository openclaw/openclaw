import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PLUGIN_COHORT_REPLACED_INSTALLATION_STEP } from "../../infra/update-run-codec.js";
import {
  finishUpdateRun,
  getUpdateRun,
  reconcileAbandonedUpdateRunsAsync,
  recordUpdateRunStep,
  recordUpdateRunVerification,
} from "../../infra/update-run-ledger.js";
import { loadPluginCohortRecovery } from "../../infra/update-run-recovery-store.js";
import { loadUpdateRecovery } from "../../infra/update-run-recovery.js";
import { writeConfigMachineState } from "../../state/config-machine-state-write.js";
import {
  beginRollback,
  candidate,
  config,
  ctx,
  fixtures,
  lease,
  linkedInstallation,
  loseStore,
  mocks,
  nextUpdate,
  replacePackageDirectory,
  repair,
  reserved,
  servingGateway,
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
const notServingNow = new RegExp(
  `released its lease.*the managed Gateway is not serving OpenClaw ${candidate}.*By hand: Run openclaw update repair`,
  "u",
);
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
        expect(settled(ctx.admitted[0])).toMatch(
          /kept, because its Gateway was verified on the version it installed, which this installation replaced/u,
        );
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

    // The driver unwound through its own executor, which releases its lease only once
    // its children are settled: the update lease store that held it shows them gone.
    const build = "build-candidate";
    const released: Updater = { ...verified, end: "released", candidateBuildId: build };
    const releasedUpdate = async (dead: Updater = {}) => {
      const install = await linkedInstallation();
      const killed = await updater(install.key, { ...released, ...dead, root: install.slot });
      const successor = await replacePackageDirectory(install, { buildId: build });
      return { install, killed, successor };
    };

    it("is settled by the next update after its driver released its lease, while the Gateway serves its candidate", () =>
      fixtures.lifetime.run(async () => {
        const { install, killed } = await releasedUpdate();
        servingGateway(candidate, build);

        await nextUpdate(install.slot);

        expect(mocks.proceed).toHaveBeenCalledOnce();
        expect(loadPluginCohortRecovery(killed.runId)).toBeUndefined();
        expect(loadUpdateRecovery(killed.runId)).toBeUndefined();
        expect(config().gateway).toEqual({ mode: "local" });
        expect(settled(ctx.admitted[0])).toMatch(
          new RegExp(
            `^Settled interrupted update ${killed.runId}: .*kept, because its Gateway was verified on the version it installed.*its updater had released its lease, and the managed Gateway was found serving that version now`,
            "u",
          ),
        );
        // The admitted update's history reconciliation closes the run as the success it was.
        await reconcileAbandonedUpdateRunsAsync({});
        const run = getUpdateRun(killed.runId);
        expect(run).toMatchObject({ status: "succeeded", after: { version: candidate } });
        expect(run?.steps).toContainEqual(
          expect.objectContaining({
            step: "warning:reconcile:driver-lost-after-verification",
            status: "completed",
          }),
        );
      }));

    // A fresh probe must find the candidate serving; otherwise repair finishes the update.
    it.each([
      { name: "is not ready", version: candidate, buildId: build, ready: false },
      { name: "serves another build", version: candidate, buildId: "build-other", ready: true },
      { name: "serves another version", version: "2026.11.3", buildId: build, ready: true },
    ])(
      "is left to repair after its driver released its lease when the Gateway $name",
      ({ version, buildId, ready }) =>
        fixtures.lifetime.run(async () => {
          const { install, killed } = await releasedUpdate();
          servingGateway(version, buildId, { ready });
          const before = reserved(killed.runId);

          await expect(nextUpdate(install.slot)).rejects.toThrow(notServingNow);
          expect(reserved(killed.runId)).toEqual(before);
          expect(mocks.proceed).not.toHaveBeenCalled();

          await runRepair(install.slot);

          expect(loadPluginCohortRecovery(killed.runId)).toBeUndefined();
          expect(config().gateway).toEqual({ mode: "local" });
          expect(getUpdateRun(killed.runId)?.steps).toContainEqual(
            expect.objectContaining({ step: "reconcile:acknowledged", status: "completed" }),
          );
          expect(replacedWarning(killed.runId)).toMatch(
            /^Plugin recovery was settled from a replacing/u,
          );

          await nextUpdate(install.slot);
          expect(mocks.proceed).toHaveBeenCalledOnce();
          expect(settled(ctx.admitted[0])).toBeUndefined();
        }),
    );

    // Each control takes away one fact the released lease's proof stands on.
    it.each<{ name: string; dead?: Updater; control?: (killed: Dead) => unknown; refusal: RegExp }>(
      [
        {
          // A store created since the run recorded nothing of that updater's children.
          name: "the update lease store was removed after it ran",
          control: () => loseStore(),
          refusal: unleased,
        },
        {
          name: "a new update lease store replaced the one that held its lease",
          control: async (killed) => {
            await loseStore();
            await lease(killed.slot);
          },
          refusal: unleased,
        },
        {
          name: "it recorded no build for its candidate",
          dead: { candidateBuildId: undefined },
          refusal: unleased,
        },
        {
          name: "it had begun rolling back",
          control: (killed) => beginRollback(killed),
          refusal: unleased,
        },
        {
          name: "the Gateway started it",
          dead: { trigger: "api" },
          refusal: /not left by a killed openclaw update command/u,
        },
      ],
    )(
      "still refuses after its driver released its lease when $name",
      ({ dead, control, refusal }) =>
        fixtures.lifetime.run(async () => {
          const { install, killed } = await releasedUpdate(dead);
          await control?.(killed);
          servingGateway(candidate, build);
          const before = reserved(killed.runId);

          await expect(nextUpdate(install.slot)).rejects.toThrow(refusal);

          expect(mocks.proceed).not.toHaveBeenCalled();
          expect(reserved(killed.runId)).toEqual(before);
          expect(replacedWarning(killed.runId)).toBeUndefined();
        }),
    );

    // A host that reports no creation time cannot show the store is the one that held the lease.
    it("still refuses after its driver released its lease when the host reports no creation time for the update lease store", () =>
      fixtures.lifetime.run(async () => {
        const { install, killed } = await releasedUpdate();
        servingGateway(candidate, build);
        const { databasePath } = await lease(path.join(ctx.root, "unrelated"));
        const statSync = fs.statSync;
        const unborn = vi.spyOn(fs, "statSync").mockImplementation(((
          file: fs.PathLike,
          options?: fs.StatSyncOptions,
        ) => {
          const stat = statSync(file, options);
          return stat && fs.realpathSync(file) === databasePath
            ? Object.assign(stat, { birthtimeMs: 0 })
            : stat;
        }) as typeof fs.statSync);
        const before = reserved(killed.runId);
        try {
          await expect(nextUpdate(install.slot)).rejects.toThrow(unleased);
        } finally {
          unborn.mockRestore();
        }

        expect(mocks.proceed).not.toHaveBeenCalled();
        expect(reserved(killed.runId)).toEqual(before);
      }));

    it("still refuses after its driver released its lease when the version it replaced is installed again", () =>
      fixtures.lifetime.run(async () => {
        const install = await linkedInstallation();
        const killed = await updater(install.key, { ...released, root: install.slot });
        await replacePackageDirectory(install, { version: "2026.11.3" });
        servingGateway(candidate, build);
        const before = reserved(killed.runId);

        await expect(nextUpdate(install.slot)).rejects.toThrow(unleased);

        expect(mocks.proceed).not.toHaveBeenCalled();
        expect(reserved(killed.runId)).toEqual(before);
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
