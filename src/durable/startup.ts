import { createSubsystemLogger } from "../logging/subsystem.js";
// Gateway startup integration for the durable runtime control plane.
import {
  isDurableAuthorityEnabled,
  isDurableRuntimeEnabled,
  isDurableWorkerEnabled,
} from "./config.js";
import { recordDurableRuntimeHealthFailure, recordDurableRuntimeHealthSuccess } from "./health.js";
import { openDurableRuntimeStore } from "./store-factory.js";

const log = createSubsystemLogger("durable/runtimes");

export function assertDurableRuntimeAuthorityAvailable(env: NodeJS.ProcessEnv = process.env): void {
  if (!isDurableAuthorityEnabled(env)) {
    return;
  }
  try {
    const store = openDurableRuntimeStore({ env });
    try {
      store.getStats();
      recordDurableRuntimeHealthSuccess();
    } finally {
      store.close();
    }
  } catch (error) {
    recordDurableRuntimeHealthFailure({
      component: "startup",
      operation: "authority_preflight",
      error,
    });
    throw new Error(`Durable authority unavailable: ${String(error)}`, { cause: error });
  }
}

/** Start recovery without loading the recovery/owner graph on disabled gateways. */
export async function startDurableGatewayRecoveryWorker(params: {
  processInstanceId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<() => void> {
  const env = params.env ?? process.env;
  if (!isDurableWorkerEnabled(env)) {
    return () => {};
  }
  const { startDurableRecoveryWorker } = await import("./recovery.js");
  return startDurableRecoveryWorker({ ...params, env });
}

export async function maybeRecordDurableGatewayStartup(params: {
  processInstanceId: string;
  startupStartedAt: number;
  port?: number;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const env = params.env ?? process.env;
  if (!isDurableRuntimeEnabled(env)) {
    return;
  }
  let store: ReturnType<typeof openDurableRuntimeStore> | null = null;
  try {
    store = openDurableRuntimeStore({ env });
    const recoveryEnabled = isDurableWorkerEnabled(env);
    let recovery = { scanned: 0, markedLost: 0 };
    let chatSendRecovery = { scanned: 0, markedLost: 0 };
    let ownerAttentionRecovery = { scanned: 0, created: 0, suspended: 0 };
    if (recoveryEnabled) {
      const [recoveryModule, ownerAdaptersModule] = await Promise.all([
        import("./recovery.js"),
        import("./owner-adapters.js"),
      ]);
      recovery = recoveryModule.reconcileDurableAgentTurnsOnGatewayStartup({
        store,
        processInstanceId: params.processInstanceId,
        now: params.startupStartedAt,
      });
      chatSendRecovery = recoveryModule.reconcileDurableChatSendsOnGatewayStartup({
        store,
        processInstanceId: params.processInstanceId,
        now: params.startupStartedAt,
      });
      ownerAttentionRecovery = ownerAdaptersModule.reconcileDurableOwnerAttentionFacts({
        store,
        now: params.startupStartedAt,
      });
    }
    const run = store.createRun({
      operationKind: "openclaw.gateway.startup",
      operationVersion: "1",
      status: "succeeded",
      recoveryState: "terminal",
      rootOperationReason: "gateway_startup_recovery_pass",
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
    recordDurableRuntimeHealthSuccess();
    log.info("recorded durable gateway startup", {
      runtimeRunId: run.runtimeRunId,
      path: stats.path,
      runs: stats.runs,
      events: stats.events,
      reconciledLostAgentTurns: recovery.markedLost,
      reconciledLostChatSends: chatSendRecovery.markedLost,
      ownerAttentionFactsScanned: ownerAttentionRecovery.scanned,
      wakeObligationsCreated: ownerAttentionRecovery.created,
      wakeObligationsSuspended: ownerAttentionRecovery.suspended,
    });
  } catch (err) {
    recordDurableRuntimeHealthFailure({
      component: "startup",
      operation: "startup_reconciliation",
      error: err,
    });
    log.warn(`durable runtime startup record failed: ${String(err)}`);
    if (isDurableAuthorityEnabled(env)) {
      throw err;
    }
  } finally {
    store?.close();
  }
}
