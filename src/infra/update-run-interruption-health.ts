import {
  resolveGatewayRestartProbeContext,
  waitForGatewayHttpReadiness,
} from "../cli/daemon-cli/restart-health-probe.js";
import {
  inspectGatewayRestart,
  isSameGatewayRestartGeneration,
  waitForGatewayHealthyRestart,
} from "../cli/daemon-cli/restart-health.js";
import { resolveGatewayPort } from "../config/paths.js";
import { resolveGatewayService } from "../daemon/service.js";
import { resolveOpenClawPackageRoot } from "./openclaw-root.js";
import { readPackageVersion } from "./package-json.js";
import { readBuiltGatewayBuildId } from "./update-git-runtime.js";
import type { InstalledUpdateCandidate } from "./update-run-interruption.js";
import type { UpdateRunRecord } from "./update-run-record.js";

/** Reuse the restart owner's independent native, RPC, HTTP, and generation observations. */
export async function observeInterruptedUpdateGateway(
  candidate: InstalledUpdateCandidate,
  input: { env?: NodeJS.ProcessEnv; signal?: AbortSignal },
): Promise<UpdateRunRecord["verification"] | undefined> {
  const env = input.env ?? process.env;
  const root = await resolveOpenClawPackageRoot({
    argv1: process.argv[1],
    moduleUrl: import.meta.url,
  });
  if (!root) {
    return undefined;
  }
  const installedMatches = async () => {
    const [version, buildId] = await Promise.all([
      readPackageVersion(root),
      readBuiltGatewayBuildId(root),
    ]);
    return version === candidate.version && buildId === candidate.buildId;
  };
  if (!(await installedMatches())) {
    return undefined;
  }
  const context = await resolveGatewayRestartProbeContext(env);
  const port = resolveGatewayPort(context.config, env);
  const service = resolveGatewayService();
  const probe = {
    service,
    port,
    env,
    signal: input.signal,
    expectedVersion: candidate.version,
    expectedBuildId: candidate.buildId,
    requirePluginHealth: true,
  };
  const inspect = () =>
    inspectGatewayRestart({
      ...probe,
      probeContext: context,
      timeoutMs: 10_000,
    });
  const servingMatches = (health: Awaited<ReturnType<typeof inspect>>) =>
    health.healthy &&
    health.runtime.status === "running" &&
    health.gatewayVersion === candidate.version &&
    health.gatewayBuildId === candidate.buildId;
  const before = await waitForGatewayHealthyRestart({
    ...probe,
    requireRunningService: true,
    settle: { probes: 12 },
  });
  if (!servingMatches(before)) {
    return undefined;
  }
  const http = await waitForGatewayHttpReadiness({
    config: context.config,
    port,
    attempts: 1,
    deadlineAt: Date.now() + 10_000,
    probeTimeoutMs: 10_000,
    delayMs: 0,
    signal: input.signal,
  });
  const inspected = await inspect();
  const after = await inspect();
  if (
    http.healthz !== 200 ||
    http.readyz !== 200 ||
    !servingMatches(after) ||
    !servingMatches(inspected) ||
    !isSameGatewayRestartGeneration(before, inspected) ||
    !isSameGatewayRestartGeneration(inspected, after) ||
    !(await installedMatches())
  ) {
    return undefined;
  }
  input.signal?.throwIfAborted();
  return {
    booted: true,
    serviceRunning: true,
    pid: after.runtime.pid,
    port,
    runningVersion: candidate.version,
    runningBuildId: candidate.buildId,
    versionMatch: true,
    readyz: true,
    settled: true,
    channelsReady: true,
    pluginErrors: after.activatedPluginErrors?.map((error) => JSON.stringify(error)) ?? [],
  };
}
