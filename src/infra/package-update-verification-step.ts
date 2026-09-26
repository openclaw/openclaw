import { isDeepStrictEqual } from "node:util";
import { hasCommandProcessCleanupError } from "../process/exec-result.js";
import { formatErrorMessage } from "./errors.js";
import { trimLogTail } from "./restart-sentinel.js";
import {
  PACKAGE_POST_INSTALL_DOCTOR_ADVISORY,
  normalizeUpdatePostInstallDoctorWarnings,
  UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE,
  type UpdatePostInstallDoctorResult,
} from "./update-doctor-result.js";
import {
  createUpdateErrorFact,
  createUpdateFailureFact,
  normalizeUpdateFailureFacts,
} from "./update-failure-facts.js";
import type { UpdateStepResult } from "./update-step-result.js";

export function createPackageVerificationFailureStep(
  root: string,
  errors: string[],
  env?: NodeJS.ProcessEnv,
): UpdateStepResult {
  return {
    name: "package-verify",
    command: `verify ${root}`,
    cwd: root,
    durationMs: 0,
    exitCode: 1,
    stderrTail: errors.join("\n"),
    stdoutTail: null,
    failureFacts: errors.map((message) =>
      createUpdateFailureFact(
        { check: "package-verify", code: "global-install-failed", message },
        env,
      ),
    ),
  };
}

export type PackagePostInstallVerifier = (
  root: string,
  results: UpdateStepResult[],
) => Promise<UpdateStepResult | null>;

function isNormalProcessExit(step: {
  signal?: NodeJS.Signals | null;
  killed?: boolean;
  outputLimitExceeded?: boolean;
  termination?: "exit" | "timeout" | "no-output-timeout" | "signal";
}): boolean {
  return (
    step.termination !== "timeout" &&
    step.termination !== "no-output-timeout" &&
    step.termination !== "signal" &&
    step.killed !== true &&
    step.outputLimitExceeded !== true &&
    (step.signal === undefined || step.signal === null)
  );
}

export function markPackagePostInstallDoctorAdvisory<
  T extends {
    exitCode: number | null;
    stderrTail?: string | null;
    signal?: NodeJS.Signals | null;
    killed?: boolean;
    outputLimitExceeded?: boolean;
    termination?: "exit" | "timeout" | "no-output-timeout" | "signal";
    advisory?: UpdateStepResult["advisory"];
    failureFacts?: UpdateStepResult["failureFacts"];
  },
>(
  step: T,
  result: UpdatePostInstallDoctorResult | null,
): T & {
  advisory?: UpdateStepResult["advisory"];
  warnings?: UpdateStepResult["warnings"];
  failureFacts?: UpdateStepResult["failureFacts"];
} {
  if (result?.status === "error" || result?.failureFacts?.length) {
    const failureFacts = result.failureFacts?.length
      ? result.failureFacts
      : [
          createUpdateFailureFact({
            check: "openclaw doctor",
            code: "doctor-failed",
            message: "Post-install Doctor reported an error without diagnostic details.",
          }),
        ];
    return {
      ...step,
      advisory: undefined,
      failureFacts: normalizeUpdateFailureFacts([...failureFacts, ...(step.failureFacts ?? [])]),
    };
  }
  if (
    !result ||
    !isNormalProcessExit(step) ||
    !(
      (step.exitCode === UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE &&
        result.status === "advisory") ||
      (step.exitCode === 0 && result.warnings?.length)
    )
  ) {
    return step;
  }
  const repairGuidance = "Run openclaw doctor --fix to finish deferred repairs.";
  const deferredWarnings =
    result.status === "advisory"
      ? normalizeUpdatePostInstallDoctorWarnings(result.advisory.details).map(
          (detail) => `${detail}\n${repairGuidance}`,
        )
      : [];
  const advisoryTail = [
    step.stderrTail,
    ...(result.status === "advisory" ? result.advisory.details : []),
    ...(result.warnings ?? []),
    PACKAGE_POST_INSTALL_DOCTOR_ADVISORY.message,
  ]
    .filter((line): line is string => Boolean(line?.trim()))
    .join("\n");
  return {
    ...step,
    warnings: [
      ...new Set([
        ...normalizeUpdatePostInstallDoctorWarnings(result.warnings ?? []),
        ...deferredWarnings,
      ]),
    ].slice(0, 32),
    advisory: {
      ...PACKAGE_POST_INSTALL_DOCTOR_ADVISORY,
      message: [
        ...(result.warnings ?? []),
        ...(result.status === "advisory" ? result.advisory.details : []),
        PACKAGE_POST_INSTALL_DOCTOR_ADVISORY.message,
        repairGuidance,
      ].join("\n"),
    },
    stderrTail: trimLogTail(advisoryTail) ?? step.stderrTail,
  };
}

function failedVerification(root: string, code: string, message: string): UpdateStepResult {
  return {
    name: "post-install-verify",
    command: "verify installed package",
    cwd: root,
    durationMs: 0,
    exitCode: 1,
    stderrTail: message,
    failureFacts: [createUpdateFailureFact({ check: "package-runtime", code, message })],
  };
}

function missingPackageVerificationStep(root: string): UpdateStepResult {
  return failedVerification(
    root,
    "verification-result-missing",
    "Required post-install verification did not produce a result; Gateway activation is unsafe.",
  );
}

export function failedPackageVerificationStep(
  root: string,
  error: unknown,
  recorded?: UpdateStepResult,
): UpdateStepResult {
  if (hasCommandProcessCleanupError(error)) {
    throw error;
  }
  if (!recorded) {
    return failedVerification(root, "runtime-verification-failed", formatErrorMessage(error));
  }
  const errorFact = createUpdateErrorFact(recorded.name, error);
  const failedStep: UpdateStepResult = {
    ...recorded,
    stderrTail: trimLogTail(
      errorFact.message && !recorded.stderrTail?.includes(errorFact.message)
        ? [recorded.stderrTail, errorFact.message].filter(Boolean).join("\n")
        : recorded.stderrTail,
    ),
    // Keep the thrown cause before applying the receipt fact bound.
    failureFacts: normalizeUpdateFailureFacts([
      errorFact,
      ...(recorded.failureFacts ?? []).filter((fact) => !isDeepStrictEqual(fact, errorFact)),
    ]),
  };
  // A callback can fail after recording success or an advisory, including during attribution.
  delete failedStep.advisory;
  return failedStep;
}

/** The swap must retain a failed verification result while it restores the original package. */
export async function runPackagePostInstallVerification(
  root: string,
  verify: PackagePostInstallVerifier,
): Promise<UpdateStepResult> {
  const results: UpdateStepResult[] = [];
  try {
    return (await verify(root, results)) ?? missingPackageVerificationStep(root);
  } catch (error) {
    return failedPackageVerificationStep(root, error, results.at(-1));
  }
}
