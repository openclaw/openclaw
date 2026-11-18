import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { withUpdateCommandExecutor } from "../cli/update-cli/update-command-executor.js";
import { readPackageUpdateIdentity } from "../cli/update-cli/update-command-package-identity.js";
import { createConfigIO } from "../config/io.factory.js";
import { withPluginCohortConfigCapture } from "../config/plugin-cohort-recovery.js";
import { beginUpdatePluginCohort } from "../plugins/update-cohort-recovery.js";
import { readUpdateRunDriver } from "./update-run-driver.js";
import {
  adoptUpdateRun,
  createUpdateRun,
  recordUpdateRunPhase,
  recordUpdateRunStep,
  recordUpdateRunVerification,
} from "./update-run-ledger.js";

// Runs, in a child, the part of `openclaw update` that leaves recovery behind when
// its process dies: it claims the installation under the executor `authority`
// names, admits its run, reserves the plugin cohort and publishes one config
// change under it. The options say what else that update had done by then:
// `trigger` is what started it (`api` for one the Gateway started), `gateway`
// set to `stopped` records the managed Gateway stop that precedes activation
// and `restarted` also the verified restart that follows it, and `installed`
// set to `candidate` puts the candidate's version in the package, as the core
// mutation does. For a source checkout, `checkout` names the built candidate
// commit: the child checks it out and installs its build before the cohort, as
// the Git activation does, and records the activation fact unless `marker` is
// `none` (an older updater) or names another build. `end` set to `killed` then
// SIGKILLs the child; `stalled` reports and stays alive until its parent kills it.
const [installKey, authority, options] = process.argv.slice(2);
assert(installKey && authority && options);
const { end, candidate, installed, trigger, gateway, checkout } = JSON.parse(options) as {
  end: "killed" | "stalled";
  candidate: string;
  installed: "previous" | "candidate";
  trigger: "cli" | "api";
  gateway: "untouched" | "stopped" | "restarted";
  checkout?: { sha: string; buildId: string; marker?: "none" | { buildId: string } };
};
const manifest = path.join(installKey, "package.json");
const { version, buildId = null } = await readPackageUpdateIdentity(installKey);
assert(version);
const runtime = { root: installKey, nodePath: process.execPath };
const ledger = { env: process.env };
const runId = randomUUID();

await withUpdateCommandExecutor(
  runId,
  async (executor) => {
    const fence = await executor.enter(installKey);
    createUpdateRun({ runId, trigger, origin: { driver: readUpdateRunDriver() } }, ledger);
    adoptUpdateRun(runId, ledger);
    recordUpdateRunPhase(runId, "activating", {}, ledger);
    if (checkout) {
      execFileSync("git", ["-C", installKey, "checkout", "-q", "--detach", checkout.sha]);
      const build = { commit: checkout.sha, buildId: checkout.buildId };
      fs.writeFileSync(path.join(installKey, "dist", "build-info.json"), JSON.stringify(build));
      const { marker = { buildId: checkout.buildId } } = checkout;
      if (marker !== "none") {
        const gitActivation = {
          sha: checkout.sha,
          buildId: marker.buildId,
          previousBuildId: buildId,
        };
        recordUpdateRunPhase(runId, "activating", { origin: { gitActivation } }, ledger);
      }
    }
    const cohort = { runId, installKey, env: process.env };
    await beginUpdatePluginCohort({
      ...cohort,
      fence,
      from: { ...runtime, version, buildId },
      to: { ...runtime, version: candidate, buildId: checkout?.buildId ?? null },
    });
    if (gateway !== "untouched") {
      const stopped = { step: "service-stop", status: "completed", endedAtMs: Date.now() } as const;
      recordUpdateRunStep(runId, stopped, ledger);
    }
    await withPluginCohortConfigCapture({ ...cohort, assertCurrent: fence.assertCurrent }, () =>
      createConfigIO({ env: process.env, pluginValidation: "skip" }).writeConfigFile({
        plugins: { enabled: false },
        gateway: { mode: "local" },
      }),
    );
    if (installed === "candidate" && !checkout) {
      const installedManifest = JSON.parse(fs.readFileSync(manifest, "utf8"));
      fs.writeFileSync(manifest, JSON.stringify({ ...installedManifest, version: candidate }));
    }
    if (gateway === "restarted") {
      const serving = {
        serviceRunning: true,
        versionMatch: true,
        runningVersion: candidate,
        ...(checkout ? { runningBuildId: checkout.buildId } : {}),
      };
      recordUpdateRunVerification(runId, { ...serving, settled: true }, ledger);
    }
    fs.writeSync(1, `${JSON.stringify({ runId })}\n`);
    if (end === "killed") {
      process.kill(process.pid, "SIGKILL");
    }
    // A stalled updater keeps its claim and its driver identity until it is killed.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  },
  { existingAuthority: JSON.parse(authority) },
);
