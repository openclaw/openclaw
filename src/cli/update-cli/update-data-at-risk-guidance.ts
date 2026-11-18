import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveGatewayService, type GatewayService } from "../../daemon/service.js";
import {
  verifyUpdateStateConsistency,
  type UpdateStateVerification,
} from "../../infra/update-data-at-risk.js";
import {
  dataAtRiskVerifiedStep,
  findLatestUnverifiedDataAtRisk,
} from "../../infra/update-run-data-at-risk.js";
import { listUpdateRuns, recordUpdateRunStep } from "../../infra/update-run-ledger.js";
import { defaultRuntime } from "../../runtime.js";
import { VERSION } from "../../version.js";
import { formatCliCommand } from "../command-format.js";
import { confirmGatewayReachable } from "../daemon-cli/restart-health-probe.js";
import {
  readGatewayServiceStateForUpdate,
  resolveUpdatedGatewayRestartPort,
} from "./update-command-service-plan.js";

export type ObservedGateway = { running?: boolean; version?: string };

/** Observe the Gateway when guidance is printed; a failed read is reported as unknown. */
export async function observeGatewayForGuidance(params: {
  service: GatewayService;
  env: NodeJS.ProcessEnv;
  config?: OpenClawConfig;
  timeoutMs?: number;
}): Promise<ObservedGateway> {
  try {
    const state = await readGatewayServiceStateForUpdate(
      params.service,
      params.env,
      params.timeoutMs,
    );
    if (!state.running) {
      return { running: false };
    }
    const port = await resolveUpdatedGatewayRestartPort({
      config: params.config,
      serviceEnv: state.env,
      serviceCommand: state.command,
    });
    const reachability = await confirmGatewayReachable({
      port,
      config: params.config,
      env: state.env,
      timeoutMs: Math.min(params.timeoutMs ?? 3_000, 3_000),
    }).catch(() => undefined);
    return { running: true, version: reachability?.gatewayVersion ?? undefined };
  } catch {
    return {};
  }
}

function describeGateway(gateway: ObservedGateway): string {
  if (gateway.running === true) {
    return gateway.version
      ? `The Gateway is running and serving OpenClaw ${gateway.version}.`
      : "The Gateway is running.";
  }
  return gateway.running === false
    ? "The Gateway is stopped."
    : "The Gateway state could not be read.";
}

export function formatDataAtRiskResolved(params: {
  runId: string;
  mark: string;
  verification: Extract<UpdateStateVerification, { status: "consistent" }>;
}): string {
  return `Update ${params.runId} recorded data at risk (${params.mark}); verification found the ${params.verification.detail}, so that mark is resolved.`;
}

export function formatDataAtRiskRefusal(params: {
  runId: string;
  mark: string;
  verification: Exclude<UpdateStateVerification, { status: "consistent" }>;
  gateway: ObservedGateway;
  /** What this command left as it was. */
  unchanged: string;
}): string {
  const { verification } = params;
  const finding =
    verification.status === "unverifiable"
      ? `Verification against installed OpenClaw ${VERSION} could not complete: ${verification.detail}.`
      : `Verification against installed OpenClaw ${VERSION} found that ${verification.detail}.`;
  return `Update ${params.runId} recorded data at risk (${params.mark}). ${finding} ${describeGateway(params.gateway)} ${params.unchanged} ${verification.nextAction}`;
}

/**
 * Before a plain update creates its run: verify the newest unverified data-at-risk mark.
 * Consistent: report one line and return the recorder for the receipt on the new run.
 * Newer state or an unreadable database: warn and continue, since the update's own
 * schema checks still guard activation and updating is the named fix. Any other
 * finding refuses with nothing changed.
 */
export async function verifyRecordedDataAtRiskBeforeUpdate(
  env: NodeJS.ProcessEnv,
  timeoutMs: number | undefined,
): Promise<((runId: string) => void) | undefined> {
  const latest = findLatestUnverifiedDataAtRisk(listUpdateRuns({ limit: 100 }, { env }));
  if (!latest) {
    return undefined;
  }
  const verification = await verifyUpdateStateConsistency({
    env,
    formatCommand: (command) => formatCliCommand(command, env),
  });
  const markedRunId = latest.run.runId;
  if (verification.status === "consistent") {
    const detail = formatDataAtRiskResolved({
      runId: markedRunId,
      mark: latest.mark,
      verification,
    });
    defaultRuntime.error(detail);
    return (runId) =>
      recordUpdateRunStep(
        runId,
        {
          step: dataAtRiskVerifiedStep(markedRunId),
          status: "completed",
          endedAtMs: Date.now(),
          detail,
        },
        { env },
      );
  }
  const continues = verification.status === "unverifiable" || verification.newerState === true;
  const refusal = formatDataAtRiskRefusal({
    runId: markedRunId,
    mark: latest.mark,
    verification,
    gateway: await observeGatewayForGuidance({ service: resolveGatewayService(), env, timeoutMs }),
    unchanged: continues
      ? "The update continues; its own checks still guard activation."
      : "The update changed nothing.",
  });
  if (!continues) {
    throw new Error(refusal);
  }
  defaultRuntime.error(`Warning: ${refusal}`);
  return undefined;
}
