import fs from "node:fs";
import path from "node:path";
import { expect, onTestFinished, vi } from "vitest";
import * as sessions from "../config/sessions/session-accessor.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions/types.js";
import { buildOutboundBaseSessionKey } from "../infra/outbound/base-session-key.js";
import { withTempHomeCore } from "../plugin-sdk/test-helpers/temp-home.js";

export async function withAgentCommandTestHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  return withTempHomeCore(fn, { prefix: "openclaw-agent-" });
}

export function createDefaultAgentResult(params?: {
  payloads?: Array<Record<string, unknown>>;
  durationMs?: number;
  sessionId?: string;
}) {
  const { payloads = [{ text: "ok" }], durationMs = 5, sessionId = "s" } = params ?? {};
  const agentMeta = { sessionId, provider: "p", model: "m" };
  return { payloads, meta: { durationMs, agentMeta } };
}

export async function useRealCommandSessionPersistence(): Promise<void> {
  const [{ updateSessionStoreAfterAgentRun: update }, runtime] = await Promise.all([
    import("../agents/command/session-store.js"),
    import("../agents/command/session-store.runtime.js"),
  ]);
  const persistence = vi
    .spyOn(runtime, "updateSessionStoreAfterAgentRun")
    .mockImplementation(update);
  onTestFinished(() => persistence.mockRestore());
}

export async function writeSessionStoreSeed(
  storePath: string,
  entries: Record<string, Record<string, unknown>>,
): Promise<void> {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  for (const [sessionKey, entry] of Object.entries(entries)) {
    const sessionId = typeof entry.sessionId === "string" ? entry.sessionId : sessionKey;
    await sessions.replaceSessionEntry({ sessionKey, storePath }, {
      ...entry,
      sessionId,
      updatedAt: typeof entry.updatedAt === "number" ? entry.updatedAt : Date.now(),
    } as SessionEntry);
  }
}

export function readSessionStore<T>(storePath: string): Record<string, T> {
  return Object.fromEntries(
    sessions
      .listSessionEntriesCore({ storePath })
      .map(({ entry, sessionKey: key }) => [key, entry as T]),
  );
}

export function expectOwnedCommandSession(
  params: Record<"agentId" | "excludedAgentId" | "sessionKey" | "sessionId" | "storePath", string>,
): void {
  const load = (agentId: string) =>
    sessions.loadSessionEntryReadOnly({
      agentId,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
      readConsistency: "latest",
    });
  const entry = load(params.agentId);
  expect(entry).toMatchObject({ sessionId: params.sessionId, model: "m", modelProvider: "p" });
  expect(load(params.excludedAgentId)).toBeUndefined();
}

export function createOutboundSessionRouteFixture(
  params: Parameters<typeof buildOutboundBaseSessionKey>[0] &
    Record<"from" | "to", string> & {
      chatType: "direct" | "group" | "channel";
    },
) {
  const baseSessionKey = buildOutboundBaseSessionKey(params);
  const { peer, chatType, from, to } = params;
  return { sessionKey: baseSessionKey, baseSessionKey, peer, chatType, from, to };
}
