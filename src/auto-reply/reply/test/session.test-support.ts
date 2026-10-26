import fs from "node:fs/promises";
import path from "node:path";
import type { InternalSessionEntry as SessionEntry } from "../../../config/sessions.js";
import {
  appendTranscriptEvent,
  listSessionEntriesCore,
  loadSessionEntry,
  replaceSessionEntry,
  upsertSessionEntryCore,
} from "../../../config/sessions/session-accessor.js";
import { normalizeLegacySessionEntryDelivery } from "../../../infra/state-migrations.legacy-session-store.js";
import { projectSessionDeliveryFields } from "../../../utils/delivery-context.shared.js";
import { finalizeInboundContext } from "../inbound-context.js";
import { initSessionState as initSessionStateRaw } from "../session.js";

type ProjectedSessionEntry = SessionEntry & ReturnType<typeof projectSessionDeliveryFields>;
type SessionFixtureScope = { storePath: string; sessionKey: string; sessionId: string };

function projectSessionEntry(entry: SessionEntry): ProjectedSessionEntry {
  return { ...entry, ...projectSessionDeliveryFields(entry.delivery) };
}

export const initSessionState = async (
  params: Omit<Parameters<typeof initSessionStateRaw>[0], "ctx" | "commandAuthorized"> & {
    ctx: Record<string, unknown>;
    commandAuthorized?: boolean;
  },
) => {
  const result = await initSessionStateRaw({
    ...params,
    commandAuthorized: params.commandAuthorized ?? true,
    ctx: finalizeInboundContext(params.ctx),
  });
  return { ...result, sessionEntry: projectSessionEntry(result.sessionEntry) };
};

export async function writeSessionStore(
  storePath: string,
  store: Record<string, SessionEntry | Record<string, unknown>>,
): Promise<void> {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  for (const [sessionKey, entry] of Object.entries(store)) {
    const canonical = normalizeLegacySessionEntryDelivery(entry as SessionEntry);
    if (typeof entry.sessionId === "string" && entry.sessionId.trim()) {
      await replaceSessionEntry({ storePath, sessionKey }, canonical);
    } else {
      await upsertSessionEntryCore({ storePath, sessionKey }, canonical);
    }
  }
}

export async function writeTerminalTranscriptSessionStore(
  params: SessionFixtureScope & {
    status?: SessionEntry["status"];
    updatedAt: number;
    endedAt: number;
    transcriptMutationOrder: "after-registry" | "before-registry";
  },
): Promise<void> {
  const { storePath, sessionKey, transcriptMutationOrder, ...entry } = params;
  const appendTranscript = () =>
    appendTranscriptEvent(
      { agentId: "main", sessionId: entry.sessionId, sessionKey, storePath },
      { type: "custom", timestamp: "1970-01-01T00:00:00.001Z" },
    );
  if (transcriptMutationOrder === "before-registry") {
    await appendTranscript();
  }
  await writeSessionStore(storePath, {
    [sessionKey]: {
      ...entry,
      sessionFile: `${entry.sessionId}.jsonl`,
      startedAt: entry.endedAt - 10_000,
      runtimeMs: 9_000,
      status: entry.status ?? "done",
    },
  });
  if (transcriptMutationOrder === "after-registry") {
    await appendTranscript();
  }
}

export function readSessionStore(storePath: string): Record<string, ProjectedSessionEntry> {
  const rows = listSessionEntriesCore({ storePath });
  const entries = Object.fromEntries(
    rows.map(({ sessionKey, entry }) => [sessionKey, projectSessionEntry(entry)]),
  ) as Record<string, ProjectedSessionEntry>;
  return new Proxy(entries, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && !(prop in target)) {
        const entry = loadSessionEntry({ storePath, sessionKey: prop, readConsistency: "latest" });
        if (entry) {
          target[prop] = projectSessionEntry(entry);
        }
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

export async function runExplicitResetCases(
  params: SessionFixtureScope & { entry?: Record<string, unknown> },
) {
  const { storePath, sessionKey, sessionId, entry } = params;
  const results = [];
  for (const name of ["new", "reset"] as const) {
    const body = `/${name}`;
    await writeSessionStore(storePath, {
      [sessionKey]: { sessionId, updatedAt: Date.now(), ...entry },
    });
    const result = await initSessionState({
      ctx: {
        Body: body,
        From: "reset-user",
        To: "bot",
        ChatType: "direct",
        SessionKey: sessionKey,
        Provider: "telegram",
        Surface: "telegram",
      },
      cfg: { session: { store: storePath } },
    });
    results.push({ name, body, result, stored: readSessionStore(storePath) });
  }
  return results;
}
