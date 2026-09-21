import { formatCliCommand } from "../cli/command-format.js";
import { inspectGatewayRestart } from "../cli/daemon-cli/restart-health.js";
import type { PreManagedServiceStop } from "../cli/update-cli/update-command-service-maintenance.js";
import { resolveUpdatedGatewayRestartPort } from "../cli/update-cli/update-command-service-plan.js";
import { resolveGatewayService } from "../daemon/service.js";
import { readLegacyGatewayLockIdentity } from "../infra/gateway-lock-legacy.js";
import { readPackageVersion } from "../infra/package-json.js";
import { probePortUsage } from "../infra/ports-probe.js";
import { UpdateDoctorError } from "../infra/update-doctor-result.js";
import { createUpdateFailureFact } from "../infra/update-failure-facts.js";
import { readBuiltGatewayBuildId } from "../infra/update-git-runtime.js";
import { openDoctorStateSchemaReadAdmission } from "../state/openclaw-state-db-doctor-schema.js";

export type DoctorStaleGateway = {
  version: string;
  buildId: string;
  pid: number | undefined;
  port: number;
};

export function doctorGatewayMaintenanceError(params: {
  env: NodeJS.ProcessEnv;
  phase: "gateway-stop" | "gateway-restoration";
  code: string;
  detail: string;
  cause?: unknown;
}): UpdateDoctorError {
  const restart = formatCliCommand("openclaw gateway restart", params.env);
  const status = formatCliCommand("openclaw gateway status --deep", params.env);
  const doctor = formatCliCommand("openclaw doctor --fix", params.env);
  const next = `Run ${status}; resolve the reported failure, then ${doctor} and ${restart}.`;
  return new UpdateDoctorError(
    `Doctor ${params.phase} failed. ${params.detail} ${next}`,
    [
      createUpdateFailureFact(
        { check: params.phase, code: params.code, message: params.detail },
        params.env,
      ),
      createUpdateFailureFact(
        { check: params.phase, code: "stale-gateway-recovery-command", message: next },
        params.env,
      ),
    ],
    { cause: params.cause },
  );
}

/** Identify predecessor code without requiring startup before offline migrations. */
export async function inspectStaleDoctorGateway(params: {
  root: string;
  env: NodeJS.ProcessEnv;
  before: PreManagedServiceStop;
  assertCurrent?: () => void;
}): Promise<DoctorStaleGateway | undefined> {
  const { before, root, env } = params;
  const legacy = await readLegacyGatewayLockIdentity(env);
  if (!before.running && !legacy) {
    return undefined;
  }
  const serviceEnv = before.serviceEnv ?? env;
  const service = resolveGatewayService();
  const [version, buildId, serviceCommand] = await Promise.all([
    readPackageVersion(root),
    readBuiltGatewayBuildId(root),
    service.readCommand(serviceEnv).catch(() => null),
  ]);
  params.assertCurrent?.();
  if ((!version || !buildId) && !legacy) {
    return undefined;
  }
  const port = await resolveUpdatedGatewayRestartPort({ serviceEnv, serviceCommand });
  // A live legacy lock is already positive stale evidence. RPC can be unavailable
  // until Doctor imports retained sessions, so do not require it at admission.
  const health = legacy
    ? undefined
    : await inspectGatewayRestart({
        service,
        port,
        env: serviceEnv,
        expectedVersion: version,
        expectedBuildId: buildId,
        openStateSchemaReadAdmission: openDoctorStateSchemaReadAdmission,
        requirePluginHealth: false,
      });
  params.assertCurrent?.();
  const stale =
    legacy ||
    health?.buildIdMismatch?.actual != null ||
    health?.versionMismatch ||
    health?.probeError?.startsWith("gateway closed (1011): gateway message handler unavailable");
  if (!stale) {
    return undefined;
  }
  const pid = legacy?.pid ?? before.servicePid ?? health?.runtime.pid;
  if (
    before.serviceUpdateVerdict?.kind !== "owned" ||
    !before.serviceEnv ||
    !before.running ||
    (legacy && (legacy.state !== "alive" || legacy.pid !== before.servicePid))
  ) {
    throw doctorGatewayMaintenanceError({
      env,
      phase: "gateway-stop",
      code: "stale-gateway-service-unverified",
      detail: `Gateway PID ${pid ?? "unknown"} is stale, but its managed service ownership is unverified. ${before.blockMessage ?? before.serviceMutationSkipMessage ?? ""}`,
    });
  }
  if (!version || !buildId) {
    throw doctorGatewayMaintenanceError({
      env,
      phase: "gateway-stop",
      code: "stale-gateway-identity-unavailable",
      detail: "The installed candidate's build identity is unavailable.",
    });
  }
  return { version, buildId, pid, port };
}

export async function assertStaleDoctorGatewayStopped(params: {
  stale: DoctorStaleGateway;
  env: NodeJS.ProcessEnv;
  assertCurrent?: () => void;
}): Promise<void> {
  const runtime = await resolveGatewayService().readRuntime(params.env);
  const port = await probePortUsage(params.stale.port);
  const legacy = await readLegacyGatewayLockIdentity(params.env);
  params.assertCurrent?.();
  if (runtime.status !== "stopped" || (runtime.pid ?? 0) > 0 || port !== "free" || legacy) {
    throw new Error(
      `Stale Gateway PID ${params.stale.pid ?? "unknown"} did not stop: service=${runtime.status}, PID=${runtime.pid ?? "none"}, port ${params.stale.port}=${port}, legacy lock owner=${legacy?.pid ?? "none"}.`,
    );
  }
}
