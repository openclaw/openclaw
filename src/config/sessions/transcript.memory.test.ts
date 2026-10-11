import { afterEach, describe, expect, it, vi } from "vitest";
import { makeZeroUsageSnapshot } from "../../agents/usage.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import type { SessionActorAuthority } from "./session-actor-contract.js";
import { memorySessionActorOwners } from "./session-actor-memory-owner.js";
import { readSessionActorStorageResult } from "./session-actor-storage-result.js";
import { loadTranscriptEvents } from "./session-transcript-events.js";
import {
  appendAssistantMessageToSessionTranscript,
  appendExactAssistantMessageToSessionTranscript,
  readRecentUserAssistantTextForSession,
} from "./transcript.js";

vi.mock("node:sqlite", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:sqlite")>()),
  DatabaseSync: vi.fn(function () {
    throw new Error("Memory assistant transcript opened SQLite");
  }),
}));
vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  Worker: vi.fn(function () {
    throw new Error("Memory assistant transcript allocated a worker");
  }),
}));

const authority: SessionActorAuthority = { assertCurrent() {}, authorize() {} };
const env = { OPENCLAW_STATE_DIR: "/synthetic/assistant-transcript" };
const scope = {
  agentId: "main",
  sessionKey: "agent:main:dashboard:incognito-assistant",
  sessionId: "assistant-1",
  storePath: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env }),
};

afterEach(() => {
  memorySessionActorOwners.closeDatabase({ agentId: scope.agentId, path: scope.storePath });
});

async function fixture() {
  const owner = memorySessionActorOwners.get({ agentId: scope.agentId, path: scope.storePath });
  const actor = await owner.acquire(
    { database: owner.identity, sessionKey: scope.sessionKey },
    { assertCurrent() {}, assertReadable() {} },
  );
  readSessionActorStorageResult(
    await actor.storage!.mutate(
      {
        type: "session.entry.create",
        input: { entry: { sessionId: scope.sessionId, updatedAt: 1, incognito: true } },
      },
      authority,
    ),
  );
  await actor.release();
  return owner;
}

function message(text: string) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "synthetic",
    provider: "synthetic",
    model: "synthetic",
    usage: makeZeroUsageSnapshot(),
    stopReason: "stop" as const,
    timestamp: 1,
  };
}

describe("memory assistant transcript entry points", () => {
  it("preserves hook preparation and keyed replay through an unbound append and recent read", async () => {
    await fixture();
    const beforeMessageWrite = vi.fn(() => message("Prepared answer"));
    const params = {
      ...scope,
      expectedSessionId: scope.sessionId,
      idempotencyKey: "answer-1",
      beforeMessageWrite,
      message: message("Original answer"),
    };
    const first = await appendExactAssistantMessageToSessionTranscript(params);
    expect(first).toMatchObject({
      ok: true,
      target: scope,
      anchor: { entryId: expect.any(String) },
    });
    expect(await appendExactAssistantMessageToSessionTranscript(params)).toEqual(first);
    expect(beforeMessageWrite).toHaveBeenCalledOnce();
    expect(await readRecentUserAssistantTextForSession(scope)).toEqual([
      expect.objectContaining({ role: "assistant", text: "Prepared answer" }),
    ]);
    expect(
      (await loadTranscriptEvents(scope)).filter((event) => event.type === "message"),
    ).toHaveLength(1);
  });

  it("suppresses equivalent delivery mirrors and observes a later distinct append", async () => {
    const owner = await fixture();
    const first = await appendAssistantMessageToSessionTranscript({ ...scope, text: "Delivered" });
    expect(first.ok).toBe(true);
    expect(
      await appendAssistantMessageToSessionTranscript({ ...scope, text: "Delivered" }),
    ).toEqual(first);
    const second = await appendAssistantMessageToSessionTranscript({ ...scope, text: "Next" });
    expect(second.ok).toBe(true);
    expect(second).not.toEqual(first);
    expect(
      (await loadTranscriptEvents(scope)).filter((event) => event.type === "message"),
    ).toHaveLength(2);
    expect(owner.readSession(scope.sessionKey, authority)?.entry.updatedAt).toBeGreaterThan(1);
  });

  it("refuses revoked writes and never recreates a closed session", async () => {
    const owner = await fixture();
    let current = true;
    await expect(
      appendExactAssistantMessageToSessionTranscript({
        ...scope,
        message: message("Must not append"),
        beforeMessageWrite() {
          current = false;
          return message("Still must not append");
        },
        assertCurrent() {
          if (!current) {
            throw new Error("delivery authority ended");
          }
        },
      }),
    ).rejects.toThrow("delivery authority ended");
    expect((await loadTranscriptEvents(scope)).filter((event) => event.type === "message")).toEqual(
      [],
    );
    owner.closeSession(scope.sessionKey);
    await expect(
      appendExactAssistantMessageToSessionTranscript({ ...scope, message: message("Closed") }),
    ).resolves.toMatchObject({ ok: false });
    expect(await readRecentUserAssistantTextForSession(scope)).toEqual([]);
    expect(owner.readSession(scope.sessionKey, authority)).toBeUndefined();
  });
});
