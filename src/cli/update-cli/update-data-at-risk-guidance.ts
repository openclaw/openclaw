import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GatewayService } from "../../daemon/service.js";
import type { UpdateStateVerification } from "../../infra/update-data-at-risk.js";
import { VERSION } from "../../version.js";
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
