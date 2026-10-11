import { afterEach, expect, it, vi } from "vitest";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import { readSessionActorStorageResult } from "../config/sessions/session-actor-storage-result.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import {
  captureCodexSessionContextReader,
  readCodexSessionContext,
  validateCodexSessionTranscriptContextVersion,
} from "./codex-session-transcript-runtime.js";

vi.mock("node:sqlite", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:sqlite")>()),
  DatabaseSync: vi.fn(function () {
    throw new Error("Memory SDK context opened SQLite");
  }),
}));
vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  Worker: vi.fn(function () {
    throw new Error("Memory SDK context allocated a worker");
  }),
}));
const env = { OPENCLAW_STATE_DIR: "/synthetic/sdk-context" };
const ownerScope = {
  agentId: "main",
  path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env }),
};
afterEach(() => {
  memorySessionActorOwners.closeDatabase(ownerScope);
});

it("acquires an unbound memory context and ends retained iterators at the disclosure boundary", async () => {
  const target = {
    agentId: "main",
    storePath: ownerScope.path,
    env,
    sessionId: "memory-context",
    sessionKey: "agent:main:dashboard:incognito-context",
  };
  const owner = memorySessionActorOwners.get(ownerScope);
  const actor = await owner.acquire(
    { database: owner.identity, sessionKey: target.sessionKey },
    { assertCurrent() {}, assertReadable() {} },
  );
  const authority = { assertCurrent() {}, authorize() {} };
  const storage = actor.storage!;
  readSessionActorStorageResult(
    await storage.mutate(
      {
        type: "session.metadata.initialize",
        input: {
          scope: target,
          entry: { sessionId: target.sessionId, updatedAt: 1, incognito: true },
        },
      },
      authority,
    ),
  );
  readSessionActorStorageResult(
    await storage.mutate(
      {
        type: "session.transcript.appendMessage",
        input: {
          scope: target,
          messageJson: JSON.stringify({
            role: "user",
            content: "Canonical context.",
            timestamp: 1,
          }),
          cwd: "/synthetic",
        },
      },
      authority,
    ),
  );
  const controller = new AbortController();
  const reader = captureCodexSessionContextReader(target, controller.signal);
  if (!reader) {
    throw new Error("Missing bound memory context reader");
  }
  const context = await reader(target, (messages, header) => ({ messages: [...messages], header }));
  expect(context).toMatchObject({
    messages: [{ role: "user", content: "Canonical context.", timestamp: 1 }],
    header: { type: "session", id: target.sessionId },
  });
  const retained = await reader(target, (messages) => messages);
  expect([...retained]).toEqual([]);
  expect(() => readCodexSessionContext(target, () => undefined)).toThrow(
    "captureCodexSessionContextReader",
  );
  expect(() => validateCodexSessionTranscriptContextVersion(target, undefined)).toThrow(
    "captureCodexSessionContextReader",
  );
  await expect(
    reader(target, async (messages) => {
      await Promise.resolve();
      controller.abort(new Error("Context disclosure revoked"));
      expect(() => [...messages]).toThrow("Context disclosure revoked");
    }),
  ).rejects.toThrow("Context disclosure revoked");
  const afterClose = captureCodexSessionContextReader(target);
  await expect(
    afterClose!(target, async (messages) => {
      await Promise.resolve();
      owner.closeSession(target.sessionKey);
      expect(() => [...messages]).toThrow();
    }),
  ).rejects.toThrow();
  await expect(afterClose!(target, (messages) => [...messages])).rejects.toThrow();
});
