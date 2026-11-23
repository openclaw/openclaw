import path from "node:path";
import { isFailedUpdateStep } from "../../infra/update-run-step.js";
import type { UpdateStepResult } from "../../infra/update-step-result.js";

export function resolveUpdateSnapshotScratch(
  steps: readonly UpdateStepResult[],
  env: NodeJS.ProcessEnv,
): string | undefined {
  const explicitTmpdir = env.TMPDIR?.trim();
  if (!explicitTmpdir || !path.isAbsolute(explicitTmpdir)) {
    return undefined;
  }
  const capacity = steps.find(
    (step) => step.name === "candidate-state-snapshot" && !isFailedUpdateStep(step),
  )?.snapshotCapacity;
  const selectedKind = capacity?.selection?.kind;
  if (!capacity || !selectedKind || selectedKind === "explicit-tmpdir") {
    return undefined;
  }
  const requestedRoot = path.resolve(explicitTmpdir);
  if (
    !capacity.candidates.some(
      (candidate) => candidate.kind === "explicit-tmpdir" && candidate.directory === requestedRoot,
    )
  ) {
    return undefined;
  }
  // Reuse the admitted parent because rehearsal removes its private directory.
  return capacity.candidates.find((candidate) => candidate.kind === selectedKind)?.directory;
}
