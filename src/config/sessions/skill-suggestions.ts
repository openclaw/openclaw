// Session skill suggestions are one-shot hints consumed by the next interactive turn.
import { patchSessionEntry, type SessionAccessScope } from "./session-accessor.js";
import type { PendingSkillSuggestion, SessionEntry } from "./types.js";

type SessionSkillSuggestionScope = Pick<
  SessionAccessScope,
  "agentId" | "env" | "sessionKey" | "storePath"
>;

type SessionSkillSuggestionConsumption = {
  entry: SessionEntry;
  suggestion?: PendingSkillSuggestion;
};

/** Records one suggestion without replacing an earlier unconsumed suggestion. */
export async function recordSessionSkillSuggestion(
  options: SessionSkillSuggestionScope & {
    skillName: string;
    signalHash: string;
    detectedAt?: number;
  },
): Promise<boolean> {
  const skillName = options.skillName.trim();
  const signalHash = options.signalHash.trim();
  if (!skillName || !signalHash) {
    return false;
  }
  let recorded = false;
  const result = await patchSessionEntry(
    {
      agentId: options.agentId,
      env: options.env,
      sessionKey: options.sessionKey,
      storePath: options.storePath,
    },
    (entry) => {
      if (entry.pendingSkillSuggestion || entry.lastSkillSuggestionSignalHash === signalHash) {
        return null;
      }
      recorded = true;
      return {
        pendingSkillSuggestion: {
          skillName,
          detectedAt: options.detectedAt ?? Date.now(),
        },
        lastSkillSuggestionSignalHash: signalHash,
      };
    },
    { preserveActivity: true },
  );
  return Boolean(result && recorded);
}

/** Atomically clears and returns the suggestion owned by this interactive turn. */
export async function consumeSessionSkillSuggestion(
  options: SessionSkillSuggestionScope,
): Promise<SessionSkillSuggestionConsumption | undefined> {
  let currentEntry: SessionEntry | undefined;
  let suggestion: PendingSkillSuggestion | undefined;
  const result = await patchSessionEntry(
    options,
    (entry) => {
      currentEntry = entry;
      if (!entry.pendingSkillSuggestion) {
        return null;
      }
      suggestion = { ...entry.pendingSkillSuggestion };
      return { pendingSkillSuggestion: undefined };
    },
    { preserveActivity: true },
  );
  const entry = result ?? currentEntry;
  return entry ? { entry, suggestion } : undefined;
}
