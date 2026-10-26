import { afterEach, expect, it, vi } from "vitest";
import { memorySessionActorOwners } from "../../config/sessions/session-actor-memory-owner.js";
import { commitMemory } from "../../config/sessions/session-actor-memory-publication.test-support.js";
import { runWithSessionActorStorage } from "../../config/sessions/session-actor-storage-binding.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import * as transcript from "./worker-turn-transcript-target.js";

vi.mock("node:sqlite", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:sqlite")>()),
  DatabaseSync: vi.fn(function () {
    throw new Error("Memory worker admission opened SQLite");
  }),
}));
vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  Worker: vi.fn(function () {
    throw new Error("Memory worker admission allocated a database worker");
  }),
}));

afterEach(() => memorySessionActorOwners.reset());

async function fixture() {
  const target = {
    agentId: "main",
    sessionKey: "agent:main:dashboard:incognito-memory-worker",
    sessionId: "memory-worker",
    storePath: resolveIncognitoOpenClawAgentSqlitePath({
      agentId: "main",
      env: { OPENCLAW_STATE_DIR: "/synthetic/incognito-worker" },
    }),
  };
  const location = { agentId: target.agentId, path: target.storePath };
  const owner = memorySessionActorOwners.get(location);
  const actor = await owner.acquire(
    { database: owner.identity, sessionKey: target.sessionKey },
    { assertCurrent() {}, assertReadable() {} },
  );
  const authority = { assertCurrent() {}, authorize() {} };
  await commitMemory(actor.storage!, "session.entry.create", {
    entry: {
      sessionId: target.sessionId,
      updatedAt: 1,
      incognito: true,
    },
  });
  return { owner, target, binding: { actor, authority, ...location } };
}

it.each([false, true])("settles memory admission (closed=%s)", async (close) => {
  const { owner, target, binding } = await fixture();
  transcript.captureWorkerTurnTranscriptSource(target)();
  const release = vi.fn();
  const run = vi.fn(async () => "settled");
  const result = runWithSessionActorStorage(binding, () =>
    transcript.withWorkerTurnTranscriptDatabase(
      { ...target, sessionTarget: target },
      {
        assertCurrent() {},
        async prepareAuthority() {
          if (close) {
            owner.closeSession(target.sessionKey);
          }
          return { isCurrent: () => true, release };
        },
      },
      run,
    ),
  );
  if (close) {
    await expect(result).rejects.toThrow("transcript identity is no longer current");
    expect(run).not.toHaveBeenCalled();
  } else {
    await expect(result).resolves.toBe("settled");
    expect(run).toHaveBeenCalledOnce();
  }
  expect(release).toHaveBeenCalledOnce();
});
