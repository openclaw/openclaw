import { AsyncLocalStorage } from "node:async_hooks";
import { resolveSessionModelRef } from "../agents/session-model-ref.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions.js";
import { createAgentPatchedSessionModelFallback } from "../config/sessions/session-model-fallback.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

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

export function snapshotAgentModelFallback(
  cfg: OpenClawConfig,
  entry: SessionEntry,
  agentId: string,
  now: number,
): NonNullable<SessionEntry["modelFallback"]> {
  const prior = resolveSessionModelRef(cfg, entry, agentId);
  return createAgentPatchedSessionModelFallback({
    model: prior.model,
    provider: prior.provider,
    entry,
    ts: now,
  });
}
