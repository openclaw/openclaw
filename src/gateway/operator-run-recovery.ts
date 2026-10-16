import { isDeepStrictEqual } from "node:util";
import type { AdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { getAgentEventLifecycleGeneration } from "../infra/agent-events.js";
import { decodeGatewayOperatorRecoverySource } from "./operator-run-recovery-source.js";
import { restoreGatewayOperatorSource } from "./operator-source-recovery.js";
import type { GatewayRequestContext } from "./server-methods/shared-types.js";

export type OperatorRecoveryTarget = {
  agentId: string;
  sessionKey: string;
  storePath: string;
  sessionId: string;
  sourceRunId: string;
  recoveryRunId: string;
};

type RecoverySource = Readonly<{ controlUiAdmin: boolean; localOperator: boolean }>;
const recoverySources = new WeakMap<
  AdmittedRunOperatorAuthority,
  {
    target: OperatorRecoveryTarget;
    source: RecoverySource;
  }
>();

/** Only an exact live restore can carry the original operator admission classification. */
export function readGatewayOperatorRecoverySource(
  authority: AdmittedRunOperatorAuthority | undefined,
  target: { runId: string; sessionKey: string; sessionId: string },
): RecoverySource | undefined {
  const restored = authority && recoverySources.get(authority);
  if (
    !authority ||
    !restored ||
    restored.target.recoveryRunId !== target.runId ||
    restored.target.sessionKey !== target.sessionKey ||
    restored.target.sessionId !== target.sessionId
  ) {
    return undefined;
  }
  authority.assertCurrent();
  return restored.source;
}

/** Re-admit the exact durable source under current policy; never revive an old run capability. */
export async function restoreGatewayOperatorRecovery(params: {
  target: OperatorRecoveryTarget;
  context: GatewayRequestContext;
  assertCurrent: () => void;
}) {
  const target = { ...params.target };
  const restored = await restoreGatewayOperatorSource({
    ...params,
    target,
    readSnapshot: async (assertCurrent) => {
      const current = await readSessionEntryReadOnlyInWorker(target, assertCurrent);
      assertCurrent();
      if (!current?.restartRecoveryOperatorSource) {
        return undefined;
      }
      const source = decodeGatewayOperatorRecoverySource(current.restartRecoveryOperatorSource);
      const reservation = current.mainRestartRecovery?.reservation;
      if (
        current.sessionId !== target.sessionId ||
        current.lifecycleRevision !== source.lifecycleRevision ||
        current.restartRecoveryDeliveryRunId !== target.recoveryRunId ||
        current.restartRecoveryDeliverySourceRunId !== target.sourceRunId ||
        (reservation &&
          (reservation.runId !== target.recoveryRunId ||
            reservation.lifecycleGeneration !== getAgentEventLifecycleGeneration())) ||
        source.agentId !== target.agentId ||
        source.sessionKey !== target.sessionKey ||
        source.sessionId !== target.sessionId ||
        source.sourceRunId !== target.sourceRunId ||
        !isDeepStrictEqual(current.restartRecoveryOperatorSource, source)
      ) {
        throw new Error("Restart recovery operator source no longer owns this input.");
      }
      return source.snapshot;
    },
  });
  if (restored) {
    const snapshot = restored.authority.recoverySnapshot!;
    recoverySources.set(restored.authority, {
      target,
      source: Object.freeze({
        controlUiAdmin: snapshot.controlUiAdmin,
        localOperator: snapshot.localOperator,
      }),
    });
  }
  return restored;
}
