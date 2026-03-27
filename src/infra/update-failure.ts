type UpdateFailureStep = {
  name?: string;
  exitCode?: number | null;
  stderrTail?: string | null;
};

type UpdateFailureResult = {
  status?: string;
  mode?: string;
  reason?: string;
  steps?: UpdateFailureStep[];
};

export function findFailedUpdateStep(
  result: UpdateFailureResult | null | undefined,
): UpdateFailureStep | undefined {
  return [...(result?.steps ?? [])].toReversed().find((step) => step.exitCode !== 0);
}

export function summarizeUpdateStderr(stderrTail: string | null | undefined): string | null {
  if (!stderrTail) {
    return null;
  }
  const lines = stderrTail
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return null;
  }

  const prioritized = lines.find((line) => /(eacces|npm err!|error|node-gyp|prebuild)/i.test(line));
  return prioritized ?? lines.at(-1) ?? null;
}

function inferShortUpdateFailureHint(step: UpdateFailureStep | undefined): string | null {
  const stderr = (step?.stderrTail ?? "").toLowerCase();
  if (!stderr || !step?.name?.startsWith("global update")) {
    return null;
  }
  if (stderr.includes("eacces")) {
    return "Permission denied during global package update. Re-run with a writable npm prefix or sudo.";
  }
  if (stderr.includes("node-gyp") || stderr.includes("prebuild")) {
    return "Native optional dependency build failed. Try `npm i -g openclaw@latest --omit=optional`.";
  }
  return null;
}

export function inferUpdateFailureHints(result: UpdateFailureResult): string[] {
  if (result.status !== "error" || result.mode !== "npm") {
    return [];
  }
  const failedStep = findFailedUpdateStep(result);
  if (!failedStep) {
    return [];
  }

  const stderr = (failedStep.stderrTail ?? "").toLowerCase();
  const hints: string[] = [];

  if (failedStep.name?.startsWith("global update") && stderr.includes("eacces")) {
    hints.push(
      "Detected permission failure (EACCES). Re-run with a writable global prefix or sudo (for system-managed Node installs).",
    );
    hints.push("Example: npm config set prefix ~/.local && npm i -g openclaw@latest");
  }

  if (
    failedStep.name?.startsWith("global update") &&
    (stderr.includes("node-gyp") || stderr.includes("prebuild"))
  ) {
    hints.push(
      "Detected native optional dependency build failure. The updater retries with --omit=optional automatically.",
    );
    hints.push("If it still fails: npm i -g openclaw@latest --omit=optional");
  }

  return hints;
}

export function formatUpdateFailureSummary(result: UpdateFailureResult | undefined): string {
  const failedStep = findFailedUpdateStep(result);
  const stderrSummary = summarizeUpdateStderr(failedStep?.stderrTail);
  const hint = inferShortUpdateFailureHint(failedStep);
  const parts = [
    failedStep?.name ?? result?.reason ?? "Update failed.",
    stderrSummary,
    hint,
  ].filter(Boolean);
  return parts.join(": ");
}
