import { measureGatewayBootstrapStep } from "../cli/startup-trace.js";
import type { ConfigSnapshotReadMeasure } from "../config/io.js";

export async function measureDoctorConfigPreflightStep<T>(
  name: string,
  run: () => T | Promise<T>,
  measure?: ConfigSnapshotReadMeasure,
  metrics?: () => Readonly<Record<string, number>>,
): Promise<T> {
  const tracedRun = () => measureGatewayBootstrapStep(`cli.bootstrap.${name}`, run, metrics);
  return measure ? await measure(`doctor.config-preflight.${name}`, tracedRun) : await tracedRun();
}
