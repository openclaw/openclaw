import { createSubsystemLogger } from "../logging/subsystem.js";
// Gateway startup integration for the durable runtime control plane.
import { isDurableRuntimesEnabled } from "./config.js";
import {
  reconcileDurableAgentTurnsOnGatewayStartup,
  reconcileDurableChatSendsOnGatewayStartup,
  reconcileDurableSubagentRunsOnGatewayStartup,
} from "./recovery.js";
import { openDurableRuntimeStore } from "./store-factory.js";

const log = createSubsystemLogger("durable/runtimes");

export async function maybeRecordDurableGatewayStartup(params: {
  processInstanceId: string;
  startupStartedAt: number;
  port?: number;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const env = params.env ?? process.env;
  if (!isDurableRuntimesEnabled(env)) {
    return;
  }
  let store: ReturnType<typeof openDurableRuntimeStore> | null = null;
  try {
    store = openDurableRuntimeStore({ env });
    const recovery = reconcileDurableAgentTurnsOnGatewayStartup({
      store,
      processInstanceId: params.processInstanceId,
      now: params.startupStartedAt,
    });
    const chatSendRecovery = reconcileDurableChatSendsOnGatewayStartup({
      store,
      processInstanceId: params.processInstanceId,
      now: params.startupStartedAt,
    });
    const subagentRecovery = reconcileDurableSubagentRunsOnGatewayStartup({
      store,
      processInstanceId: params.processInstanceId,
      now: params.startupStartedAt,
    });
    const run = store.createRun({
      operationKind: "openclaw.gateway.startup",
      operationVersion: "1",
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
      runtimeRunId: run.runtimeRunId,
      eventType: "gateway.startup.succeeded",
      payload: {
        processInstanceId: params.processInstanceId,
        startupStartedAt: params.startupStartedAt,
        port: params.port,
      },
    });
    const stats = store.getStats();
    log.info("recorded durable gateway startup", {
      runtimeRunId: run.runtimeRunId,
      path: stats.path,
      runs: stats.runs,
      events: stats.events,
      reconciledLostAgentTurns: recovery.markedLost,
      reconciledLostChatSends: chatSendRecovery.markedLost,
      reconciledLostSubagentRuns: subagentRecovery.markedLost,
    });
  } catch (err) {
    log.warn(`durable runtime startup record failed: ${String(err)}`);
  } finally {
    store?.close();
  }
}
