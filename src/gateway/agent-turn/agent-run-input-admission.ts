import type { PrepareAgentRunDispatchParams } from "./agent-run-admission-types.js";

/** Commit a durable input only at the existing final native admission boundary. */
export async function commitAgentRunInputAdmission(
  params: PrepareAgentRunDispatchParams,
  lifecycleStorePath: string,
  assertCurrent: () => void,
): Promise<void> {
  assertCurrent();
  const sessionKey = params.resolvedSessionKey;
  if (!sessionKey || !params.commitAdmission) {
    throw new Error("Durable input admission requires an exact session target.");
  }
  await params.commitAdmission({
    runId: params.runId,
    sessionId: params.getAdmittedSessionId(),
    sessionKey,
    storePath: lifecycleStorePath,
    lifecycleGeneration: params.lifecycleGeneration,
    assertCurrent,
  });
  // Worker commit can yield to reset, Stop, and caller revocation. Such a
  // claimed input remains interrupted; it must never execute or auto-repeat.
  assertCurrent();
}
