// Shared store and reset fixtures for session.test.ts.
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../../../config/config.js";
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
    const patch = entry as Partial<SessionEntry>;
    const canonical = normalizeLegacySessionEntryDelivery(patch as SessionEntry);
    if (typeof patch.sessionId === "string" && patch.sessionId.trim()) {
      await replaceSessionEntry({ storePath, sessionKey }, canonical);
    } else {
      await upsertSessionEntryCore({ storePath, sessionKey }, canonical);
    }
  }
}

export async function writeTerminalTranscriptSessionStore(params: {
  storePath: string;
  sessionKey: string;
  sessionId: string;
  status?: SessionEntry["status"];
  omitStatus?: boolean;
  updatedAt: number;
  endedAt: number;
  transcriptMutationOrder: "after-registry" | "before-registry";
}): Promise<void> {
  const sessionFile = `${params.sessionId}.jsonl`;
  const status = params.status ?? (params.omitStatus ? undefined : "done");
  const appendTranscript = () =>
    appendTranscriptEvent(
      {
        agentId: "main",
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        storePath: params.storePath,
      },
      { type: "custom", timestamp: "1970-01-01T00:00:00.001Z" },
    );
  if (params.transcriptMutationOrder === "before-registry") {
    await appendTranscript();
  }
  await writeSessionStore(params.storePath, {
    [params.sessionKey]: {
      sessionId: params.sessionId,
      sessionFile,
      updatedAt: params.updatedAt,
      startedAt: params.endedAt - 10_000,
      endedAt: params.endedAt,
      runtimeMs: 9_000,
      ...(status ? { status } : {}),
    },
  });
  if (params.transcriptMutationOrder === "after-registry") {
    await appendTranscript();
  }
}

export function readSessionStore(storePath: string): Record<string, ProjectedSessionEntry> {
  const entries = Object.fromEntries(
    listSessionEntriesCore({ storePath }).map(({ sessionKey, entry }) => [
      sessionKey,
      projectSessionEntry(entry),
    ]),
  ) as Record<string, ProjectedSessionEntry>;
  return new Proxy(entries, {
    get(target, prop, receiver) {
      if (typeof prop !== "string" || prop in target) {
        return Reflect.get(target, prop, receiver);
      }
      const entry = loadSessionEntry({ storePath, sessionKey: prop, readConsistency: "latest" });
      if (entry) {
        target[prop] = projectSessionEntry(entry);
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

export async function runExplicitResetCases(params: {
  storePath: string;
  sessionKey: string;
  sessionId: string;
  entry?: Record<string, unknown>;
  ctx?: Record<string, unknown>;
  cfg?: Omit<OpenClawConfig, "session">;
}) {
  const results = [];
  for (const testCase of [
    { name: "new", body: "/new" },
    { name: "reset", body: "/reset" },
  ] as const) {
    await writeSessionStore(params.storePath, {
      [params.sessionKey]: {
        sessionId: params.sessionId,
        updatedAt: Date.now(),
        ...params.entry,
      },
    });
    const result = await initSessionState({
      ctx: {
        Body: testCase.body,
        RawBody: testCase.body,
        CommandBody: testCase.body,
        From: "reset-user",
        To: "bot",
        ChatType: "direct",
        SessionKey: params.sessionKey,
        Provider: "telegram",
        Surface: "telegram",
        ...params.ctx,
      },
      cfg: {
        ...params.cfg,
        session: { store: params.storePath, idleMinutes: 999 },
      } as OpenClawConfig,
      commandAuthorized: true,
    });
    results.push({ ...testCase, result, stored: readSessionStore(params.storePath) });
  }
  return results;
}
