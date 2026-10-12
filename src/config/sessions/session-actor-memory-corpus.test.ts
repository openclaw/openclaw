import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildSessionEntry,
  statSessionEntrySync,
} from "../../../packages/memory-host-sdk/src/host/session-files.js";
import { readSessionResetRecallCutoff } from "../../../packages/memory-host-sdk/src/host/session-reset-recall-read.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import type { SessionActorAuthority } from "./session-actor-contract.js";
import { memorySessionActorOwners } from "./session-actor-memory-owner.js";
import {
  acquireSessionActorStorage,
  runWithSessionActorStorage,
} from "./session-actor-storage-binding.js";
import {
  readSessionTranscriptCorpusInWorker,
  resolveMemorySessionTargetsInWorker,
} from "./session-transcript-inventory-runtime.js";

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
const env = { OPENCLAW_STATE_DIR: "/synthetic/memory-corpus" };
const scope = {
  agentId: "main",
  sessionId: "before-reset",
  sessionKey: "agent:main:dashboard:incognito-memory-corpus",
  storePath: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env }),
  env,
};
const owners: Array<{ agentId: string; path: string }> = [];
afterEach(() => {
  for (const owner of owners.splice(0)) {
    memorySessionActorOwners.closeDatabase(owner);
  }
});
const message = (id: string, text: string) => ({
  type: "message",
  id,
  parentId: null,
  timestamp: "2026-10-11T00:00:00.000Z",
  message: { role: "user", content: text },
});

async function fixture(target = scope) {
  const { sessionId: _sessionId, ...acquisition } = target;
  owners.push({ agentId: target.agentId, path: target.storePath });
  const initial = await acquireSessionActorStorage(acquisition, {
    lifetime,
    authority,
    create: true,
  });
  if (!initial) {
    throw new Error("Memory creation did not select the actor");
  }
  const actor = initial.actor;
  const created = await actor.storage!.mutate(
    {
      type: "session.entry.create",
      input: {
        entry: { sessionId: target.sessionId, updatedAt: 1 },
        transcriptEvents: [
          { type: "session", id: target.sessionId, version: 3, cwd: "/synthetic" },
          message("old", "Previous discussion"),
          { type: "reset", id: "reset", parentId: "old", firstKeptEntryId: "old" },
          message("new", "Current discussion"),
        ],
      },
    },
    authority,
  );
  expect(created.kind).toBe("committed");
  return { actor };
}

describe("Memory export from the session actor", () => {
  it("projects retained snapshots and reset cutoff through the host facade without native storage", async () => {
    const { actor } = await fixture();
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
  });

  it("reads another agent's memory inventory and leaves an absent explicit owner absent", async () => {
    const { actor } = await fixture();
    const other = {
      ...scope,
      agentId: "other",
      sessionId: "other-window",
      sessionKey: "agent:other:dashboard:incognito-other",
      storePath: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "other", env }),
    };
    await fixture(other);
    await runWithSessionActorStorage(
      { actor, authority, agentId: scope.agentId, path: scope.storePath },
      async () => {
        expect((await buildSessionEntry(other.sessionKey, other))?.content).toContain(
          "Current discussion",
        );
        const entries = await readSessionTranscriptCorpusInWorker(
          {
            cfg: {},
            env,
            normalizedAgentId: other.agentId,
            storePath: other.storePath,
            isSharedFixedStore: false,
            artifactDirs: [],
          },
          {},
          async () => {
            throw new Error("Memory inventory tried to read archive files");
          },
        );
        expect(entries).toMatchObject([{ agentId: "other", sessionId: "other-window" }]);
      },
    );
    const missing = {
      ...scope,
      agentId: "absent",
      sessionKey: "agent:absent:dashboard:incognito-absent",
      storePath: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "absent", env }),
    };
    expect(await buildSessionEntry(missing.sessionKey, missing)).toBeNull();
    expect(
      await resolveMemorySessionTargetsInWorker({
        agentId: missing.agentId,
        storePath: missing.storePath,
        sessionIds: [missing.sessionId],
      }),
    ).toMatchObject([{ resolution: "unresolved" }]);
    expect(
      memorySessionActorOwners.read({ agentId: missing.agentId, path: missing.storePath }),
    ).toBeUndefined();
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
