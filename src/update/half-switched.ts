// A checkout that tracked `main` between #199706 and #200578 can be left half-switched by its own
// updater: a release it never started is linked at `git-install/lib/node_modules/openclaw`, its
// trial (without `v`) is armed, and the service still starts the checkout's build. That build's
// `update.run` repeats the same failure, and while it serves, this code cannot write the state
// database it has not migrated. So the update is prepared without the database, the service is
// pointed at the launcher, and the run is recorded once the new release serves and owns state.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { resolveServiceEntrypointIndex } from "../daemon/service-layout.js";
import { resolveGatewayService } from "../daemon/service.js";
import { hasErrnoCode } from "../infra/errno.js";
import type { UpdateChannel } from "../infra/update-channels.js";
import { getUpdateRunAsync } from "../infra/update-run-reader.js";
import { createUpdateRunAsync } from "../infra/update-run-write.async.js";
import { createNullWriter } from "../shared/null-writer.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { stageReleaseService } from "./convert-service.js";
import { TRIAL_BUDGET_MS } from "./launcher.js";
import { detectInstall, prepareUpdate, stateUpdateRunLedger, type UpdateRunLedger } from "./run.js";
import { readTrial, resolvePrefix } from "./store.js";

const POLL_MS = 2_000;

async function exists(file: string): Promise<boolean> {
  return await fs.access(file).then(
    () => true,
    (error: unknown) => {
      if (hasErrnoCode(error, "ENOENT")) {
        return false;
      }
      throw error;
    },
  );
}

/**
 * The Gateway serves a checkout build older than the release path, so its `update.run` cannot
 * finish this install: #199706's updater left its trial (no format field), or the launcher
 * rolled a conversion back onto such a build.
 */
export async function needsCheckoutConversion(
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const prefix = resolvePrefix(env);
  const trial: { v?: unknown; phase?: unknown } | null = await readTrial(prefix);
  if (trial !== null && trial.v !== 2) {
    return true;
  }
  if (trial?.phase !== "rolled-back") {
    return false;
  }
  const served = await fs.realpath(path.join(prefix, "openclaw")).catch(() => null);
  return served !== null && !(await exists(path.join(served, "release-launcher-forward.mjs")));
}

/** The checkout's own build, which the service still starts; null fields are unknown. */
async function readServingBuild(checkout: string) {
  try {
    const info: { commit?: unknown; version?: unknown } = JSON.parse(
      await fs.readFile(path.join(checkout, "dist", "build-info.json"), "utf8"),
    );
    return {
      commit: typeof info.commit === "string" ? info.commit : null,
      version: typeof info.version === "string" ? info.version : null,
    };
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return { commit: null, version: null };
    }
    throw error;
  }
}

/**
 * Collects the run's progress; `replay` records it once this process may write state. Outcomes
 * are not replayed: the Gateway that serves the release settles the run, and an earlier
 * interrupted attempt has no row to finish.
 */
function deferredLedger() {
  const writes: Array<(ledger: UpdateRunLedger) => Promise<unknown>> = [];
  let failureDetail: string | undefined;
  const ledger: UpdateRunLedger = {
    phase: async (id, phase, patch) => writes.push((to) => to.phase(id, phase, patch)),
    step: async (id, step) => writes.push((to) => to.step(id, step)),
    finish: async (_id, result) => {
      failureDetail = result.diagnostics?.failure?.detail ?? failureDetail;
    },
  };
  return {
    ledger,
    failureDetail: () => failureDetail,
    replay: async (to: UpdateRunLedger) => {
      for (const write of writes) {
        await write(to);
      }
    },
  };
}

/** Puts back what the earlier updater left, so the next `openclaw update` converts again. */
async function restoreTrial(prefix: string, raw: string | null) {
  const file = path.join(prefix, "releases", ".trial");
  if (raw === null) {
    await fs.rm(file, { force: true });
    return;
  }
  const temporary = `${file}.${process.pid}-${randomUUID()}`;
  await fs.writeFile(temporary, raw, { mode: 0o600 });
  await fs.rename(temporary, file);
}

/** What the service manager actually starts, drop-in overrides included. */
async function serviceStarts(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const command = await resolveGatewayService().readCommand(env, { requireEffective: true });
  const entry = command ? resolveServiceEntrypointIndex(command.programArguments) : undefined;
  return entry === undefined ? undefined : command?.programArguments[entry];
}

/**
 * Converts a half-switched checkout and returns the run ID once the new release serves; the
 * Gateway that serves it settles the run. Throws with what is true when it cannot.
 */
export async function convertHalfSwitchedCheckout(opts: {
  runningRoot: string;
  channel: UpdateChannel;
  sha?: string;
  timeoutMs?: number;
  acceptCapabilities?: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<string> {
  const env = opts.env ?? process.env;
  const started = Date.now();
  const prefix = resolvePrefix(env);
  const install = await detectInstall(opts.runningRoot);
  if (install.kind !== "git" || !install.checkout) {
    throw new Error(`${opts.runningRoot} is not a Git checkout or one of its releases.`);
  }
  const checkout = install.checkout;
  const runId = randomUUID();
  const deferred = deferredLedger();
  const serving = await readServingBuild(checkout);
  const earlierTrial = await fs
    .readFile(path.join(prefix, "releases", ".trial"), "utf8")
    .catch((error: unknown) => {
      if (!hasErrnoCode(error, "ENOENT")) {
        throw error;
      }
      return null;
    });
  // The checkout's build serves and stays the trial's fallback; the release this CLI runs from
  // never started.
  const outcome = await prepareUpdate({
    runId,
    runningRoot: checkout,
    runningVersion: serving.version ?? "unknown",
    channel: opts.channel,
    sha: opts.sha,
    timeoutMs: opts.timeoutMs,
    acceptCapabilities: opts.acceptCapabilities,
    servingCommit: serving.commit,
    deferPlugins: true,
    env,
    ledger: deferred.ledger,
  });
  if (outcome.status === "failed") {
    throw new Error([outcome.message, deferred.failureDetail()].filter(Boolean).join("\n"));
  }
  if (outcome.status === "current") {
    throw new Error(
      `The checkout's own build at ${checkout} is the target commit, so there is no release to switch to yet. The next commit upstream converts this install; nothing changed.`,
    );
  }
  const launcher = path.join(prefix, "openclaw-launcher.mjs");
  try {
    await stageReleaseService({
      runningRoot: checkout,
      launcher,
      env,
      warn: (detail) =>
        void deferred.ledger.step(runId, {
          step: "warning:service-definition",
          status: "completed",
          endedAtMs: Date.now(),
          detail,
        }),
    });
    // The checkout's build cannot forward to the launcher, so the definition itself must.
    const entry = await serviceStarts(env);
    if (entry === undefined || path.resolve(entry) !== launcher) {
      throw new Error(
        `The Gateway service starts ${entry ?? "an entry OpenClaw cannot read"}, not the release launcher, and could not be repointed. Point it at ${launcher}, then run this update again.`,
      );
    }
  } catch (error) {
    // Nothing restarted yet: put the earlier updater's trial back so a retry converts again.
    await restoreTrial(prefix, earlierTrial);
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nThe current version is still running.`,
      { cause: error },
    );
  }
  const statusCommand = `node ${path.join(prefix, "openclaw", "openclaw.mjs")} update status`;
  // From here the launcher owns the trial: it may already have switched and begun the boot
  // migration, and it needs this trial to roll back. Never restore the earlier record after this.
  try {
    await resolveGatewayService().restart({ env, stdout: createNullWriter() });
  } catch (error) {
    throw new Error(
      `The Gateway service restart did not complete (${error instanceof Error ? error.message : String(error)}). If it started, the launcher starts OpenClaw ${outcome.target.version} on trial and rolls back on its own if it does not become ready; check with \`${statusCommand}\`.`,
      { cause: error },
    );
  }
  // The launcher's own trial budget, from the restart, within what remains of --timeout.
  const restartedAt = Date.now();
  const budget = Math.min(
    TRIAL_BUDGET_MS + 60_000,
    opts.timeoutMs === undefined
      ? Number.POSITIVE_INFINITY
      : Math.max(0, opts.timeoutMs - (restartedAt - started)),
  );
  // This conversion's trial names its release; a later update's trial would not.
  const ours = (trial: Awaited<ReturnType<typeof readTrial>>) =>
    trial !== null && path.resolve(prefix, trial.target) === outcome.releaseRoot;
  for (;;) {
    const trial = await readTrial(prefix);
    if (trial && ours(trial) && trial.phase === "committed") {
      break;
    }
    if (trial && ours(trial) && trial.phase === "rolled-back") {
      throw new Error(
        `OpenClaw ${outcome.target.version} did not start (${trial.outcome?.reason ?? "unknown reason"}). The launcher restored the checkout's build and its state, and the next \`openclaw update\` tries again. Run \`openclaw triage\` with this message to find out why it did not start.`,
      );
    }
    if (Date.now() - restartedAt >= budget) {
      throw new Error(
        `OpenClaw ${outcome.target.version} is still starting on trial; the launcher commits it once it is ready or rolls back on its own. Check with \`${statusCommand}\`.`,
      );
    }
    await sleep(POLL_MS);
  }
  // The checkout's own entry points cannot forward to the launcher, and its build cannot open
  // the migrated state; say which entry runs this install now.
  void deferred.ledger.step(runId, {
    step: "warning:checkout-cli",
    status: "completed",
    endedAtMs: Date.now(),
    detail: `Commands that start the checkout's own build at ${checkout}, such as an \`openclaw\` on PATH linked to it, still run version ${serving.version ?? "(unknown)"} and cannot open the upgraded state. Use \`node ${path.join(prefix, "openclaw", "openclaw.mjs")}\`, which follows each new release.`,
  });
  // The new release owns state now, migrated at its boot, so this process's earlier view of the
  // database is gone. Record the run it serves, which its Gateway settles.
  await closeOpenClawStateDatabaseAsync();
  await createUpdateRunAsync(
    { runId, trigger: "cli", ...(serving.version ? { before: { version: serving.version } } : {}) },
    { env },
  );
  try {
    await deferred.replay(stateUpdateRunLedger(env));
  } catch (error) {
    // The serving Gateway may settle the run first; its outcome is the record that matters.
    if ((await getUpdateRunAsync(runId))?.status === "running") {
      throw error;
    }
  }
  return runId;
}
