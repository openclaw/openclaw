import { readGatewayOwnerLease } from "../../infra/gateway-owner-lease.js";
import { readPackageVersion } from "../../infra/package-json.js";
import { readBuiltGatewayBuildId } from "../../infra/update-git-runtime.js";
import { openDoctorStateSchemaReadAdmission } from "../../state/openclaw-state-db-doctor-schema.js";
import { formatCliCommand } from "../command-format.js";
import { allListenersOwnedByRuntimePid } from "../daemon-cli/restart-port-ownership.js";
import { observeUpdateGatewayReadiness } from "./update-command-readiness.js";
import type { UpdateFinalizationPhase } from "./update-finalization-lifecycle.js";

/** A serving Gateway retains maintenance exclusion until it exits. */
export async function deferUpdateFinalizationForServingGateway(
  params: UpdateFinalizationPhase & { root: string; deadlineMs: number },
): Promise<string | undefined> {
  const env = { ...process.env };
  const readOwner = () =>
    readGatewayOwnerLease({
      env,
      current: true,
      openStateSchemaReadAdmission: openDoctorStateSchemaReadAdmission,
    });
  const owner = readOwner();
  if (owner?.state !== "live") {
    return undefined;
  }
  const [version, buildId] = await Promise.all([
    readPackageVersion(params.root),
    readBuiltGatewayBuildId(params.root),
  ]);
  params.assertCurrent();
  if (!version || !buildId) {
    return undefined;
  }
  // Leave the final owner read and normal-admission fallback inside the phase budget.
  const remainingMs = Math.max(0, params.deadlineMs - performance.now());
  const { health, readyz } = await observeUpdateGatewayReadiness({
    serviceEnv: env,
    gatewayPort: owner.port,
    expectedVersion: version,
    expectedBuildId: buildId,
    requireRunningService: owner.mode === "supervised",
    deadlineMs: params.deadlineMs - Math.min(1_000, remainingMs / 2),
    signal: params.signal,
    assertCurrent: params.assertCurrent,
  });
  params.assertCurrent();
  const current = readOwner();
  if (
    !health.healthy ||
    !readyz ||
    current?.state !== "live" ||
    current.owner !== owner.owner ||
    current.pid !== owner.pid ||
    current.startedAt !== owner.startedAt ||
    current.host !== owner.host ||
    current.port !== owner.port ||
    current.mode !== owner.mode ||
    (owner.mode === "supervised" &&
      (health.runtime.status !== "running" ||
        health.runtime.pid === undefined ||
        !allListenersOwnedByRuntimePid(health.portUsage.listeners, health.runtime.pid))) ||
    !allListenersOwnedByRuntimePid(health.portUsage.listeners, owner.pid)
  ) {
    // Dead owners fall through to normal admission and owner-held reclamation.
    return undefined;
  }
  return `Skipped finalize:doctor and plugin convergence: ${owner.mode} Gateway owner ${owner.owner} (PID ${owner.pid}, start ${owner.startedAt}, port ${owner.port}) is verified serving ${version} build ${buildId}. The Gateway remains running. At the next maintenance window, stop it through its owner, run ${formatCliCommand("openclaw update repair", env)}, and start it through the same owner. Config and plugin maintenance remain pending.`;
}
