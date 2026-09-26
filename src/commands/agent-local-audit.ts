/** Direct-local agent audit writer lifecycle shared by CLI entrypoints. */
import { createAuditEventRecorder } from "../audit/audit-recorder.js";
import { configureExecutionDecisionWorkSink } from "../audit/execution-decision-work.js";
import {
  configureExecutionIdentityAdmissionSink,
  hasExecutionIdentityAdmissionSink,
} from "../audit/execution-identity-admission.js";
import { configureRuntimeActionDecisionSink } from "../audit/runtime-action-decision.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { GatewayScheduler } from "../infra/gateway-scheduler.js";

/** Own one direct-process writer unless a surrounding runtime already owns it. */
export function startAgentLocalAuditWriter(
  config: OpenClawConfig,
  options: { stateDir?: string } = {},
): (() => Promise<void>) | undefined {
  if (hasExecutionIdentityAdmissionSink()) {
    return undefined;
  }
  const scheduler = new GatewayScheduler();
  const recorder = createAuditEventRecorder({
    scheduler,
    getConfig: () => config,
    ...(options.stateDir ? { stateDir: options.stateDir } : {}),
  });
  const clearAdmissionSink = configureExecutionIdentityAdmissionSink(
    recorder.recordExecutionIdentity,
  );
  const clearDecisionWorkSink = configureExecutionDecisionWorkSink(
    recorder.recordExecutionDecisionWork,
  );
  const clearRuntimeActionSink = configureRuntimeActionDecisionSink(
    recorder.recordExecutionDecision,
  );
  return async () => {
    scheduler.beginClose();
    clearRuntimeActionSink();
    clearDecisionWorkSink();
    clearAdmissionSink();
    try {
      await recorder.stop();
    } finally {
      await scheduler.stop();
    }
  };
}
