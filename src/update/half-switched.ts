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
import { resolveConfigPath, resolveStateDir } from "../config/paths.js";
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

/** What the service manager actually starts, drop-in overrides included, and its environment. */
async function inspectService(env: NodeJS.ProcessEnv) {
  const command = await resolveGatewayService().readCommand(env, { requireEffective: true });
  const index = command ? resolveServiceEntrypointIndex(command.programArguments) : undefined;
  return {
    entry: index === undefined ? undefined : command?.programArguments[index],
    env: { ...env, ...command?.environment },
  };
}

async function servesWithoutForwarder(tree: string): Promise<boolean> {
  const served = await fs.realpath(tree).catch(() => null);
  return served !== null && !(await exists(path.join(served, "release-launcher-forward.mjs")));
}

/**
 * Whether the Gateway serves a checkout build older than the release path, whose `update.run`
 * cannot finish this install. "convert": #199706's updater left its trial (no format field) and
 * the service still starts the checkout, or the launcher rolled a conversion back onto such a
 * build. "resume": a conversion pointed the service at the launcher, but the restart into its
 * pending trial did not happen.
 */
export async function checkoutConversion(
  env: NodeJS.ProcessEnv = process.env,
): Promise<"convert" | "resume" | null> {
  const prefix = resolvePrefix(env);
  const trial: { v?: unknown; phase?: unknown; previous?: unknown } | null =
    await readTrial(prefix);
  if (trial === null) {
    return null;
  }
  const launcher = path.join(prefix, "openclaw-launcher.mjs");
  const { entry } = await inspectService(env);
  const startsLauncher = entry !== undefined && path.resolve(entry) === launcher;
  if (trial.v !== 2) {
    // An install #200578 finished already starts the launcher; only a checkout start is stuck.
    return entry !== undefined && !startsLauncher ? "convert" : null;
  }
  if (
    trial.phase === "rolled-back" &&
    (await servesWithoutForwarder(path.join(prefix, "openclaw")))
  ) {
    return "convert";
  }
  if (
    trial.phase === "pending" &&
    startsLauncher &&
    typeof trial.previous === "string" &&
    (await servesWithoutForwarder(path.resolve(prefix, trial.previous)))
  ) {
    return "resume";
  }
  return null;
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
  // The service's Gateway migrates and rolls back the state it is configured with; it must be
  // the state this conversion prepares for and records the run in.
  const service = await inspectService(env);
  for (const [name, mine, theirs] of [
    ["state directory", resolveStateDir(env), resolveStateDir(service.env)],
    ["config", resolveConfigPath(env), resolveConfigPath(service.env)],
  ] as const) {
    if (path.resolve(mine) !== path.resolve(theirs)) {
      throw new Error(
        `The Gateway service uses the ${name} ${theirs}, not ${mine}. Run this update with the same OPENCLAW_STATE_DIR and OPENCLAW_CONFIG_PATH as the service. Nothing changed.`,
      );
    }
  }
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
    const { entry } = await inspectService(env);
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
  await restartIntoTrial({
    env,
    prefix,
    releaseRoot: outcome.releaseRoot,
    version: outcome.target.version,
    started,
    timeoutMs: opts.timeoutMs,
  });
  await recordConvertedRun({
    env,
    prefix,
    runId,
    checkout,
    servingVersion: serving.version,
    deferred,
  });
  return runId;
}

/**
 * Restarts the service into the launcher's pending trial and waits for its outcome. From the
 * restart on, the launcher owns the trial: it may already have switched and begun the boot
 * migration, and needs the trial to roll back, so nothing here restores an earlier record.
 */
async function restartIntoTrial(params: {
  env: NodeJS.ProcessEnv;
  prefix: string;
  releaseRoot: string;
  version: string;
  started: number;
  timeoutMs?: number;
}) {
  const statusCommand = `node ${path.join(params.prefix, "openclaw", "openclaw.mjs")} update status`;
  try {
    await resolveGatewayService().restart({ env: params.env, stdout: createNullWriter() });
  } catch (error) {
    throw new Error(
      `The Gateway service restart did not complete (${error instanceof Error ? error.message : String(error)}). If it started, the launcher starts OpenClaw ${params.version} on trial and rolls back on its own if it does not become ready; check with \`${statusCommand}\`. If it did not start, run this update again to restart into the prepared release.`,
      { cause: error },
    );
  }
  // The launcher's own trial budget, from the restart, within what remains of --timeout.
  const restartedAt = Date.now();
  const budget = Math.min(
    TRIAL_BUDGET_MS + 60_000,
    params.timeoutMs === undefined
      ? Number.POSITIVE_INFINITY
      : Math.max(0, params.timeoutMs - (restartedAt - params.started)),
  );
  // This conversion's trial names its release; a later update's trial would not.
  const ours = (trial: Awaited<ReturnType<typeof readTrial>>) =>
    trial !== null && path.resolve(params.prefix, trial.target) === params.releaseRoot;
  for (;;) {
    const trial = await readTrial(params.prefix);
    if (trial && ours(trial) && trial.phase === "committed") {
      return;
    }
    if (trial && ours(trial) && trial.phase === "rolled-back") {
      throw new Error(
        `OpenClaw ${params.version} did not start (${trial.outcome?.reason ?? "unknown reason"}). The launcher restored the checkout's build and its state, and the next \`openclaw update\` tries again. Run \`openclaw triage\` with this message to find out why it did not start.`,
      );
    }
    if (Date.now() - restartedAt >= budget) {
      throw new Error(
        `OpenClaw ${params.version} is still starting on trial; the launcher commits it once it is ready or rolls back on its own. Check with \`${statusCommand}\`.`,
      );
    }
    await sleep(POLL_MS);
  }
}

/** Records the run once the release owns state; the Gateway that serves it settles the run. */
async function recordConvertedRun(params: {
  env: NodeJS.ProcessEnv;
  prefix: string;
  runId: string;
  checkout: string;
  servingVersion: string | null;
  deferred: ReturnType<typeof deferredLedger>;
}) {
  const { env, runId, deferred } = params;
  // The checkout's own entry points cannot forward to the launcher, and its build cannot open
  // the migrated state; say which entry runs this install now.
  void deferred.ledger.step(runId, {
    step: "warning:checkout-cli",
    status: "completed",
    endedAtMs: Date.now(),
    detail: `Commands that start the checkout's own build at ${params.checkout}, such as an \`openclaw\` on PATH linked to it, still run version ${params.servingVersion ?? "(unknown)"} and cannot open the upgraded state. Use \`node ${path.join(params.prefix, "openclaw", "openclaw.mjs")}\`, which follows each new release.`,
  });
  // The new release migrated state at its boot, so this process's earlier view of the database
  // is gone.
  await closeOpenClawStateDatabaseAsync();
  await createUpdateRunAsync(
    {
      runId,
      trigger: "cli",
      ...(params.servingVersion ? { before: { version: params.servingVersion } } : {}),
    },
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
}

/** Restarts into the trial an earlier conversion published but could not restart into. */
export async function resumeHalfSwitchedCheckout(opts: {
  runningRoot: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}): Promise<string> {
  const env = opts.env ?? process.env;
  const started = Date.now();
  const prefix = resolvePrefix(env);
  const trial = await readTrial(prefix);
  const install = await detectInstall(opts.runningRoot);
  if (!trial || install.kind !== "git" || !install.checkout) {
    throw new Error("There is no prepared release to restart into. Run `openclaw update` again.");
  }
  const serving = await readServingBuild(install.checkout);
  await restartIntoTrial({
    env,
    prefix,
    releaseRoot: path.resolve(prefix, trial.target),
    version: trial.version,
    started,
    timeoutMs: opts.timeoutMs,
  });
  await recordConvertedRun({
    env,
    prefix,
    runId: trial.runId,
    checkout: install.checkout,
    servingVersion: serving.version,
    deferred: deferredLedger(),
  });
  return trial.runId;
}
