import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildSessionEntry,
  statSessionEntrySync,
} from "../../../packages/memory-host-sdk/src/host/session-files.js";
import { readSessionResetRecallCutoff } from "../../../packages/memory-host-sdk/src/host/session-reset-recall-read.js";
import type { SessionActorAuthority } from "./session-actor-contract.js";
import { createMemorySessionActorOwner } from "./session-actor-memory.js";
import { runWithSessionActorStorage } from "./session-actor-storage-binding.js";

vi.mock("node:sqlite", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:sqlite")>()),
  DatabaseSync: vi.fn(function () {
    throw new Error("Memory corpus opened SQLite");
  }),
}));
vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  Worker: vi.fn(function () {
    throw new Error("Memory corpus allocated a worker");
  }),
}));

const authority: SessionActorAuthority = { assertCurrent() {}, authorize() {} };
const lifetime = { assertCurrent() {}, assertReadable() {} };
const scope = {
  agentId: "main",
  sessionId: "before-reset",
  sessionKey: "agent:main:dashboard:incognito-memory-corpus",
  storePath: "/synthetic/memory-corpus",
};
const owners: ReturnType<typeof createMemorySessionActorOwner>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) {
    owner.close();
  }
});
const message = (id: string, text: string) => ({
  type: "message",
  id,
  parentId: null,
  timestamp: "2026-10-11T00:00:00.000Z",
  message: { role: "user", content: text },
});

async function fixture() {
  const owner = createMemorySessionActorOwner({ agentId: scope.agentId, path: scope.storePath });
  owners.push(owner);
  const acquire = () =>
    owner.acquire({ database: owner.identity, sessionKey: scope.sessionKey }, lifetime);
  const actor = await acquire();
  const created = await actor.storage!.mutate(
    {
      type: "session.entry.create",
      input: {
        entry: { sessionId: scope.sessionId, updatedAt: 1 },
        transcriptEvents: [
          { type: "session", id: scope.sessionId, version: 3, cwd: "/synthetic" },
          message("old", "Previous discussion"),
          { type: "reset", id: "reset", parentId: "old", firstKeptEntryId: "old" },
          message("new", "Current discussion"),
        ],
      },
    },
    authority,
  );
  expect(created.kind).toBe("committed");
  return { actor, acquire };
}

describe("Memory export from the session actor", () => {
  it("projects retained snapshots and reset cutoff through the host facade without native storage", async () => {
    const { actor, acquire } = await fixture();
    const expected = await actor.storage!.read(
      { type: "session.entry.read", input: {} },
      authority,
    );
    expect(
      (
        await actor.storage!.mutate(
          {
            type: "session.lifecycle.reset",
            input: { expected, nextEntry: { ...expected!, sessionId: "after-reset" } },
          },
          authority,
        )
      ).kind,
    ).toBe("committed");
    const current = await acquire();
    await runWithSessionActorStorage(
      { actor: current, authority, agentId: scope.agentId, path: scope.storePath },
      async () => {
        const entry = await buildSessionEntry(scope.sessionKey, scope);
        expect(entry?.content).toBe("User: Previous discussion\nUser: Current discussion");
        expect(await readSessionResetRecallCutoff(scope)).toEqual({
          state: "valid",
          cutoffLine: 2,
        });
        expect(await readSessionResetRecallCutoff({ ...scope, sessionId: "after-reset" })).toEqual({
          state: "absent",
        });
        expect(() => statSessionEntrySync(scope.sessionKey, scope)).toThrow("buildSessionEntry");
      },
    );
  });

  it("blocks the next transcript disclosure when permission is revoked by a consumer callback", async () => {
    const { actor } = await fixture();
    let allowed = true;
    const selectedAuthority: SessionActorAuthority = {
      assertCurrent() {},
      authorize() {
        if (!allowed) {
          throw new Error("Memory disclosure was revoked");
        }
      },
    };
    const disclosed: unknown[] = [];
    await expect(
      runWithSessionActorStorage(
        { actor, authority: selectedAuthority, agentId: scope.agentId, path: scope.storePath },
        () =>
          buildSessionEntry(scope.sessionKey, {
            ...scope,
            onTranscriptMessage(value) {
              disclosed.push(value);
              allowed = false;
            },
          }),
      ),
    ).rejects.toThrow("Memory disclosure was revoked");
    expect(disclosed).toEqual([{ role: "user", content: "Previous discussion" }]);
  });
});
