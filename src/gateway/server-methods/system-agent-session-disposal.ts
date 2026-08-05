import {
  retainRetiredSystemAgentMutationSettlement,
  retireSystemAgentGatewayExecution,
  retireSystemAgentOwnerExecution,
} from "./system-agent-execution-lifecycle.js";
import type { GatewayRequestContext } from "./types.js";

export async function disposeSystemAgentSessionsForOwner(
  sessions: GatewayRequestContext["systemAgentSessions"],
  ownerKey: string,
): Promise<void> {
  // Tombstone first so a request admitted before disconnect cannot publish a
  // freshly initialized session after this snapshot.
  retireSystemAgentOwnerExecution(sessions, ownerKey);
  const ownedSessions = Array.from(sessions.entries()).filter(
    ([, session]) => session.ownerKey === ownerKey,
  );
  for (const [sessionId] of ownedSessions) {
    sessions.delete(sessionId);
  }
  const persistentApplySettlements = ownedSessions
    .map(([, session]) => session.engine.getPersistentApplySettlement())
    .filter((settlement): settlement is Promise<void> => settlement !== null);
  if (persistentApplySettlements.length > 0) {
    retainRetiredSystemAgentMutationSettlement(
      Promise.allSettled(persistentApplySettlements).then(() => undefined),
    );
  }
  const disposal = Promise.allSettled(
    ownedSessions.map(([, session]) => session.engine.dispose()),
  ).then((results) => {
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        `Failed to dispose system-agent sessions for ${ownerKey}`,
      );
    }
  });
  await disposal;
}

export async function disposeSystemAgentSessions(
  sessions: GatewayRequestContext["systemAgentSessions"],
  wizardSessions: GatewayRequestContext["wizardSessions"],
): Promise<void> {
  // Retire before inspecting either map. Wizard publishers assert this same
  // tombstone immediately before their synchronous map insertion.
  const gatewayMutationSettlement = retireSystemAgentGatewayExecution(sessions);
  const ownedWizards = Array.from(wizardSessions.values());
  wizardSessions.clear();
  for (const wizard of ownedWizards) {
    wizard.cancel();
  }
  const wizardSettlement = Promise.all(ownedWizards.map((wizard) => wizard.whenSettled())).then(
    () => undefined,
  );
  // Clear ownership before awaiting disposal so no new request can rediscover
  // a generation whose engines are already releasing QR secrets and timers.
  const ownedSessions = Array.from(sessions.values());
  sessions.clear();
  const persistentApplySettlements = ownedSessions
    .map((session) => session.engine.getPersistentApplySettlement())
    .filter((settlement): settlement is Promise<void> => settlement !== null);
  const mutationSettlement = Promise.all([
    gatewayMutationSettlement,
    wizardSettlement,
    ...persistentApplySettlements,
  ]).then(() => undefined);
  retainRetiredSystemAgentMutationSettlement(mutationSettlement);
  const results = await Promise.allSettled([
    mutationSettlement,
    ...ownedSessions.map((session) => session.engine.dispose()),
  ]);
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((failure) => failure.reason),
      "Failed to dispose system-agent sessions",
    );
  }
}
