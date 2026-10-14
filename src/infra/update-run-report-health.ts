import type { UpdateRunRecord } from "./update-run-record.js";

export type UpdateRunReportHealth =
  | { kind: "unavailable" }
  | { kind: "responding"; version: string };

/** A read-only observation of the recorded endpoint, never a new update verdict. */
export async function readUpdateRunReportHealth(
  verification: UpdateRunRecord["verification"],
  options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<UpdateRunReportHealth> {
  if (verification.port === undefined) {
    return { kind: "unavailable" };
  }
  try {
    const { confirmGatewayReachable } = await import("../cli/daemon-cli/restart-health-probe.js");
    const health = await confirmGatewayReachable({
      port: verification.port,
      ...options,
    });
    return health.reachable && health.gatewayVersion
      ? { kind: "responding", version: health.gatewayVersion }
      : { kind: "unavailable" };
  } catch {
    return { kind: "unavailable" };
  }
}
