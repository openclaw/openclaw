import {
  GatewayRestartDeadlineError,
  type GatewayRestartCleanup,
  type GatewayRestartDeadline,
} from "../cli/daemon-cli/restart-health-deadline.js";
import {
  resolveGatewayRestartProbeContext,
  waitForGatewayHttpReadiness,
} from "../cli/daemon-cli/restart-health-probe.js";
import { waitForGatewayHealthyRestart } from "../cli/daemon-cli/restart-health.js";
import type { GatewayRestartWaitOutcome } from "../cli/daemon-cli/restart-health.types.js";
import { resolveGatewayPort } from "../config/paths.js";
import { resolveGatewayService } from "../daemon/service.js";
import { hasCommandProcessCleanupError } from "../process/exec-result.js";
import { resolveOpenClawPackageRoot } from "./openclaw-root.js";
import { readPackageVersion } from "./package-json.js";
import { readBuiltGatewayBuildId } from "./update-git-runtime.js";
import type { InstalledUpdateCandidate } from "./update-run-interruption-store.js";
import type { UpdateRunRecord } from "./update-run-record.js";

export type InterruptedUpdateGatewayObservation = {
  outcome: "settled" | "timed-out" | "unverified" | "skipped-unmanaged" | "cleanup-unknown";
  elapsedMs: number;
  phase: string;
  waitOutcome?: GatewayRestartWaitOutcome;
  verification?: UpdateRunRecord["verification"];
  cleanup?: GatewayRestartCleanup;
  timeout?: { elapsedMs: number; phase: string };
};

/** Read-only settlement shares one deadline for setup and serving readiness. */
export async function observeInterruptedUpdateGateway(
  candidate: InstalledUpdateCandidate,
  input: { env?: NodeJS.ProcessEnv; signal?: AbortSignal; deadline: GatewayRestartDeadline },
): Promise<InterruptedUpdateGatewayObservation> {
  const { deadline } = input;
  let waitOutcome: GatewayRestartWaitOutcome | undefined;
  const result = (outcome: InterruptedUpdateGatewayObservation["outcome"]) => ({
    outcome,
    elapsedMs: Math.round(deadline.elapsedMs()),
    phase: deadline.expiredPhase ?? deadline.phase,
    ...(waitOutcome ? { waitOutcome } : {}),
  });
  try {
    const env = input.env ?? process.env;
    const root = await deadline.read("setup:package-root", () =>
      resolveOpenClawPackageRoot({ argv1: process.argv[1], moduleUrl: import.meta.url }),
    );
    if (!root) {
      return result("unverified");
    }
    const installedMatches = async (phase: string) => {
      const [version, buildId] = await deadline.read(phase, () =>
        Promise.all([readPackageVersion(root), readBuiltGatewayBuildId(root)]),
      );
      return version === candidate.version && buildId === candidate.buildId;
    };
    if (!(await installedMatches("setup:installed-identity"))) {
      return result("unverified");
    }
    const context = await deadline.read("setup:probe-context", () =>
      resolveGatewayRestartProbeContext(env, undefined, deadline.signal),
    );
    const port = resolveGatewayPort(context.config, env);
    const probe = {
      service: resolveGatewayService(),
      port,
      env,
      signal: deadline.signal,
      deadline,
      probeContext: context,
      expectedVersion: candidate.version,
      expectedBuildId: candidate.buildId,
      requirePluginHealth: true,
    };
    const servingMatches = (health: Awaited<ReturnType<typeof waitForGatewayHealthyRestart>>) =>
      health.healthy &&
      health.runtime.status === "running" &&
      health.gatewayVersion === candidate.version &&
      health.gatewayBuildId === candidate.buildId;
    const before = await deadline.read("health-wait", () =>
      waitForGatewayHealthyRestart({
        ...probe,
        phase: "health-wait",
        requireRunningService: true,
      }),
    );
    waitOutcome = before.waitOutcome;
    if (!servingMatches(before)) {
      return result("unverified");
    }
    const http = await deadline.read("reconciliation:http", () =>
      waitForGatewayHttpReadiness({
        config: context.config,
        port,
        attempts: 1,
        deadlineAt: performance.now() + deadline.remainingMs(),
        probeTimeoutMs: deadline.remainingMs(),
        delayMs: 0,
        signal: deadline.signal,
      }),
    );
    if (http.healthz !== 200 || http.readyz !== 200) {
      return result("unverified");
    }
    deadline.signal.throwIfAborted();
    // Another restart during observation is best effort; the writer still checks run ownership.
    return {
      ...result("settled"),
      verification: {
        booted: true,
        serviceRunning: true,
        pid: before.runtime.pid,
        port,
        runningVersion: candidate.version,
        runningBuildId: candidate.buildId,
        versionMatch: true,
        readyz: true,
        settled: true,
        channelsReady: true,
        pluginErrors: before.activatedPluginErrors?.map((error) => JSON.stringify(error)) ?? [],
      },
    };
  } catch (error) {
    if (hasCommandProcessCleanupError(error)) {
      throw error;
    }
    input.signal?.throwIfAborted();
    return result(error instanceof GatewayRestartDeadlineError ? "timed-out" : "unverified");
  }
}
