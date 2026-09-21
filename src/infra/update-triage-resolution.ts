import { resolveGatewayRestartProbeContext } from "../cli/daemon-cli/restart-health-probe.js";
import { verifyPreviousGatewayForUpdate } from "../cli/update-cli/update-command-verification.js";
import type { TriageUpdateFailure } from "../commands/triage-update.js";
import { runUtf8CommandWithTimeout } from "../process/exec.js";
import {
  formatDeferredPluginMigration,
  readDeferredPluginMigrations,
} from "./deferred-plugin-migrations.js";
import { collectPackageDistContentInventoryErrors } from "./package-dist-inventory.js";
import { readPackageVersion } from "./package-json.js";
import { compareSemverStrings } from "./update-check.js";
import { collectGitRuntimeErrors } from "./update-git-runtime.js";
import { collectInstalledGlobalPackageErrors } from "./update-global.js";
import type { UpdateRepairValidation } from "./update-repair-protocol.js";
import {
  findActiveUpdateRun,
  getUpdateRun,
  readUpdateRunResolutionHistory,
} from "./update-run-reader.js";
import { isAcknowledgedAbandonedUpdateRun, type UpdateRunRecord } from "./update-run-record.js";

function matchesIdentity(
  expected: UpdateRunRecord["after"],
  observed: UpdateRunRecord["after"],
): boolean {
  return (
    (!expected.version || expected.version === observed.version) &&
    (!expected.sha || expected.sha === observed.sha)
  );
}

const failureFamilies = {
  package: ["global-install-failed", "runtime-verification-failed"],
  acquisition: [
    "fetch-failed",
    "no-release-tag",
    "no-target-sha",
    "target-metadata-preflight",
    "dirty",
    "clean-check-failed",
    "preflight-remote-failed",
    "preflight-revlist-failed",
    "preflight-worktree-failed",
    "preflight-no-candidates",
    "preflight-no-good-commit",
    "preflight-insufficient-space",
    "preflight-node-runtime-incompatible",
  ],
  checkout: [
    "checkout-failed",
    "doctor-entry-missing",
    "ui-assets-missing",
    "ui-build-failed",
    "head-verification-failed",
    "target-sha-mismatch",
  ],
  schema: ["database-schema-preflight", "invalid-config"],
  doctor: [
    "post-update-failed",
    "doctor-failed",
    "repair-requires-config-change",
    "finalize:doctor",
    "finalize:targetConfigConvergence",
    "post-plugin-doctor-invalid-config",
    "post-update-plugins",
  ],
  service: [
    "managed-service-preflight",
    "service-revalidation-failed",
    "restart-unhealthy",
    "version-mismatch",
    "build-id-mismatch",
    "plugin-errors",
    "channel-errors",
    "readyz-unhealthy",
    "service-not-running",
  ],
};

const nextUpdate = "Next step: run `openclaw update status --json`, then retry `openclaw update`.";
const nextRepair = "Next step: run `openclaw update status --json`, then `openclaw update repair`.";

function unresolved(message: string, stop = true, nextStep = nextUpdate): UpdateRepairValidation {
  // Triage bounds displayed diagnostics; retain the next action before long findings.
  const summary = `${nextStep} ${message}`;
  return { ok: false, score: -1, summary, ...(stop ? { stopReason: summary } : {}) };
}

function validateTriagePendingMigrations(
  env: NodeJS.ProcessEnv,
): UpdateRepairValidation | undefined {
  const warnings = readDeferredPluginMigrations({ env }).map((pending) =>
    formatDeferredPluginMigration(pending, env),
  );
  return warnings.length > 0 ? unresolved(warnings.join(" "), true, nextRepair) : undefined;
}

async function readGitHead(params: {
  installRoot: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
}): Promise<string | undefined> {
  const head = await runUtf8CommandWithTimeout(
    ["git", "-C", params.installRoot, "rev-parse", "HEAD"],
    {
      signal: params.signal,
      env: params.env,
      input: "",
      killProcessTree: true,
      maxOutputBytes: 4096,
      terminateOnOutputLimit: true,
    },
  );
  params.signal.throwIfAborted();
  return head.code === 0 && head.termination === "exit" && !head.outputLimitExceeded
    ? head.stdout.trim() || undefined
    : undefined;
}

/** Resolve the attributed blocker without rewriting the updater's historical outcome. */
export async function validateTriageUpdateResolution(params: {
  failure?: TriageUpdateFailure;
  implicit?: boolean;
  installRoot: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  validateDoctor: () => Promise<UpdateRepairValidation>;
}): Promise<UpdateRepairValidation> {
  const { failure, installRoot, env, signal } = params;
  signal.throwIfAborted();
  const migrationFailure = validateTriagePendingMigrations(env);
  if (migrationFailure) {
    return migrationFailure;
  }
  const runId = failure && "result" in failure ? failure.result.runId : undefined;
  const options = { env };
  let history: ReturnType<typeof readUpdateRunResolutionHistory>;
  try {
    history = readUpdateRunResolutionHistory(options);
  } catch (error) {
    return unresolved(`Update history is unavailable: ${String(error)}`, true, nextRepair);
  }
  const original =
    (params.implicit ? history.failure : undefined) ??
    (runId ? getUpdateRun(runId, options) : undefined);
  const ownerChanged = () =>
    findActiveUpdateRun(options) ||
    readUpdateRunResolutionHistory(options).outcome?.runId !== history.outcome?.runId;
  const validateDoctor = async () => {
    const doctor = await params.validateDoctor();
    signal.throwIfAborted();
    return ownerChanged()
      ? unresolved("The update owner changed during verification.")
      : (validateTriagePendingMigrations(env) ?? doctor);
  };
  if (findActiveUpdateRun(options)) {
    return unresolved("An update is still running; wait for its owner to finish.");
  }
  if ((!failure && !original) || (original && isAcknowledgedAbandonedUpdateRun(original))) {
    return await validateDoctor();
  }
  let target = original?.target;
  if (!original || !target?.kind || !(target.version || (target.kind === "git" && target.sha))) {
    return unresolved("Cannot establish the update target.", true, nextRepair);
  }
  const completion = history.outcome;
  const rolledBack = completion?.status === "rolled-back";
  const superseded =
    params.implicit &&
    completion &&
    (completion.status === "succeeded" || rolledBack) &&
    completion.finishedAtMs !== null &&
    completion.createdAtMs >= original.createdAtMs &&
    completion.target.kind &&
    (completion.target.version || completion.target.sha) &&
    (matchesIdentity(target, completion.after) ||
      (compareSemverStrings(completion.after.version ?? null, target.version ?? null) ?? -1) >= 0);
  if (superseded) {
    target = completion.target;
  }
  const reason =
    original.reason ?? (failure && "result" in failure ? failure.result.reason : undefined);
  const family = Object.entries(failureFamilies).find(
    ([, reasons]) => reason !== undefined && reasons.includes(reason),
  )?.[0];
  if (!family && !superseded) {
    return unresolved(
      `No resolution predicate for update failure ${reason ?? "without a recorded reason"}.`,
    );
  }

  // Do not reinterpret a terminal failed row. A later owner completion is the
  // evidence for acquisition, schema admission, finalization, and recovery.
  if (
    !completion ||
    completion.finishedAtMs === null ||
    completion.createdAtMs < original.createdAtMs ||
    completion.target.kind !== target.kind ||
    (completion.status !== "succeeded" && completion.status !== "rolled-back")
  ) {
    return unresolved(
      `The updater has not recorded a completed resolution of the ${family} failure for ${target.sha ?? target.version}.`,
      true,
      family === "doctor" ? nextRepair : nextUpdate,
    );
  }
  const expected = rolledBack
    ? superseded
      ? completion.before
      : original.before
    : superseded
      ? completion.after
      : {
          version: target.version ?? completion.after.version,
          sha: target.sha ?? completion.after.sha,
        };
  if (
    !(expected.version || expected.sha) ||
    !matchesIdentity(expected, completion.after) ||
    !(rolledBack
      ? matchesIdentity(target, completion.target)
      : matchesIdentity(completion.target, completion.after)) ||
    (rolledBack &&
      !completion.steps.some(
        (step) => step.step === "package rollback" && step.status === "completed",
      ))
  ) {
    return unresolved("The updater has not verified the requested version or package rollback.");
  }
  signal.throwIfAborted();
  const installedVersion = await readPackageVersion(installRoot);
  if (!installedVersion || (expected.version && installedVersion !== expected.version)) {
    return unresolved(
      `Expected installed version ${expected.version ?? "from the verified checkout"}; found ${installedVersion ?? "no installed version"}.`,
    );
  }
  const doctor = await validateDoctor();
  if (!doctor.ok) {
    return { ...doctor, summary: `${doctor.summary} ${nextUpdate}` };
  }
  let errors: string[];
  if (target.kind === "git") {
    const head = await readGitHead(params);
    if (!head || (expected.sha && head !== expected.sha)) {
      return unresolved("The checkout does not match the updater's recorded commit.");
    }
    errors = await collectGitRuntimeErrors({ root: installRoot, sha: head });
  } else {
    errors = await collectInstalledGlobalPackageErrors({
      packageRoot: installRoot,
      expectedVersion: expected.version,
    });
    errors.push(...(await collectPackageDistContentInventoryErrors(installRoot)));
  }
  signal.throwIfAborted();
  if (errors.length) {
    return {
      ...unresolved(
        `Installed runtime verification failed: ${errors.slice(0, 3).join("; ")}`,
        false,
      ),
      score: -errors.length,
    };
  }
  const { config } = await resolveGatewayRestartProbeContext(env);
  const serviceVerified = await verifyPreviousGatewayForUpdate({
    root: installRoot,
    config,
    env,
    opts: {},
    signal,
    expectedVersion: installedVersion,
    requirePluginHealth:
      reason === "plugin-errors" ||
      reason === "post-update-plugins" ||
      (failure && "result" in failure && failure.result.postUpdate?.plugins?.status === "error"),
  });
  signal.throwIfAborted();
  if (!serviceVerified) {
    return unresolved(
      "The managed Gateway's installation, running version, and readiness are not verified.",
    );
  }
  if ((await readPackageVersion(installRoot)) !== installedVersion) {
    return unresolved("The installed version changed during verification.");
  }
  signal.throwIfAborted();
  if (ownerChanged()) {
    return unresolved("The update owner changed during verification.");
  }
  return (
    validateTriagePendingMigrations(env) ?? {
      ok: true,
      score: 0,
      summary: `${rolledBack ? "Rollback" : "Update"} to ${expected.version ?? expected.sha}${expected.version && expected.sha ? ` (${expected.sha})` : ""} recorded by the updater; installed runtime and managed Gateway readiness verified.`,
    }
  );
}
