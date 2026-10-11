import { afterEach, expect, it, vi } from "vitest";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import { runWithSessionActorStorage } from "../config/sessions/session-actor-storage-binding.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { ensureClientVoiceAgentSessionEntry } from "./client-voice-session-write.js";

vi.mock("node:sqlite", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:sqlite")>()),
  DatabaseSync: vi.fn(function () {
    throw new Error("Memory voice entry opened SQLite");
  }),
}));
vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  Worker: vi.fn(function () {
    throw new Error("Memory voice entry allocated a database worker");
  }),
}));

afterEach(() => memorySessionActorOwners.reset());

it.each([true, false])(
  "ensures and publishes the memory conversation without voice metadata storage (bound=%s)",
  async (bound) => {
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:dashboard:incognito-voice-memory",
      storePath: resolveIncognitoOpenClawAgentSqlitePath({
        agentId: "main",
        env: { OPENCLAW_STATE_DIR: "/synthetic/voice" },
      }),
    };
    const owner = memorySessionActorOwners.get({ agentId: scope.agentId, path: scope.storePath });
    const actor = await owner.acquire(
      { database: owner.identity, sessionKey: scope.sessionKey },
      { assertCurrent() {}, assertReadable() {} },
    );
    const authority = { assertCurrent() {}, authorize() {} };
    const binding = { actor, authority, agentId: scope.agentId, path: scope.storePath };
    const run = async () => {
      const created = await ensureClientVoiceAgentSessionEntry({
        ...scope,
        onCommitted(entry) {
          expect(actor.snapshot(authority)?.entry?.sessionId).toBe(entry.sessionId);
        },
      });
      expect(created).toBeTruthy();
      const updated = await actor.storage!.mutate(
        {
          type: "session.entry.patch",
          input: { operation: { kind: "fields", patch: { label: "current voice session" } } },
        },
        authority,
      );
      expect(updated.kind).toBe("committed");
      expect(await ensureClientVoiceAgentSessionEntry(scope)).toBe(created);
      expect(actor.snapshot(authority)?.entry).toMatchObject({
        sessionId: created,
        label: "current voice session",
        incognito: true,
      });
      await expect(
        ensureClientVoiceAgentSessionEntry({
          ...scope,
          source() {
            throw new Error("voice source revoked");
          },
        }),
      ).rejects.toThrow("voice source revoked");
      expect(actor.snapshot(authority)?.entry?.label).toBe("current voice session");
    };
    await (bound ? runWithSessionActorStorage(binding, run) : run());
  },
);
