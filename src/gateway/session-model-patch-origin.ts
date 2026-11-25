import { AsyncLocalStorage } from "node:async_hooks";

const agentSessionModelPatch = new AsyncLocalStorage<
  { kind: "agent" } | { kind: "session-status"; applied: boolean }
>();

export function withAgentSessionModelPatchOrigin<T>(run: () => T): T {
  return agentSessionModelPatch.run({ kind: "agent" }, run);
}

export async function withSessionStatusModelPatchOrigin<T>(
  run: () => Promise<T>,
): Promise<{ result: T; applied: boolean }> {
  const origin = { kind: "session-status" as const, applied: false };
  const result = await agentSessionModelPatch.run(origin, run);
  return { result, applied: origin.applied };
}

export function isAgentSessionModelPatchOrigin(): boolean {
  return agentSessionModelPatch.getStore()?.kind === "agent";
}

/** Status selections remain per-session and do not establish an automatic fallback. */
export function isSessionStatusModelPatchOrigin(): boolean {
  return agentSessionModelPatch.getStore()?.kind === "session-status";
}

/** Only the mutation owner records whether the scoped selection committed a change. */
export function recordSessionStatusModelPatchOutcome(applied: boolean): void {
  const origin = agentSessionModelPatch.getStore();
  if (origin?.kind === "session-status") {
    origin.applied ||= applied;
  }
}
