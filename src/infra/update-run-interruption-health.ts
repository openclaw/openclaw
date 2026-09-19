import {
  resolveGatewayRestartProbeContext,
  waitForGatewayHttpReadiness,
} from "../cli/daemon-cli/restart-health-probe.js";
import {
  DEFAULT_RESTART_HEALTH_ATTEMPTS,
  DEFAULT_RESTART_HEALTH_TIMEOUT_MS,
} from "../cli/daemon-cli/restart-health.constants.js";
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

export type InterruptedUpdateGatewayObservation = {
  verification: UpdateRunRecord["verification"] | undefined;
  /** True when the settle budget expired without a healthy serving match. */
  settleBudgetExceeded: boolean;
};

/** Reuse the restart owner's independent native, RPC, HTTP, and generation observations. */
export async function observeInterruptedUpdateGateway(
  candidate: InstalledUpdateCandidate,
  input: { env?: NodeJS.ProcessEnv; signal?: AbortSignal },
): Promise<InterruptedUpdateGatewayObservation | undefined> {
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
  // The caller (canSettleInterruptedUpdate) already requires a completed
  // "restarting" step, so every run that reaches this point is managed.
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
  // Derive the settle budget from the existing restart-health timing
  // constants rather than a new literal: the default health timeout (60 s)
  // is quartered to bound this reconciliation stage well below the 65 s+
  // stall, and the probe count is a tenth of the default attempts.
  const SETTLE_PROBES = Math.ceil(DEFAULT_RESTART_HEALTH_ATTEMPTS / 10);
  const SETTLE_BUDGET_MS = Math.floor(DEFAULT_RESTART_HEALTH_TIMEOUT_MS / 4);
  const before = await waitForGatewayHealthyRestart({
    ...probe,
    requireRunningService: true,
    settle: { probes: SETTLE_PROBES },
    timeoutMs: SETTLE_BUDGET_MS,
  });
  if (!servingMatches(before)) {
    return { verification: undefined, settleBudgetExceeded: true };
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
    return { verification: undefined, settleBudgetExceeded: true };
  }
  input.signal?.throwIfAborted();
  return {
    verification: {
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
    },
    settleBudgetExceeded: false,
  };
}
