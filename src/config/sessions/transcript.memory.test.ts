import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { createSessionEntryWithTranscript } from "./session-accessor.js";
import type { SessionActorAuthority } from "./session-actor-contract.js";
import { memorySessionActorOwners } from "./session-actor-memory-owner.js";
import { loadSessionTranscriptEvents } from "./session-transcript-events.js";
import { createExactAssistantMessage } from "./transcript-message.test-support.js";
import {
  appendAssistantMessageToSessionTranscript,
  appendExactAssistantMessageToSessionTranscript as appendExact,
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
const databaseId = { agentId: scope.agentId, path: scope.storePath };
afterEach(() => memorySessionActorOwners.closeDatabase(databaseId));
const owner = () => memorySessionActorOwners.get(databaseId);
const append = (text: string) => appendAssistantMessageToSessionTranscript({ ...scope, text });
const recent = () => readRecentUserAssistantTextForSession(scope);
const messages = async () =>
  (await loadSessionTranscriptEvents(scope)).filter(
    (event) => isRecord(event) && event.type === "message",
  );
beforeEach(async () => {
  const result = await createSessionEntryWithTranscript(scope, () => ({
    ok: true,
    entry: { sessionId: scope.sessionId, updatedAt: 1, incognito: true },
  }));
  expect(result.ok).toBe(true);
});

const message = (text: string) => createExactAssistantMessage({ text });

it("preserves hook preparation and keyed replay through an unbound append and recent read", async () => {
  const beforeMessageWrite = vi.fn(() => message("Prepared answer"));
  const params = {
    expectedSessionId: scope.sessionId,
    idempotencyKey: "answer-1",
    beforeMessageWrite,
    message: message("Original answer"),
  };
  const first = await appendExact({ ...scope, ...params });
  expect(first).toMatchObject({
    ok: true,
    target: scope,
    anchor: { entryId: expect.any(String) },
  });
  expect(await appendExact({ ...scope, ...params })).toEqual(first);
  expect(beforeMessageWrite).toHaveBeenCalledOnce();
  expect(await recent()).toEqual([
    expect.objectContaining({ role: "assistant", text: "Prepared answer" }),
  ]);
  expect(await messages()).toHaveLength(1);
});

it("suppresses equivalent delivery mirrors and observes a later distinct append", async () => {
  const first = await append("Delivered");
  expect(first.ok).toBe(true);
  expect(await append("Delivered")).toEqual(first);
  const second = await append("Next");
  expect(second.ok).toBe(true);
  expect(second).not.toEqual(first);
  expect(await messages()).toHaveLength(2);
  expect(owner().readSession(scope.sessionKey, authority)?.entry?.updatedAt).toBeGreaterThan(1);
});

it("refuses revoked writes and never recreates a closed session", async () => {
  let current = true;
  await expect(
    appendExact({
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
  expect(await messages()).toEqual([]);
  owner().closeSession(scope.sessionKey);
  await expect(appendExact({ ...scope, message: message("Closed") })).resolves.toMatchObject({
    ok: false,
  });
  expect(await recent()).toEqual([]);
  expect(owner().readSession(scope.sessionKey, authority)).toBeUndefined();
});
