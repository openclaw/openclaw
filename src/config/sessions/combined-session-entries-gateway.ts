import {
  canonicalizeSpawnedByForAgent,
  resolveStoredSessionRowKeyForAgent,
} from "../../gateway/session-row-key.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { listSessionEntries } from "./store.js";
import {
  resolveAgentSessionDatabaseTargetsSync,
  resolveAllAgentSessionDatabaseTargetsSync,
} from "./targets.js";
import type { SessionEntry } from "./types.js";

function mergeSessionEntryIntoCombined(params: {
  cfg: OpenClawConfig;
  combined: Record<string, SessionEntry>;
  entry: SessionEntry;
  agentId: string;
  canonicalKey: string;
}) {
  const { cfg, combined, entry, agentId, canonicalKey } = params;
  const existing = combined[canonicalKey];

  if (existing && (existing.updatedAt ?? 0) > (entry.updatedAt ?? 0)) {
    const spawnedBy = canonicalizeSpawnedByForAgent(
      cfg,
      agentId,
      existing.spawnedBy ?? entry.spawnedBy,
    );
    combined[canonicalKey] = {
      ...entry,
      ...existing,
      spawnedBy,
    };
    return;
  }

  const spawnedBy = canonicalizeSpawnedByForAgent(
    cfg,
    agentId,
    entry.spawnedBy ?? existing?.spawnedBy,
  );
  if (!existing && entry.spawnedBy === spawnedBy) {
    combined[canonicalKey] = entry;
  } else {
    combined[canonicalKey] = {
      ...existing,
      ...entry,
      spawnedBy,
    };
  }
}

export function loadCombinedSessionEntriesForGateway(
  cfg: OpenClawConfig,
  opts: { agentId?: string } = {},
): {
  databasePath: string;
  entries: Record<string, SessionEntry>;
} {
  const requestedAgentId =
    typeof opts.agentId === "string" && opts.agentId.trim()
      ? normalizeAgentId(opts.agentId)
      : undefined;
  const targets = requestedAgentId
    ? resolveAgentSessionDatabaseTargetsSync(cfg, requestedAgentId)
    : resolveAllAgentSessionDatabaseTargetsSync(cfg);
  const combined: Record<string, SessionEntry> = {};
  for (const target of targets) {
    const agentId = target.agentId;
    for (const { sessionKey: key, entry } of listSessionEntries({ agentId })) {
      const canonicalKey = resolveStoredSessionRowKeyForAgent({
        cfg,
        agentId,
        sessionKey: key,
      });
      mergeSessionEntryIntoCombined({
        cfg,
        combined,
        entry,
        agentId,
        canonicalKey,
      });
    }
  }

  const databasePath =
    requestedAgentId && targets.length > 0
      ? targets[0].databasePath
      : targets.length === 1
        ? targets[0].databasePath
        : "(multiple)";
  return { databasePath, entries: combined };
}
