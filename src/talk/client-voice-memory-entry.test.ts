import { afterEach, expect, it, vi } from "vitest";
import { createMemorySessionActorOwner } from "../config/sessions/session-actor-memory.js";
import { runWithSessionActorStorage } from "../config/sessions/session-actor-storage-binding.js";
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

const owners: ReturnType<typeof createMemorySessionActorOwner>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) {
    owner.close();
  }
});

it("ensures the actor's conversation identity and publishes its committed entry without a voice metadata store", async () => {
  const scope = {
    agentId: "main",
    sessionKey: "agent:main:dashboard:incognito-voice-memory",
    storePath: "/synthetic/incognito-voice",
  };
  const owner = createMemorySessionActorOwner({ agentId: scope.agentId, path: scope.storePath });
  owners.push(owner);
  const actor = await owner.acquire(
    { database: owner.identity, sessionKey: scope.sessionKey },
    { assertCurrent() {}, assertReadable() {} },
  );
  const authority = { assertCurrent() {}, authorize() {} };
  const binding = { actor, authority, agentId: scope.agentId, path: scope.storePath };
  await runWithSessionActorStorage(binding, async () => {
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
  });
});
