import {
  GatewayRestartDeadlineError,
  type GatewayRestartCleanup,
  type GatewayRestartDeadline,
} from "../cli/daemon-cli/restart-health-deadline.js";
import {
  resolveGatewayRestartProbeContext,
  waitForGatewayHttpReadiness,
} from "../cli/daemon-cli/restart-health-probe.js";
import { INTERRUPTED_UPDATE_SETTLE_PROBES } from "../cli/daemon-cli/restart-health.constants.js";
import {
  inspectGatewayRestart,
  isSameGatewayRestartGeneration,
  waitForGatewayHealthyRestart,
} from "../cli/daemon-cli/restart-health.js";
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

/** Read-only settlement shares one deadline, including setup and final identity checks. */
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
    const inspect = (phase: string) => inspectGatewayRestart({ ...probe, phase });
    const servingMatches = (health: Awaited<ReturnType<typeof inspect>>) =>
      health.healthy &&
      health.runtime.status === "running" &&
      health.gatewayVersion === candidate.version &&
      health.gatewayBuildId === candidate.buildId;
    const before = await deadline.read("health-wait", () =>
      waitForGatewayHealthyRestart({
        ...probe,
        phase: "health-wait",
        requireRunningService: true,
        settle: { probes: INTERRUPTED_UPDATE_SETTLE_PROBES },
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
    const inspected = await deadline.read("reconciliation:inspect-before", () =>
      inspect("reconciliation:inspect-before"),
    );
    const after = await deadline.read("reconciliation:inspect-after", () =>
      inspect("reconciliation:inspect-after"),
    );
    if (
      http.healthz !== 200 ||
      http.readyz !== 200 ||
      !servingMatches(after) ||
      !servingMatches(inspected) ||
      !isSameGatewayRestartGeneration(before, inspected) ||
      !isSameGatewayRestartGeneration(inspected, after) ||
      !(await installedMatches("reconciliation:installed-identity"))
    ) {
      return result("unverified");
    }
    deadline.signal.throwIfAborted();
    return {
      ...result("settled"),
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
    };
  } catch (error) {
    if (hasCommandProcessCleanupError(error)) {
      throw error;
    }
    input.signal?.throwIfAborted();
    return result(error instanceof GatewayRestartDeadlineError ? "timed-out" : "unverified");
  }
}
