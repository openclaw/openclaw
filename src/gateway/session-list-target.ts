import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SessionEntry } from "../config/sessions/types.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { isCronRunSessionKey, isSubagentSessionKey } from "../sessions/session-key-utils.js";
import type { readSessionRowModelFacts } from "./session-row-model-facts.js";
import type { materializeSessionRow } from "./session-utils-row.js";

export function readSessionListSelectionFacts(key: string, entry?: SessionEntry) {
  const parsed = parseAgentSessionKey(key);
  return {
    agentId: parsed ? normalizeAgentId(parsed.agentId) : undefined,
    isCronRun: isCronRunSessionKey(key),
    isSubagent: isSubagentSessionKey(key) || Boolean(entry?.spawnedBy),
    isPhantom:
      entry?.updatedAt == null &&
      !normalizeOptionalString(entry?.sessionId) &&
      parsed?.rest === "sessions",
  };
}

/** Cold rows prepare only the model facts needed by search. */
export type SessionListTargetLookup = (key: string) =>
  | {
      agentId: string;
      selection: ReturnType<typeof readSessionListSelectionFacts>;
      storeKey?: string;
      materialized?: Pick<ReturnType<typeof materializeSessionRow>, "source">;
      getModelFacts?: () => Pick<
        ReturnType<typeof readSessionRowModelFacts>,
        "selectedModel" | "rowModelIdentity" | "thinkingProjection"
      >;
    }
  | undefined;
