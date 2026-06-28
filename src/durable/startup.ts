import { createSubsystemLogger } from "../logging/subsystem.js";
// Gateway startup integration for the durable workflow control plane.
import { isDurableWorkflowsEnabled } from "./config.js";
import { reconcileDurableAgentTurnsOnGatewayStartup } from "./recovery.js";
import { openDurableWorkflowSqliteStore } from "./sqlite-store.js";

const log = createSubsystemLogger("durable/workflows");

export async function maybeRecordDurableGatewayStartup(params: {
  processInstanceId: string;
  startupStartedAt: number;
  port?: number;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const env = params.env ?? process.env;
  if (!isDurableWorkflowsEnabled(env)) {
    return;
  }
  let store: ReturnType<typeof openDurableWorkflowSqliteStore> | null = null;
  try {
    store = openDurableWorkflowSqliteStore({ env });
    const recovery = reconcileDurableAgentTurnsOnGatewayStartup({
      store,
      processInstanceId: params.processInstanceId,
      now: params.startupStartedAt,
    });
    const run = store.createRun({
      workflowId: "openclaw.gateway.startup",
      workflowVersion: "1",
      status: "succeeded",
      recoveryState: "terminal",
      sourceType: "gateway",
      sourceRef: params.processInstanceId,
      metadata: {
        processInstanceId: params.processInstanceId,
        startupStartedAt: params.startupStartedAt,
        port: params.port,
      },
    });
    store.appendEvent({
      workflowRunId: run.workflowRunId,
      eventType: "gateway.startup.succeeded",
      payload: {
        processInstanceId: params.processInstanceId,
        startupStartedAt: params.startupStartedAt,
        port: params.port,
      },
    });
    const stats = store.getStats();
    log.info("recorded durable gateway startup", {
      workflowRunId: run.workflowRunId,
      path: stats.path,
      runs: stats.runs,
      events: stats.events,
      reconciledLostAgentTurns: recovery.markedLost,
    });
  } catch (err) {
    log.warn(`durable workflow startup record failed: ${String(err)}`);
  } finally {
    store?.close();
  }
}
