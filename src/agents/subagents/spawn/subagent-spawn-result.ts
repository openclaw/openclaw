import { resolveSubagentSpawnAcceptedNote } from "./subagent-spawn-accepted-note.js";
import type { SpawnSubagentResult } from "./subagent-spawn-contract.js";
import { emitSessionLifecycleEvent } from "./subagent-spawn.runtime.js";
import type { SpawnSubagentMode } from "./subagent-spawn.types.js";

type AcceptedSpawnResult = Extract<SpawnSubagentResult, { status: "accepted" }> & {
  childSessionKey: string;
  mode: SpawnSubagentMode;
};

export function finalizeSubagentSpawnAcceptance(
  result: Omit<AcceptedSpawnResult, "note">,
  parentSessionKey: string,
  agentSessionKey?: string,
  label?: string,
  fallbackNote?: string,
): AcceptedSpawnResult {
  emitSessionLifecycleEvent({
    sessionKey: result.childSessionKey,
    reason: "create",
    parentSessionKey,
    label: label || undefined,
  });
  const acceptedNote = resolveSubagentSpawnAcceptedNote({
    spawnMode: result.mode,
    agentSessionKey,
  });
  return {
    ...result,
    note: fallbackNote ? `${acceptedNote} ${fallbackNote}` : acceptedNote,
  };
}
