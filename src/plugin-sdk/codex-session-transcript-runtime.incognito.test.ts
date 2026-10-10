import "../test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { afterAll, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { SessionManager } from "../agents/sessions/session-manager.js";
import {
  assertIncognitoSessionSyncAccess,
  withAcquiredIncognitoSessionBinding,
  withIncognitoSessionActor,
} from "../config/sessions/session-incognito-binding.js";
import {
  resolveIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.paths.js";
import { captureOpenClawAgentDatabaseExecution } from "../state/openclaw-agent-execution.js";
import {
  captureCodexSessionContextReader,
  readCodexSessionContext,
  validateCodexSessionTranscriptContextVersion,
} from "./codex-session-transcript-runtime.js";

const tempDirs = useAutoCleanupTempDirTracker(afterAll);

it("identifies incognito SDK targets without refusing durable paths", () => {
  const target = {
    agentId: "main",
    env: { OPENCLAW_STATE_DIR: "/synthetic/incognito-preflight" },
  };
  const refuse = (scope: Parameters<typeof assertIncognitoSessionSyncAccess>[0]) =>
    assertIncognitoSessionSyncAccess(
      scope,
      "readCodexSessionContext",
      "captureCodexSessionContextReader",
    );
  expect(() => refuse({ ...target, sessionKey: "agent:main:dashboard:incognito-sdk" })).toThrow(
    "captureCodexSessionContextReader",
  );
  expect(() =>
    refuse({ ...target, storePath: resolveIncognitoOpenClawAgentSqlitePath(target) }),
  ).toThrow("captureCodexSessionContextReader");
  expect(() =>
    refuse({ ...target, storePath: resolveOpenClawAgentSqlitePath(target) }),
  ).not.toThrow();
  expect(() =>
    refuse({ ...target, storePath: "/synthetic/unrelated/incognito-openclaw-agent.sqlite" }),
  ).not.toThrow();
  expect(() => refuse(undefined)).not.toThrow();
});

it("reads Codex context from the captured actor and rejects synchronous or retired access", async () => {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("codex-actor-injection-") };
  const authority = { assertCurrent() {} };
  const actor = await captureOpenClawAgentDatabaseExecution({
    kind: "ephemeral",
    agentId: "main",
    env,
    authority,
  });
  assert(actor);
  const target = {
    agentId: "main",
    sessionId: "shared-binding",
    sessionKey: "agent:main:dashboard:incognito-shared-binding",
    storePath: actor.path,
    env,
  };
  try {
    await actor.sessions.create(authority, {
      sessionKey: target.sessionKey,
      entry: { sessionId: target.sessionId, incognito: true, updatedAt: 1 },
    });
    const retained = await withAcquiredIncognitoSessionBinding(
      target,
      authority,
      async (binding) => {
        const manager = await SessionManager.openAsync(target);
        await manager.appendMessageAsync({
          role: "user",
          content: "Synthetic actor context.",
          timestamp: 1,
        });
        const reader = captureCodexSessionContextReader(target);
        assert(reader);
        const consume = vi.fn();
        const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
        const exec = vi.spyOn(DatabaseSync.prototype, "exec");
        try {
          expect(() => readCodexSessionContext(target, consume)).toThrow(
            "captureCodexSessionContextReader",
          );
          expect(() => validateCodexSessionTranscriptContextVersion(target, undefined)).toThrow(
            "captureCodexSessionContextReader",
          );
          const context = await reader(target, (messages, header) => ({
            messages: Array.from(messages),
            header,
          }));
          expect(context).toMatchObject({
            messages: [{ role: "user", content: "Synthetic actor context.", timestamp: 1 }],
            header: { type: "session", id: "shared-binding" },
          });
          const retainedMessages = await reader(target, (messages) => messages);
          expect(Array.from(retainedMessages)).toEqual([]);
          const revoked = new AbortController();
          const revokeDuringRead = captureCodexSessionContextReader(target, revoked.signal);
          assert(revokeDuringRead);
          await expect(
            revokeDuringRead(target, async (messages) => {
              await Promise.resolve();
              revoked.abort(new Error("SDK context consumer revoked"));
              expect(() => Array.from(messages)).toThrow("SDK context consumer revoked");
            }),
          ).rejects.toThrow("SDK context consumer revoked");
          const controller = new AbortController();
          const guarded = captureCodexSessionContextReader(target, controller.signal);
          assert(guarded);
          const retain = binding.actor.sessions.withSharedState.bind(binding.actor.sessions);
          const settle = async <T>(work: () => Promise<T>): Promise<T> => {
            const value = await retain(work);
            controller.abort(new Error("SDK context authority ended"));
            return value;
          };
          const settled = vi
            .spyOn(binding.actor.sessions, "withSharedState")
            .mockImplementationOnce(settle);
          try {
            await expect(guarded(target, (messages) => [...messages])).rejects.toThrow(
              "SDK context authority ended",
            );
            actor.assertReadable();
          } finally {
            settled.mockRestore();
          }
          expect(consume).not.toHaveBeenCalled();
          expect(prepare).not.toHaveBeenCalled();
          expect(exec).not.toHaveBeenCalled();
        } finally {
          prepare.mockRestore();
          exec.mockRestore();
        }
        return { reader, consume, manager };
      },
    );
    assert(retained);
    await expect(retained.reader(target, retained.consume)).rejects.toThrow(
      "reference is released",
    );
    await expect(retained.manager.reloadPersistedTranscriptAsync()).rejects.toThrow(
      "reference is released",
    );
    let acquisitionCurrent = true;
    const acquiredAuthority = {
      assertCurrent() {
        if (!acquisitionCurrent) {
          throw new Error("SDK acquisition authority revoked");
        }
      },
    };
    const disclose = vi.fn();
    await expect(
      withAcquiredIncognitoSessionBinding(target, acquiredAuthority, async () => {
        const reader = captureCodexSessionContextReader(target);
        assert(reader);
        return reader(target, async (messages) => {
          await Promise.resolve();
          acquisitionCurrent = false;
          for (const message of messages) {
            disclose(message);
          }
        });
      }),
    ).rejects.toThrow("SDK acquisition authority revoked");
    expect(disclose).not.toHaveBeenCalled();
    const lostReader = await withIncognitoSessionActor(actor, async () =>
      captureCodexSessionContextReader(target),
    );
    assert(lostReader);
    await actor.close();
    await expect(
      Promise.resolve().then(() => lostReader(target, retained.consume)),
    ).rejects.toMatchObject({
      code: "INCOGNITO_SESSION_ENDED",
    });
    expect(retained.consume).not.toHaveBeenCalled();
  } finally {
    await actor.close();
  }
});
