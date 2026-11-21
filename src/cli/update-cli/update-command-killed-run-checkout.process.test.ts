import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getUpdateRun } from "../../infra/update-run-ledger.js";
import { loadPluginCohortRecovery } from "../../infra/update-run-recovery-store.js";
import {
  checkoutState,
  config,
  ctx,
  finalization,
  finalizationRuns,
  fixtures,
  git,
  killedCheckout,
  laterBoot,
  linux,
  mocks,
  nextUpdate,
  rebooted,
  reserved,
  settled,
  shape,
  writeBuild,
} from "./update-command-killed-run.process.test-support.js";
import { updateRepairCommand } from "./update-repair-command.js";

// The Git gate: a checkout's cohort settles like a package's only while the checkout
// still holds exactly the build the killed update recorded activating.
describe.skipIf(process.platform === "win32")(
  "next update after a killed source checkout update",
  () => {
    it("keeps the plugin changes of a dead update whose build was verified serving", () =>
      fixtures.lifetime.run(async () => {
        const killed = await killedCheckout({ gateway: "restarted" });

        await nextUpdate(killed.slot);

        expect(mocks.proceed).toHaveBeenCalledOnce();
        expect(loadPluginCohortRecovery(killed.runId)).toBeUndefined();
        expect(config().gateway).toEqual({ mode: "local" });
        expect(settled(ctx.admitted[0])).toMatch(/kept, because its Gateway was verified/u);
        // Nothing was left to finish: no repair-shaped run, and the checkout is as it was.
        expect(finalizationRuns()).toEqual([]);
        expect(git(killed.slot, "rev-parse", "HEAD")).toBe(killed.sha);
      }));

    it("finishes a dead update that installed its build unconfirmed as repair does", () =>
      fixtures.lifetime.run(async () => {
        const killed = await killedCheckout();

        await nextUpdate(killed.slot);

        expect(mocks.proceed).toHaveBeenCalledOnce();
        expect(ctx.observedAtAdmission).toEqual([{ doctor: 1, json: 0, started: 0 }]);
        expect(loadPluginCohortRecovery(killed.runId)).toBeUndefined();
        // Rolled back for the original core, then converged forward on the installed build.
        expect(config()).toEqual({ plugins: { enabled: false } });
        expect(ctx.admitted[0]?.packageActivationSteps?.map((step) => step.name)).toEqual([
          "interrupted-update-recovery",
          "interrupted-update-finalization",
        ]);
        expect(finalizationRuns()).toEqual([
          expect.objectContaining({ trigger: "cli", status: "succeeded" }),
        ]);
        expect(getUpdateRun(killed.runId)).toMatchObject({ status: "failed", reason: "abandoned" });
        expect(git(killed.slot, "rev-parse", "HEAD")).toBe(killed.sha);
      }));

    // The restart rule shows the updater's processes gone; the checkout gates still prove its build.
    it("finishes a dead update killed before the machine restarted as repair does", () =>
      fixtures.lifetime.run(async () => {
        const killed = await killedCheckout();
        await rebooted([linux()], linux(laterBoot))(killed);

        await nextUpdate(killed.slot);

        expect(mocks.proceed).toHaveBeenCalledOnce();
        expect(loadPluginCohortRecovery(killed.runId)).toBeUndefined();
        expect(config()).toEqual({ plugins: { enabled: false } });
        expect(ctx.admitted[0]?.packageActivationSteps?.map((step) => step.name)).toEqual([
          "interrupted-update-recovery",
          "interrupted-update-finalization",
        ]);
        expect(git(killed.slot, "rev-parse", "HEAD")).toBe(killed.sha);
      }));

    it("records what repair records for a dead update that installed its build unconfirmed", () =>
      fixtures.lifetime.run(async () => {
        const finished = await killedCheckout();
        await nextUpdate(finished.slot);
        const [stage] = finalizationRuns();
        const repaired = await killedCheckout({}, undefined, { name: "repaired" });
        mocks.root.mockResolvedValue(repaired.slot);

        await updateRepairCommand({ json: true, yes: true });

        const [repairRun] = finalizationRuns();
        expect(repairRun?.runId).not.toBe(stage?.runId);
        expect(shape(stage)).toEqual(shape(repairRun));
        expect(loadPluginCohortRecovery(repaired.runId)).toBeUndefined();
        expect(shape(getUpdateRun(finished.runId))).toEqual(shape(getUpdateRun(repaired.runId)));
      }));

    // Each control leaves the checkout's build unproven; the update must not touch it.
    type Checkout = Awaited<ReturnType<typeof killedCheckout>>;
    /** The update refuses for `refusal` and leaves recovery, config and checkout as they were. */
    async function expectCheckoutRefusal(killed: Checkout, refusal: RegExp) {
      const before = { ...reserved(killed.runId), checkout: checkoutState(killed.slot) };
      const refused = new RegExp(
        `left by an update of a source checkout.*${refusal.source}.*Run openclaw update repair`,
        "u",
      );

      await expect(nextUpdate(killed.slot)).rejects.toThrow(refused);

      expect(mocks.proceed).not.toHaveBeenCalled();
      expect(finalization.doctor).not.toHaveBeenCalled();
      expect({ ...reserved(killed.runId), checkout: checkoutState(killed.slot) }).toEqual(before);
    }
    it.each<{
      name: string;
      refusal: RegExp;
      marker?: "none" | { buildId?: string; previousBuildId?: string };
      build?: { candidateVersion: string; buildId: string };
      control?: (killed: Checkout) => unknown;
    }>([
      {
        // Runs recorded by an updater that predates the activation fact.
        name: "the dead update recorded no activated build",
        refusal: /did not record which build it activated/u,
        marker: "none",
      },
      {
        name: "the recorded build is not the plugin recovery's target",
        refusal: /recorded build does not match its plugin recovery/u,
        marker: { buildId: "build-other" },
      },
      {
        name: "the recorded previous build is not the plugin recovery's origin",
        refusal: /recorded build does not match its plugin recovery/u,
        marker: { previousBuildId: "build-other" },
      },
      {
        // An explicitly configured build ID: settlement would take the candidate for the original.
        name: "the activated build has the version and build ID of the build it replaced",
        refusal: /same version and build ID as the build it replaced/u,
        build: { candidateVersion: "2026.11.3", buildId: "build-previous" },
      },
      {
        name: "the checkout was moved to another commit",
        refusal: /no longer at the commit that update activated/u,
        control: (killed) => git(killed.slot, "checkout", "-q", killed.previous),
      },
      {
        name: "the checkout has an untracked file",
        refusal: /checkout has local changes/u,
        control: (killed) => fs.writeFileSync(path.join(killed.slot, "notes.txt"), "operator\n"),
      },
      {
        name: "the machine restarted and the checkout has an untracked file",
        refusal: /checkout has local changes/u,
        control: async (killed) => {
          await rebooted([linux()], linux(laterBoot))(killed);
          fs.writeFileSync(path.join(killed.slot, "notes.txt"), "operator\n");
        },
      },
      {
        name: "a tracked file was edited",
        refusal: /checkout has local changes/u,
        control: (killed) => fs.appendFileSync(path.join(killed.slot, "package.json"), "\n"),
      },
      {
        name: "the build is missing",
        refusal: /build is missing, incomplete or not built from the checked-out commit/u,
        control: (killed) => fs.rmSync(path.join(killed.slot, "dist", "build-info.json")),
      },
      {
        name: "the build is incomplete",
        refusal: /build is missing, incomplete or not built from the checked-out commit/u,
        control: (killed) => fs.rmSync(path.join(killed.slot, "dist", "entry.js")),
      },
      {
        name: "the build was made from another commit",
        refusal: /build is missing, incomplete or not built from the checked-out commit/u,
        control: (killed) => writeBuild(killed.slot, killed.previous, killed.buildId),
      },
      {
        name: "the checkout was rebuilt by hand",
        refusal: /build is not the one that update activated/u,
        control: (killed) => writeBuild(killed.slot, killed.sha, "build-rebuilt"),
      },
    ])("still refuses when $name", ({ refusal, marker, build, control }) =>
      fixtures.lifetime.run(async () => {
        const killed = await killedCheckout({}, marker, build);
        await control?.(killed);
        await expectCheckoutRefusal(killed, refusal);
      }),
    );

    it("inspects a partial clone without fetching from its promisor remote", () =>
      fixtures.lifetime.run(async () => {
        const killed = await killedCheckout();
        // The checkout's remote holds a blob this clone never fetched, and a staged rename
        // names it: comparing the rename needs that blob.
        const remote = path.join(ctx.root, "remote.git");
        execFileSync("git", ["clone", "-q", "--bare", killed.slot, remote]);
        const missing = execFileSync("git", ["--git-dir", remote, "hash-object", "-w", "--stdin"], {
          input: JSON.stringify({ name: "openclaw", version: "2026.12.2" }),
          encoding: "utf8",
        }).trim();
        const tree = execFileSync("git", ["--git-dir", remote, "mktree"], {
          input: `100644 blob ${missing}\trenamed.json\n`,
          encoding: "utf8",
        }).trim();
        const commit = git(remote, "commit-tree", tree, "-m", "remote only");
        git(remote, "update-ref", "refs/heads/remote-only", commit);
        git(killed.slot, "remote", "add", "origin", remote);
        git(killed.slot, "config", "remote.origin.promisor", "true");
        git(killed.slot, "config", "remote.origin.partialclonefilter", "blob:none");
        git(killed.slot, "config", "extensions.partialClone", "origin");
        git(killed.slot, "rm", "-q", "--cached", "package.json");
        git(killed.slot, "update-index", "--add", "--cacheinfo", `100644,${missing},renamed.json`);
        const local = () =>
          execFileSync("git", ["-C", killed.slot, "cat-file", "-e", missing], {
            env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "" },
            stdio: "ignore",
          });
        expect(local).toThrow();
        const before = reserved(killed.runId);

        await expect(nextUpdate(killed.slot, { dryRun: true })).rejects.toThrow(
          /left by an update of a source checkout, and the checkout has local changes/u,
        );

        // The refusal fetched nothing: the blob is still only on the remote.
        expect(local).toThrow();
        expect(reserved(killed.runId)).toEqual(before);
        expect(mocks.proceed).not.toHaveBeenCalled();
      }));
  },
);
