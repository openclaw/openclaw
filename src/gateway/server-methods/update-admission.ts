import { UpdatePreMutationError } from "../../cli/update-cli/shared.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createFreeBsdPkgOwnershipInspection } from "../../infra/update-freebsd-pkg-ownership.js";
import { recordUpdateRunStep } from "../../infra/update-run-ledger.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import { resolveUpdateInstallSurface } from "../../infra/update-runner.js";
import { initializeGatewayUpdateStatus } from "../../infra/update-startup.js";

export async function resolveGatewayUpdateAdmission(timeoutMs?: number) {
  const { root, status } = await initializeGatewayUpdateStatus();
  // Status discovery is read-only; admit ownership before campaign adoption
  // or a managed handoff can select and launch an updater.
  await createFreeBsdPkgOwnershipInspection(timeoutMs).assertUnowned(root);
  const installSurface = await resolveUpdateInstallSurface({
    root,
    installKind: status.installKind,
    timeoutMs,
  });
  return { status, installSurface };
}

export function recordHandoffFailure(
  runId: string,
  error: unknown,
  previous: UpdateRunResult,
): UpdateRunResult {
  const { reason, failureFacts } =
    error instanceof UpdatePreMutationError
      ? error
      : new UpdatePreMutationError("managed-service-handoff-failed", formatErrorMessage(error));
  const step = {
    name: "requested",
    command: "",
    cwd: previous.root ?? "",
    durationMs: 0,
    exitCode: null,
    failureFacts,
  };
  recordUpdateRunStep(runId, { step: step.name, status: "failed", reason, failureFacts });
  return { ...previous, status: "error", reason, steps: [...previous.steps, step] };
}
