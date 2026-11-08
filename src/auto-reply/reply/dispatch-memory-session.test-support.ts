import { afterEach } from "vitest";
import { createMemorySessionActorOwner } from "../../config/sessions/session-actor-memory.js";
import { runWithSessionActorStorage } from "../../config/sessions/session-actor-storage-binding.js";
import { readSessionActorStorageResult } from "../../config/sessions/session-actor-storage-result.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { sessionStoreMocks } from "./dispatch-from-config.shared.test-harness.js";

export const dispatchMemorySessionScope = {
  agentId: "test",
  sessionKey: "agent:test:dashboard:incognito-dispatch-settlement",
  storePath: resolveIncognitoOpenClawAgentSqlitePath({
    agentId: "test",
    env: { OPENCLAW_STATE_DIR: "/synthetic/dispatch-settlement" },
  }),
};

const closeSessions: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closeSessions.splice(0)) {
    await close();
  }
});

/** Dispatch uses fixed transport fixtures while the real actor owns delivery settlement. */
export async function createDispatchMemorySession(entry: InternalSessionEntry) {
  const scope = dispatchMemorySessionScope;
  const owner = createMemorySessionActorOwner({ agentId: scope.agentId, path: scope.storePath });
  const actor = await owner.acquire(
    { database: owner.identity, sessionKey: scope.sessionKey },
    { assertCurrent() {}, assertReadable() {} },
  );
  closeSessions.push(async () => {
    await actor.release();
    owner.close();
  });
  const authority = { assertCurrent() {}, authorize() {} };
  const storage = actor.storage!;
  readSessionActorStorageResult(
    await storage.mutate(
      {
        type: "session.metadata.initialize",
        input: { scope: { ...scope, sessionId: entry.sessionId }, entry },
      },
      authority,
    ),
  );
  const read = () => actor.snapshot(authority)?.entry;
  sessionStoreMocks.currentEntry = { ...read() };
  return {
    scope,
    read,
    run<T>(consume: () => T): T {
      return runWithSessionActorStorage(
        { actor, authority, agentId: scope.agentId, path: scope.storePath },
        consume,
      );
    },
    async patch(patch: Partial<InternalSessionEntry>): Promise<void> {
      readSessionActorStorageResult(
        await storage.mutate(
          { type: "session.entry.patch", input: { operation: { kind: "fields", patch } } },
          authority,
        ),
      );
      sessionStoreMocks.currentEntry = { ...read() };
    },
  };
}
