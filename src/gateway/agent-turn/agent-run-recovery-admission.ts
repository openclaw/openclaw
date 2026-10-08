import {
  commitMainSessionRecovery,
  type MainSessionRecoveryPendingTarget,
} from "../../agents/main-session-recovery/main-session-recovery-store.js";

/** Bind durable recovery admission to the exact restoration needed if execution never starts. */
export async function admitAgentRestartRecovery(params: {
  lifecycleGeneration: string;
  runId: string;
  sessionId: string;
  sessionKey: string;
  storePath: string;
}): Promise<() => Promise<MainSessionRecoveryPendingTarget | undefined>> {
  const admission = await commitMainSessionRecovery({
    command: {
      kind: "admit_recovery",
      lifecycleGeneration: params.lifecycleGeneration,
      now: Date.now(),
      runId: params.runId,
      sessionId: params.sessionId,
    },
    requireWriteSuccess: true,
    target: { sessionKey: params.sessionKey, storePath: params.storePath },
  });
  if (admission.transition.kind !== "admitted_recovery") {
    throw new Error(
      `Session "${params.sessionKey}" restart recovery reservation is stale; recovery was skipped.`,
    );
  }
  const sessionKey = admission.sessionKey ?? params.sessionKey;
  const admittedAttempt = admission.transition.admission;
  let restored = false;
  return async () => {
    if (restored) {
      return undefined;
    }
    const recovery = await commitMainSessionRecovery({
      command: {
        kind: "mark_admitted_recovery_interrupted",
        ...admittedAttempt,
        now: Date.now(),
      },
      requireWriteSuccess: true,
      target: { sessionKey, storePath: params.storePath },
    });
    restored = true;
    return (recovery.transition.kind === "applied" || recovery.transition.kind === "no_change") &&
      recovery.entry?.sessionId === params.sessionId &&
      recovery.sessionKey
      ? {
          sessionId: recovery.entry.sessionId,
          sessionKey: recovery.sessionKey,
          storePath: params.storePath,
        }
      : undefined;
  };
}
