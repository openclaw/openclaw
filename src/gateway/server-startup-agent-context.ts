import crypto from "node:crypto";
import fs from "node:fs";
import type { OpenClawConfig } from "../config/config.js";
import { listAgentIds } from "../agents/agent-scope.js";
import {
  ensureConfiguredAgentContextLayouts,
  syncSessionEntryContextMetadata,
  upsertChatIndex,
} from "../agents/chat-context-store.js";
import { CONTEXT_COMPACT_THRESHOLD } from "../agents/context-policy.js";
import {
  resolveAgentMainSessionKey,
  resolveStorePath,
  type SessionEntry,
  updateSessionStore,
} from "../config/sessions.js";
import { persistChatSummary } from "./chat-context.js";
import { readSessionMessages, resolveSessionTranscriptCandidates } from "./session-utils.js";

const CONTEXT_MIGRATION_VERSION = 1;
let migrationInFlight: Promise<void> | null = null;

type SessionMigrationEntry = SessionEntry & {
  contextMigrationVersion?: number;
  archivedFromSessionKey?: string;
};

function shouldArchiveForMigration(entry: SessionEntry, messages: unknown[]): boolean {
  if (entry.archivedAt) {
    return false;
  }
  if (typeof entry.totalTokens === "number" && entry.totalTokens >= CONTEXT_COMPACT_THRESHOLD) {
    return true;
  }
  return messages.length > 80;
}

function createFreshMainSession(entry?: SessionEntry): SessionEntry {
  const now = Date.now();
  return {
    sessionId: crypto.randomUUID(),
    updatedAt: now,
    systemSent: false,
    abortedLastRun: false,
    historyLoadMode: "summary",
    thinkingLevel: entry?.thinkingLevel,
    verboseLevel: entry?.verboseLevel,
    reasoningLevel: entry?.reasoningLevel,
    responseUsage: entry?.responseUsage,
    model: entry?.model,
    modelOverride: entry?.modelOverride,
    providerOverride: entry?.providerOverride,
    label: entry?.label,
    displayName: entry?.displayName,
    sendPolicy: entry?.sendPolicy,
  };
}

function asMigrationEntry(entry: SessionEntry): SessionMigrationEntry {
  return entry as SessionMigrationEntry;
}

function buildArchivedMainSessionKey(mainSessionKey: string, entry: SessionEntry): string {
  return `${mainSessionKey}:archived:${entry.sessionId ?? "legacy"}`;
}

async function migrateAgentContextStore(params: {
  cfg: OpenClawConfig;
  agentId: string;
  log: { info?: (msg: string) => void; warn: (msg: string) => void };
}) {
  const storePath = resolveStorePath(params.cfg.session?.store, { agentId: params.agentId });
  const mainSessionKey = resolveAgentMainSessionKey({ cfg: params.cfg, agentId: params.agentId });
  await updateSessionStore(storePath, (mutable) => {
    const store = mutable as Record<string, SessionMigrationEntry>;
    for (const [key, entry] of Object.entries(store)) {
      syncSessionEntryContextMetadata({ entry, agentId: params.agentId, sessionKey: key });
      upsertChatIndex({
        agentId: params.agentId,
        sessionKey: key,
        sessionId: entry.sessionId,
        historyMode: entry.historyLoadMode,
        archivedAt: entry.archivedAt,
        summaryUpdatedAt: entry.summaryUpdatedAt,
      });
      if (entry.contextMigrationVersion === CONTEXT_MIGRATION_VERSION) {
        continue;
      }
      const transcriptPath = resolveSessionTranscriptCandidates(
        entry.sessionId,
        storePath,
        entry.sessionFile,
        params.agentId,
      ).find((candidate: string) => fs.existsSync(candidate));
      if (transcriptPath) {
        const messages = readSessionMessages(entry.sessionId, storePath, entry.sessionFile);
        if (messages.length > 0 && !entry.summaryUpdatedAt) {
          const summary = persistChatSummary({
            agentId: params.agentId,
            sessionKey: key,
            sessionId: entry.sessionId,
            entry,
            messages,
          });
          entry.summaryUpdatedAt = summary.updatedAt;
        }
        entry.historyLoadMode = entry.historyLoadMode === "full" ? "full" : "summary";
        if (
          key === mainSessionKey &&
          shouldArchiveForMigration(entry, messages) &&
          !entry.archivedAt
        ) {
          const archivedKey = buildArchivedMainSessionKey(mainSessionKey, entry);
          if (!store[archivedKey]) {
            const archivedEntry: SessionMigrationEntry = {
              ...entry,
              archivedAt: Date.now(),
              updatedAt: Date.now(),
              archivedFromSessionKey: mainSessionKey,
              contextMigrationVersion: CONTEXT_MIGRATION_VERSION,
            };
            syncSessionEntryContextMetadata({
              entry: archivedEntry,
              agentId: params.agentId,
              sessionKey: archivedKey,
            });
            store[archivedKey] = archivedEntry;
            upsertChatIndex({
              agentId: params.agentId,
              sessionKey: archivedKey,
              sessionId: archivedEntry.sessionId,
              historyMode: archivedEntry.historyLoadMode,
              archivedAt: archivedEntry.archivedAt,
              summaryUpdatedAt: archivedEntry.summaryUpdatedAt,
            });
          }
          const freshMainEntry = asMigrationEntry(createFreshMainSession(entry));
          syncSessionEntryContextMetadata({
            entry: freshMainEntry,
            agentId: params.agentId,
            sessionKey: mainSessionKey,
          });
          freshMainEntry.contextMigrationVersion = CONTEXT_MIGRATION_VERSION;
          store[mainSessionKey] = freshMainEntry;
          upsertChatIndex({
            agentId: params.agentId,
            sessionKey: mainSessionKey,
            sessionId: freshMainEntry.sessionId,
            historyMode: freshMainEntry.historyLoadMode,
            archivedAt: freshMainEntry.archivedAt,
            summaryUpdatedAt: freshMainEntry.summaryUpdatedAt,
          });
          continue;
        }
      }
      entry.contextMigrationVersion = CONTEXT_MIGRATION_VERSION;
    }
  });
  params.log.info?.(`agent context migration complete for "${params.agentId}"`);
}

export async function runAgentContextMigration(params: {
  cfg: OpenClawConfig;
  log: { info?: (msg: string) => void; warn: (msg: string) => void };
}): Promise<void> {
  ensureConfiguredAgentContextLayouts(params.cfg);
  for (const agentId of listAgentIds(params.cfg)) {
    await migrateAgentContextStore({ cfg: params.cfg, agentId, log: params.log });
  }
}

export function runAgentContextMigrationWithBarrier(params: {
  cfg: OpenClawConfig;
  log: { info?: (msg: string) => void; warn: (msg: string) => void };
}): Promise<void> {
  if (migrationInFlight) {
    return migrationInFlight;
  }
  migrationInFlight = runAgentContextMigration(params).finally(() => {
    migrationInFlight = null;
  });
  return migrationInFlight;
}
