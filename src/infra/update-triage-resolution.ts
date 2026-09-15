import { UPDATE_RUN_PHASES } from "../../packages/gateway-protocol/src/update-run-vocabulary.js";
import { resolveGatewayRestartProbeContext } from "../cli/daemon-cli/restart-health-probe.js";
import { verifyPreviousGatewayForUpdate } from "../cli/update-cli/update-command-verification.js";
import type { TriageUpdateFailure } from "../commands/triage-update.js";
import { runUtf8CommandWithTimeout } from "../process/exec.js";
import { collectPackageDistContentInventoryErrors } from "./package-dist-inventory.js";
import { readPackageVersion } from "./package-json.js";
import { collectGitRuntimeErrors } from "./update-git-runtime.js";
import { collectInstalledGlobalPackageErrors } from "./update-global.js";
import type { UpdateRepairValidation } from "./update-repair-protocol.js";
import { findActiveUpdateRun, getUpdateRun, listUpdateRuns } from "./update-run-reader.js";
import type { UpdateRunRecord } from "./update-run-record.js";

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
  schema: ["database-schema-preflight"],
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

function unresolved(message: string, stop = true): UpdateRepairValidation {
  const summary = `${message} ${nextUpdate}`;
  return { ok: false, score: -1, summary, ...(stop ? { stopReason: summary } : {}) };
}

type FailureStep = {
  step: string;
  failureFacts?: UpdateRunRecord["steps"][number]["failureFacts"];
  configWriteRefusal?: UpdateRunRecord["steps"][number]["configWriteRefusal"];
};

function doctorStep(step: FailureStep): boolean {
  if (step.configWriteRefusal) {
    return false;
  }
  const facts = step.failureFacts ?? [];
  const doctorFacts = facts.every(
    (fact) =>
      (fact.code === "doctor-failed" && fact.check !== "package-install") ||
      fact.code === "post-plugin-doctor-invalid-config" ||
      (fact.check === "doctor" && fact.code === "finalization-failed"),
  );
  return (
    doctorFacts &&
    (["doctor", "openclaw doctor", "candidate doctor", "finalize:doctor"].includes(step.step) ||
      (step.step === "finalize:targetConfigConvergence" && facts.length > 0))
  );
}

function phaseMarker(step: FailureStep): boolean {
  return (
    !step.failureFacts?.length &&
    !step.configWriteRefusal &&
    (UPDATE_RUN_PHASES.some((phase) => phase === step.step) ||
      step.step === "post-update verification")
  );
}

function doctorFailure(failure: TriageUpdateFailure, run: UpdateRunRecord): boolean {
  if (
    !("result" in failure) ||
    run.status !== "failed" ||
    !failureFamilies.doctor.includes(failure.result.reason ?? run.reason ?? "") ||
    (run.reason !== null && !failureFamilies.doctor.includes(run.reason))
  ) {
    return false;
  }
  const plugins = failure.result.postUpdate?.plugins;
  if (
    plugins?.status === "error" &&
    (!failureFamilies.doctor.includes(plugins.reason ?? "") ||
      plugins.sync?.errors.length ||
      plugins.npm?.outcomes.some((outcome) => outcome.status === "error") ||
      plugins.integrityDrifts?.length ||
      plugins.warnings?.some((warning) => !failureFamilies.doctor.includes(warning.reason)))
  ) {
    return false;
  }
  const steps = run.steps.filter((step) => step.status === "failed" && !phaseMarker(step));
  return (
    steps.length > 0 &&
    steps.every(doctorStep) &&
    failure.result.steps
      .filter((step) => step.exitCode !== 0 && !step.advisory)
      .every(
        (step) =>
          doctorStep({ ...step, step: step.name }) || phaseMarker({ ...step, step: step.name }),
      )
  );
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
  failure: TriageUpdateFailure;
  installRoot: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  validateDoctor: () => Promise<UpdateRepairValidation>;
}): Promise<UpdateRepairValidation> {
  const { failure, installRoot, env, signal } = params;
  signal.throwIfAborted();
  const runId = "result" in failure ? failure.result.runId : undefined;
  const options = { env };
  const original = runId ? getUpdateRun(runId, options) : undefined;
  const target = original?.target;
  if (!original || !target?.kind || !(target.version || (target.kind === "git" && target.sha))) {
    return unresolved("Cannot establish the update target.");
  }
  const completion = listUpdateRuns({ limit: 1 }, options)[0];
  if (findActiveUpdateRun(options)) {
    return unresolved("An update is still running; wait for its owner to finish.");
  }
  if (completion && doctorFailure(failure, original)) {
    const identityMatches = async () =>
      (!target.version || (await readPackageVersion(installRoot)) === target.version) &&
      (!target.sha || (target.kind === "git" && (await readGitHead(params)) === target.sha));
    if (!(await identityMatches())) {
      return unresolved("The installed identity does not match the recorded Doctor repair target.");
    }
    const doctor = await params.validateDoctor();
    signal.throwIfAborted();
    if (!(await identityMatches())) {
      return unresolved("The installed identity changed during Doctor verification.");
    }
    signal.throwIfAborted();
    if (
      findActiveUpdateRun(options) ||
      listUpdateRuns({ limit: 1 }, options)[0]?.runId !== completion.runId
    ) {
      return unresolved("The update owner changed during Doctor verification.");
    }
    return doctor.ok
      ? {
          ok: true,
          score: 0,
          summary: `Doctor/config blocker resolved${target.version ? `; installed version ${target.version} verified` : ""}${target.sha ? `; Git commit ${target.sha} verified` : ""}.`,
        }
      : { ...doctor, summary: `${doctor.summary} ${nextUpdate}` };
  }
  const reason = "result" in failure ? failure.result.reason : undefined;
  const family = Object.entries(failureFamilies).find(
    ([, reasons]) => reason !== undefined && reasons.includes(reason),
  )?.[0];
  if (!family) {
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
    );
  }
  const rolledBack = completion.status === "rolled-back";
  const expected = rolledBack
    ? original.before
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
  const doctor = await params.validateDoctor();
  signal.throwIfAborted();
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
      ("result" in failure && failure.result.postUpdate?.plugins?.status === "error"),
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
  if (
    findActiveUpdateRun(options) ||
    listUpdateRuns({ limit: 1 }, options)[0]?.runId !== completion.runId
  ) {
    return unresolved("The update owner changed during verification.");
  }
  return {
    ok: true,
    score: 0,
    summary: `${rolledBack ? "Rollback" : "Update"} to ${expected.version ?? expected.sha}${expected.version && expected.sha ? ` (${expected.sha})` : ""} recorded by the updater; installed runtime and managed Gateway readiness verified.`,
  };
}
