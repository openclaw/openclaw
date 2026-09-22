import fs from "node:fs";
import path from "node:path";
import { expect, onTestFinished, vi } from "vitest";
import { parseSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import {
  listSessionEntriesCore,
  loadSessionEntryReadOnly,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions/types.js";

export function createDefaultAgentResult(params?: {
  payloads?: Array<Record<string, unknown>>;
  durationMs?: number;
  sessionId?: string;
}) {
  return {
    payloads: params?.payloads ?? [{ text: "ok" }],
    meta: {
      durationMs: params?.durationMs ?? 5,
      agentMeta: { sessionId: params?.sessionId ?? "s", provider: "p", model: "m" },
    },
  };
}

export async function useRealCommandSessionPersistence(): Promise<void> {
  const [actual, runtime] = await Promise.all([
    import("../agents/command/session-store.js"),
    import("../agents/command/session-store.runtime.js"),
  ]);
  const persistence = vi
    .spyOn(runtime, "updateSessionStoreAfterAgentRun")
    .mockImplementation(actual.updateSessionStoreAfterAgentRun);
  onTestFinished(() => persistence.mockRestore());
}

export async function writeSessionStoreSeed(
  storePath: string,
  sessions: Record<string, Record<string, unknown>>,
): Promise<void> {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  for (const [sessionKey, entry] of Object.entries(sessions)) {
    const sessionId = typeof entry.sessionId === "string" ? entry.sessionId : sessionKey;
    await replaceSessionEntry({ sessionKey, storePath }, {
      ...entry,
      sessionId,
      updatedAt: typeof entry.updatedAt === "number" ? entry.updatedAt : Date.now(),
    } as SessionEntry);
  }
}

export function readSessionStore<T>(storePath: string): Record<string, T> {
  return Object.fromEntries(
    listSessionEntriesCore({ storePath }).map(({ entry, sessionKey }) => [sessionKey, entry as T]),
  );
}

export function expectSqliteSessionFileMarker(params: {
  agentId: string;
  sessionFile: string | undefined;
  sessionId?: string;
  storePath: string;
}): void {
  const marker = parseSqliteSessionFileMarker(params.sessionFile);
  expect(marker?.agentId).toBe(params.agentId);
  if (params.sessionId) {
    expect(marker?.sessionId).toBe(params.sessionId);
  } else {
    expect(marker?.sessionId).toBeTruthy();
  }
  expect(marker?.storePath).toBe(path.resolve(params.storePath));
}

export function expectOwnedCommandSession(params: {
  agentId: string;
  excludedAgentId: string;
  sessionKey: string;
  sessionId: string;
  storePath: string;
}): void {
  const entry = loadSessionEntryReadOnly({
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
    readConsistency: "latest",
  });
  expect(entry).toMatchObject({ sessionId: params.sessionId, model: "m", modelProvider: "p" });
  expect(entry?.restartRecoveryDeliveryRunId).toBeUndefined();
  expect(
    loadSessionEntryReadOnly({
      agentId: params.excludedAgentId,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
      readConsistency: "latest",
    }),
  ).toBeUndefined();
}
