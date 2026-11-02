import { resolveGatewayStartupTiming } from "../../commands/gateway-startup-timing.js";
import type { GatewayService } from "../../daemon/service.js";
import { withCommandProcessScope } from "../../process/exec-spawn.js";
import { getAsyncWorkSignal } from "../../shared/async-work-scope.js";
import { formatCliCommand } from "../command-format.js";
import { resolveGatewayLifecycleContext } from "./lifecycle-context.js";
import { createGatewayRestartDeadline } from "./restart-health-deadline.js";
import {
  DEFAULT_RESTART_HEALTH_DELAY_MS,
  formatGatewayRestartFailure,
  renderRestartDiagnostics,
  waitForGatewayHealthyRestart,
  waitForGatewayHttpReadiness,
} from "./restart-health.js";

/** Waits for the managed Gateway's health and HTTP readiness; callers decide what not-ready means. */
export async function checkGatewayServiceReadiness(params: {
  service: GatewayService;
  expectedPort?: number;
  /** Shortens the platform's startup deadline for callers that only report the result. */
  deadlineCapMs?: number;
}): Promise<
  | { ready: true }
  | {
      ready: false;
      diagnostics: string[];
      failure: [message: string, hints: string[], result?: "still-starting"];
    }
> {
  const { service } = params;
  const deadlineMs = Math.min(
    resolveGatewayStartupTiming().deadlineMs,
    params.deadlineCapMs ?? Number.POSITIVE_INFINITY,
  );
  const context = await resolveGatewayLifecycleContext(service);
  const port = params.expectedPort ?? context.port;
  const deadlineAt = performance.now() + deadlineMs;
  const attempts = Math.ceil(deadlineMs / DEFAULT_RESTART_HEALTH_DELAY_MS);
  const healthDeadline = createGatewayRestartDeadline({
    timeoutMs: deadlineMs,
    signal: getAsyncWorkSignal(),
  });
  const [health, readiness] = await Promise.all([
    withCommandProcessScope(
      () =>
        waitForGatewayHealthyRestart({
          service,
          port,
          attempts,
          delayMs: DEFAULT_RESTART_HEALTH_DELAY_MS,
          timeoutMs: deadlineMs,
          deadline: healthDeadline,
          deadlineOutcome: "snapshot",
          env: context.env,
          supervisorKeepsAlive: process.platform === "darwin",
          signal: getAsyncWorkSignal(),
        }),
      healthDeadline.signal,
    ).finally(() => healthDeadline.dispose()),
    waitForGatewayHttpReadiness({
      config: context.config,
      port,
      attempts,
      deadlineAt,
      delayMs: DEFAULT_RESTART_HEALTH_DELAY_MS,
      signal: getAsyncWorkSignal(),
    }),
  ]);
  if (health.healthy && readiness.healthz === 200 && readiness.readyz === 200) {
    return { ready: true };
  }
  const diagnostics = [
    ...renderRestartDiagnostics(health),
    `Gateway HTTP readiness: /healthz=${readiness.healthz ?? "unreachable"}; ` +
      `/readyz=${readiness.readyz ?? "unreachable"}.`,
  ];
  if (health.waitOutcome === "still-starting") {
    return {
      ready: false,
      diagnostics,
      failure: [
        formatGatewayRestartFailure({
          health,
          port,
          defaultTimeoutSeconds: Math.round(deadlineMs / 1000),
        }).failMessage,
        [formatCliCommand("openclaw gateway status --deep")],
        "still-starting",
      ],
    };
  }
  return {
    ready: false,
    diagnostics,
    failure: [
      `Gateway start timed out after ${Math.round(deadlineMs / 1000)}s waiting for /healthz and /readyz.`,
      [formatCliCommand("openclaw gateway status --deep"), formatCliCommand("openclaw doctor")],
    ],
  };
}
