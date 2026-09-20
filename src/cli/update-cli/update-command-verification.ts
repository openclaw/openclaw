import { theme } from "../../../packages/terminal-core/src/theme.js";
import { resolveGatewayRestartLogPath } from "../../daemon/restart-logs.js";
import {
  normalizeUpdateFailureFacts,
  type UpdateFailureFact,
} from "../../infra/update-failure-facts.js";
import type { UpdateRepairValidation } from "../../infra/update-repair-protocol.js";
import { recordUpdateRunStep, recordUpdateRunVerification } from "../../infra/update-run-ledger.js";
import { updateRunStepsFromResultStep } from "../../infra/update-run-step.js";
import type { UpdateRunResult, UpdateStepResult } from "../../infra/update-runner.js";
import { defaultRuntime } from "../../runtime.js";
import { formatCliCommand } from "../command-format.js";
import {
  renderRestartDiagnostics,
  type GatewayRestartSnapshot,
} from "../daemon-cli/restart-health.js";
import type { UpdateCommandOptions } from "./shared.js";
import {
  createPluginUpdateWarning,
  type PluginUpdateWarning,
} from "./update-command-plugins-internals.js";
import {
  captureUpdateGatewayReadinessOwner,
  gatewayReadinessPending,
  observeUpdateGatewayReadiness,
  type UpdateGatewayReadinessParams,
} from "./update-command-readiness.js";
import { formatPostUpdateGatewayRecoveryInstructions } from "./update-command-service-recovery.js";

export function recordPreviousGatewayVerification(
  run: UpdateCommandOptions["run"],
  verified: boolean,
): void {
  if (!run) {
    return;
  }
  recordUpdateRunStep(
    run.runId,
    {
      step: "previous gateway verification",
      status: "completed",
      detail: verified
        ? "Previous package is running and ready."
        : "Previous gateway was not verified; automatic rollback cannot restart it.",
      endedAtMs: Date.now(),
    },
    { env: run.env },
  );
}

export function recordUpdateGatewayHealth(
  run: UpdateCommandOptions["run"],
  health: GatewayRestartSnapshot,
  port: number,
  readyz = false,
): void {
  if (!run) {
    return;
  }
  recordUpdateRunVerification(
    run.runId,
    {
      serviceRunning: health.runtime.status === "running",
      ...(typeof health.runtime.pid === "number" ? { pid: health.runtime.pid } : {}),
      port,
      runningVersion: health.gatewayVersion ?? undefined,
      runningBuildId: health.gatewayBuildId ?? undefined,
      versionMatch:
        health.expectedVersion && health.gatewayVersion != null
          ? health.gatewayVersion === health.expectedVersion && !health.buildIdMismatch
          : undefined,
      pluginErrors: [
        ...(health.activatedPluginErrors?.map((error) => JSON.stringify(error)) ?? []),
        ...(health.unavailablePlugins?.map((error) => JSON.stringify(error)) ?? []),
      ],
      channelsReady: health.healthy && !health.channelProbeErrors?.length,
      settled: health.healthy,
      readyz,
    },
    { env: run.env },
  );
}

/** Verify core activation while preserving plugin failures as separate notices. */
export async function verifyUpdatedGateway(
  params: UpdateGatewayReadinessParams & {
    result: UpdateRunResult;
    opts: UpdateCommandOptions;
    nodeRunner?: string;
    onVerified?: (verifiedAtMs: number) => void;
  },
): Promise<UpdateRepairValidation & { pluginWarnings?: PluginUpdateWarning[] }> {
  const startedAtMs = Date.now();
  const { proofOptions, assertCurrent } = captureUpdateGatewayReadinessOwner(params);
  const { health, readyz, http, launchAgentRecovery } = await observeUpdateGatewayReadiness({
    ...params,
    assertCurrent,
  });
  if (launchAgentRecovery?.attempted) {
    defaultRuntime.error(
      launchAgentRecovery.recovered ? launchAgentRecovery.message : launchAgentRecovery.detail,
    );
  }
  const serviceRunning = !params.requireRunningService || health.runtime.status === "running";
  const recordVerificationStep = (
    failureFacts?: UpdateFailureFact[],
    detail?: string,
    warning?: string,
  ) => {
    const endedAtMs = Date.now();
    const step: UpdateStepResult = {
      name: params.result.recovery?.packageRollbackVerified
        ? "rollback gateway verification"
        : "gateway verification",
      command: "gateway verification",
      cwd: params.result.root ?? process.cwd(),
      durationMs: endedAtMs - startedAtMs,
      exitCode: failureFacts ? 1 : 0,
      ...(failureFacts ? { failureFacts } : {}),
      ...(warning
        ? {
            termination: "timeout" as const,
            advisory: { kind: "recoverable-maintenance" as const, message: warning },
          }
        : {}),
    };
    // Repair reuses the result: the last observation replaces its earlier failure.
    const index = params.result.steps.findIndex((entry) => entry.name === step.name);
    if (index === -1) {
      params.result.steps.push(step);
    } else {
      params.result.steps[index] = step;
    }
    if (proofOptions.run) {
      for (const row of updateRunStepsFromResultStep(step)) {
        // A recheck must clear failure facts from the previous observation.
        recordUpdateRunStep(
          proofOptions.run.runId,
          { failureFacts: undefined, ...row, endedAtMs, detail: row.detail ?? detail },
          { env: proofOptions.run.env },
        );
      }
    }
  };
  if (health.healthy && serviceRunning && readyz) {
    const pluginFailures = new Map<string, string>();
    for (const failure of health.activatedPluginErrors ?? []) {
      pluginFailures.set(failure.id, failure.error);
    }
    for (const failure of health.unavailablePlugins ?? []) {
      pluginFailures.set(failure.id, `${failure.reason}: ${failure.detail}`);
    }
    const pluginWarnings = Array.from(pluginFailures, ([pluginId, reason]) =>
      createPluginUpdateWarning({ pluginId, reason, kind: "load", env: params.serviceEnv }),
    );
    assertCurrent();
    const verifiedAtMs = Date.now();
    recordUpdateGatewayHealth(proofOptions.run, health, params.gatewayPort, readyz);
    params.onVerified?.(verifiedAtMs);
    assertCurrent();
    recordVerificationStep();

    if (!params.opts.json) {
      defaultRuntime.log(theme.success("Gateway: restarted and verified."));
      for (const warning of pluginWarnings) {
        defaultRuntime.log(theme.warn(warning.message));
      }
    }
    return {
      ok: true,
      score: 7,
      summary:
        pluginWarnings.length > 0
          ? "Gateway service, version, channels, and readiness verified; plugin failures need a retry."
          : "Gateway service, version, plugins, channels, and readiness verified.",
      ...(pluginWarnings.length > 0 ? { pluginWarnings } : {}),
    };
  }
  recordUpdateGatewayHealth(proofOptions.run, health, params.gatewayPort, readyz);
  if (gatewayReadinessPending(health)) {
    const detail = [
      "Gateway readiness is pending; leaving the observed running process starting without another recovery restart or rollback.",
      ...renderRestartDiagnostics(health),
      ...(http ? [`Last HTTP readiness response: ${http.readyz ?? "unavailable"}.`] : []),
      `Keep recovery backups and check progress with \`${formatCliCommand("openclaw gateway status --deep")}\`.`,
    ].join("\n");
    recordVerificationStep(undefined, detail, detail);
    defaultRuntime.error(detail);
    return {
      ok: false,
      score: 0,
      summary: "Gateway is still starting; readiness remains unverified.",
      stopReason:
        health.waitOutcome === "still-starting" ? "still-starting" : "gateway-readiness-pending",
    };
  }
  const httpFailed = http !== undefined && !readyz;
  const diagnosticLines: [string, ...string[]] = [
    "Gateway did not become healthy after restart.",
    ...(httpFailed ? ["Gateway /readyz did not return HTTP 200."] : []),
    ...(health.healthy && params.requireRunningService
      ? ["Gateway responded, but the managed service did not report running after restart."]
      : []),
    ...renderRestartDiagnostics(health),
    ...(launchAgentRecovery?.attempted
      ? [
          launchAgentRecovery.recovered
            ? `LaunchAgent recovery: ${launchAgentRecovery.message}`
            : `LaunchAgent recovery failed: ${launchAgentRecovery.detail}`,
        ]
      : []),
    `Restart log: ${resolveGatewayRestartLogPath(params.serviceEnv)}`,
    `Run \`${formatCliCommand("openclaw gateway status --deep")}\` for details.`,
    ...formatPostUpdateGatewayRecoveryInstructions(params.result),
  ];
  const reason = health.versionMismatch
    ? "version-mismatch"
    : health.buildIdMismatch
      ? "build-id-mismatch"
      : health.activatedPluginErrors?.length
        ? "plugin-errors"
        : health.channelProbeErrors?.length
          ? "channel-errors"
          : httpFailed
            ? "readyz-unhealthy"
            : !serviceRunning
              ? "service-not-running"
              : (health.waitOutcome ?? "restart-unhealthy");
  const facts: UpdateFailureFact[] = [];
  if (health.versionMismatch) {
    facts.push({
      check: "versionMatch",
      code: "version-mismatch",
      message: `Expected Gateway version ${health.versionMismatch.expected}; observed ${health.versionMismatch.actual ?? "unavailable"}.`,
    });
  }
  if (health.buildIdMismatch) {
    facts.push({
      check: "versionMatch",
      code: "build-id-mismatch",
      message: `Expected Gateway build ${health.buildIdMismatch.expected}; observed ${health.buildIdMismatch.actual ?? "unavailable"}.`,
    });
  }
  if (httpFailed) {
    facts.push({
      check: "readyz",
      code: "readyz-unhealthy",
      message: `Gateway readiness endpoint returned HTTP ${http.readyz ?? "unavailable"}; expected HTTP 200.`,
    });
  }
  if (!serviceRunning) {
    facts.push({
      check: "service",
      code: "service-not-running",
      message: `Managed Gateway service status: ${health.runtime.status ?? "unknown"}.`,
    });
  }
  for (const error of health.activatedPluginErrors ?? []) {
    facts.push({
      check: "pluginErrors",
      code: "plugin-errors",
      pluginId: error.id,
      message: error.error,
    });
  }
  for (const error of health.channelProbeErrors ?? []) {
    facts.push({
      check: "channelsReady",
      code: "channel-errors",
      pluginId: error.id,
      message: error.error,
    });
  }
  if (!facts.length) {
    facts.push({
      check: "settled",
      code: health.waitOutcome ?? "restart-unhealthy",
      message:
        health.probeError ??
        `Gateway did not settle${health.startupPhase ? `; startup phase: ${health.startupPhase}` : "."}`,
    });
  }
  recordVerificationStep(
    normalizeUpdateFailureFacts(facts, params.serviceEnv),
    httpFailed ? "Gateway /readyz did not return HTTP 200." : reason,
  );
  if (params.opts.json) {
    defaultRuntime.error(diagnosticLines.join("\n"));
  } else {
    defaultRuntime.log(theme.warn(diagnosticLines[0]));
    for (const line of diagnosticLines.slice(1)) {
      defaultRuntime.log(theme.muted(line));
    }
  }
  const score = [
    serviceRunning,
    !health.versionMismatch,
    !health.buildIdMismatch,
    !health.activatedPluginErrors?.length,
    !health.channelProbeErrors?.length,
    health.healthy,
    readyz,
  ].filter(Boolean).length;
  return { ok: false, score, summary: reason };
}

export { verifyPreviousGatewayForUpdate } from "./update-command-readiness.js";
