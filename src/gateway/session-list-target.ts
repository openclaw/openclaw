import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { isCronRunSessionKey, isSubagentSessionKey } from "../sessions/session-key-utils.js";
import {
  isCronSessionDisplayKey,
  isSystemCreatedSessionRow,
} from "../shared/session-list-visibility.js";
import type { readSessionRowModelFacts } from "./session-row-model-facts.js";
import type { materializeSessionRow } from "./session-utils-row.js";

export function readSessionListSelectionFacts(
  key: string,
  entry?: {
    sessionId?: string;
    updatedAt?: number | null;
    spawnedBy?: string;
    category?: string;
    heartbeatIsolatedBaseSessionKey?: string;
  } & Omit<Parameters<typeof isSystemCreatedSessionRow>[0], "key" | "classification">,
) {
  const parsed = parseAgentSessionKey(key);
  return {
    agentId: parsed ? normalizeAgentId(parsed.agentId) : undefined,
    isCronRun: isCronRunSessionKey(key),
    isCron: isCronSessionDisplayKey(key),
    isSystem: isSystemCreatedSessionRow({
      key,
      createdActor: entry?.createdActor,
      createdVia: entry?.createdVia,
      label: entry?.label,
      displayName: entry?.displayName,
      subject: entry?.subject,
      classification: entry?.heartbeatIsolatedBaseSessionKey ? "heartbeat" : undefined,
    }),
    isSubagent:
      isSubagentSessionKey(key) ||
      // Visible spawned conversations use dashboard keys even without a sidebar group.
      // Lineage alone must not hide the session where the human follows the work.
      Boolean(
        entry?.spawnedBy &&
        !parsed?.rest.toLowerCase().startsWith("dashboard:") &&
        !normalizeOptionalString(entry.category),
      ),
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
