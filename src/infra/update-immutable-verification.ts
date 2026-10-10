import {
  createGatewayRestartDeadline,
  GatewayRestartDeadlineError,
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
  type GatewayRestartSnapshot,
} from "../cli/daemon-cli/restart-health.js";
import { resolveUpdatedGatewayRestartPort } from "../cli/update-cli/update-command-service-plan.js";
import type { GatewayService } from "../daemon/service-types.js";
import { readSystemdServiceRuntime } from "../daemon/systemd-runtime.js";
import { hasCommandProcessCleanupError } from "../process/exec-result.js";
import { readPackageVersion } from "./package-json.js";
import { readBuiltGatewayBuildId } from "./update-git-runtime.js";
import type {
  ImmutableInstallDescriptor,
  ImmutablePreparedGeneration,
} from "./update-immutable-install-schema.js";
import {
  assertImmutableServiceProcessCurrent,
  inspectImmutableActivationService,
  type ImmutableServiceObservation,
} from "./update-immutable-service.js";

export type ImmutableGatewayVerification = {
  pid: number;
  bootId: string;
  version: string;
  buildId: string;
  generationSha: string;
};

export type ImmutableGatewayObservation = {
  outcome: "verified" | "still-starting" | "unverified" | "failed";
  service?: ImmutableServiceObservation;
  verification?: ImmutableGatewayVerification;
};

/** Read-only settlement: the caller owns publication, rollback, and the durable receipt. */
export async function waitForImmutableGateway(params: {
  descriptor: ImmutableInstallDescriptor;
  generation: Pick<ImmutablePreparedGeneration, "path" | "sha">;
  timeoutMs: number;
  assertCurrent: () => void;
  onReceipt?: (line: string) => void;
}): Promise<ImmutableGatewayObservation> {
  const deadline = createGatewayRestartDeadline({ timeoutMs: params.timeoutMs });
  let observed: ImmutableServiceObservation | undefined;
  let waited: GatewayRestartSnapshot | undefined;
  const assertCurrent = () => {
    params.assertCurrent();
    deadline.signal.throwIfAborted();
  };
  const result = (outcome: ImmutableGatewayObservation["outcome"]): ImmutableGatewayObservation => {
    params.assertCurrent();
    params.onReceipt?.(`readiness-${outcome}`);
    return {
      outcome,
      ...(observed ? { service: observed } : {}),
    };
  };
  const inconclusive = () => {
    switch (waited?.waitOutcome) {
      case "still-starting":
        return result("still-starting");
      case "version-mismatch":
      case "build-id-mismatch":
      case "plugin-errors":
      case "channel-errors":
      case "stopped-free":
        return result("failed");
      default:
        return result("unverified");
    }
  };
  const inspectService = () =>
    inspectImmutableActivationService({
      descriptor: params.descriptor,
      generationPath: params.generation.path,
      allowStopped: true,
      allowStarting: true,
      assertCurrent,
    });
  try {
    params.assertCurrent();
    params.onReceipt?.("readiness-observing");
    return await deadline.run<ImmutableGatewayObservation>(async () => {
      const before = await deadline.read("readiness:service", inspectService);
      observed = before;
      const [version, buildId] = await deadline.read("readiness:artifact-identity", () =>
        Promise.all([
          readPackageVersion(params.generation.path),
          readBuiltGatewayBuildId(params.generation.path),
        ]),
      );
      assertCurrent();
      if (!version || !buildId) {
        return result("unverified");
      }
      const env = before.state.env;
      const context = await deadline.read("readiness:probe-context", () =>
        resolveGatewayRestartProbeContext(env, undefined, deadline.signal),
      );
      assertCurrent();
      const port = await deadline.read("readiness:port", () =>
        resolveUpdatedGatewayRestartPort({
          config: context.config,
          serviceEnv: env,
          serviceCommand: before.state.command,
        }),
      );
      assertCurrent();
      const service: Pick<GatewayService, "readCommand" | "readRuntime"> = {
        readCommand: async () => before.state.command,
        readRuntime: async (_env, options) => {
          assertCurrent();
          const runtime = await readSystemdServiceRuntime(env, {
            timeoutMs: options?.timeoutMs,
            systemdReadTarget: {
              scope: before.identity.scope,
              unitName: before.identity.unitName,
              unitPath: before.identity.unitPath,
            },
          });
          assertCurrent();
          return runtime;
        },
      };
      const probe = {
        service,
        port,
        env,
        deadline,
        probeContext: context,
        expectedVersion: version,
        expectedBuildId: buildId,
        requirePluginHealth: true,
      };
      waited = await waitForGatewayHealthyRestart({
        ...probe,
        phase: "readiness:health",
        deadlineOutcome: "snapshot",
        requireRunningService: true,
        settle: { probes: INTERRUPTED_UPDATE_SETTLE_PROBES },
      });
      if (!waited.healthy) {
        return inconclusive();
      }
      const http = await deadline.read("readiness:http", () =>
        waitForGatewayHttpReadiness({
          config: context.config,
          port,
          attempts: 1,
          deadlineAt: deadline.deadlineMs,
          probeTimeoutMs: deadline.remainingMs(),
          delayMs: 0,
          signal: deadline.signal,
        }),
      );
      const after = await inspectGatewayRestart({ ...probe, phase: "readiness:reconcile" });
      assertCurrent();
      const current = await deadline.read("readiness:service-reconcile", inspectService);
      assertCurrent();
      if (
        current.phase !== "running" ||
        current.pid === null ||
        (before.pid !== null &&
          (current.pid !== before.pid || current.processStartTicks !== before.processStartTicks)) ||
        current.definitionDigest !== before.definitionDigest ||
        current.identity.busId !== before.identity.busId ||
        current.identity.managerOwner !== before.identity.managerOwner ||
        current.generationPath !== params.generation.path ||
        after.runtime.pid !== current.pid ||
        !after.gatewayBootId ||
        !after.healthy ||
        !isSameGatewayRestartGeneration(waited, after) ||
        after.gatewayVersion !== version ||
        after.gatewayBuildId !== buildId ||
        http.healthz !== 200 ||
        http.readyz !== 200
      ) {
        return result("unverified");
      }
      assertImmutableServiceProcessCurrent(current);
      assertCurrent();
      observed = current;
      return {
        ...result("verified"),
        verification: {
          pid: current.pid,
          bootId: after.gatewayBootId,
          version,
          buildId,
          generationSha: params.generation.sha,
        },
      };
    });
  } catch (error) {
    // The process scope settles aborted native reads before a caller may consider rollback.
    await deadline.cleanup;
    params.assertCurrent();
    if (hasCommandProcessCleanupError(error) || deadline.cleanupStatus === "unknown") {
      throw error;
    }
    return error instanceof GatewayRestartDeadlineError ? inconclusive() : result("unverified");
  } finally {
    deadline.dispose();
  }
}
