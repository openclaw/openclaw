import { formatErrorMessage } from "./errors.js";
import { createUpdateFailureFact } from "./update-failure-facts.js";
import type { UpdateStepResult } from "./update-runner-types.js";

function failedVerification(root: string, code: string, message: string): UpdateStepResult {
  return {
    name: "post-install verification",
    command: "verify installed package",
    cwd: root,
    durationMs: 0,
    exitCode: 1,
    stderrTail: message,
    failureFacts: [createUpdateFailureFact({ check: "package-runtime", code, message })],
  };
}

export function missingPackageVerificationStep(root: string): UpdateStepResult {
  return failedVerification(
    root,
    "verification-result-missing",
    "Required post-install verification did not produce a result; Gateway activation is unsafe.",
  );
}

/** The swap must retain a failed verification result while it restores the original package. */
export async function runPackagePostInstallVerification(
  root: string,
  verify: (root: string) => Promise<UpdateStepResult | null>,
): Promise<UpdateStepResult> {
  try {
    return (await verify(root)) ?? missingPackageVerificationStep(root);
  } catch (error) {
    return failedVerification(root, "runtime-verification-failed", formatErrorMessage(error));
  }
}
