// Runs two real public-ingress turns in one session so QA can inspect their executions.
import { pathToFileURL } from "node:url";
import { createAuditEventRecorder } from "../../../../src/audit/audit-recorder.js";
import { configureExecutionIdentityAdmissionSink } from "../../../../src/audit/execution-identity-admission.js";
import { getRuntimeConfig } from "../../../../src/config/io.js";
import { GatewayScheduler } from "../../../../src/infra/gateway-scheduler.js";
import { agentCommandFromIngress } from "../../../../src/plugin-sdk/agent-runtime.js";

async function main() {
  const sessionId = process.argv[2]?.trim();
  if (!sessionId) {
    throw new Error("session id is required");
  }
  const scheduler = new GatewayScheduler();
  const recorder = createAuditEventRecorder({ scheduler, getConfig: getRuntimeConfig });
  const clearSink = configureExecutionIdentityAdmissionSink(recorder.recordExecutionIdentity);
  try {
    for (const message of [
      "Reply exactly: REPEATED-TURN-ONE",
      "Reply exactly: REPEATED-TURN-TWO",
    ]) {
      const result = await agentCommandFromIngress(
        {
          message,
          sessionId,
          sessionKey: "agent:qa:identity-repeated-turns",
          agentId: "qa",
          allowModelOverride: false,
          deliver: false,
        },
        { log: () => {}, error: () => {} } as never,
      );
      if (!result?.payloads?.some((payload) => payload.text?.trim())) {
        throw new Error("repeated public-ingress turn produced no text payload");
      }
    }
  } finally {
    scheduler.beginClose();
    clearSink();
    try {
      await recorder.stop();
    } finally {
      await scheduler.stop();
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().then(
    () => process.exit(0),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}
