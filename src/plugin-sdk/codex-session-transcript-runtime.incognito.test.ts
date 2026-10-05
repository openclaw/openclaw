import "../test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { afterAll, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { SessionManager } from "../agents/sessions/session-manager.js";
import { withIncognitoSessionActor } from "../config/sessions/session-incognito-binding.js";
import { captureOpenClawAgentDatabaseExecution } from "../state/openclaw-agent-execution.js";
import {
  captureCodexSessionContextReader,
  readCodexSessionContext,
  validateCodexSessionTranscriptContextVersion,
} from "./codex-session-transcript-runtime.js";

const tempDirs = useAutoCleanupTempDirTracker(afterAll);

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
    const retained = await withIncognitoSessionActor(actor, async () => {
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
        expect(consume).not.toHaveBeenCalled();
        expect(prepare).not.toHaveBeenCalled();
        expect(exec).not.toHaveBeenCalled();
      } finally {
        prepare.mockRestore();
        exec.mockRestore();
      }
      return { reader, consume };
    });
    await actor.close();
    await expect(
      Promise.resolve().then(() => retained.reader(target, retained.consume)),
    ).rejects.toMatchObject({
      code: "INCOGNITO_SESSION_ENDED",
    });
    expect(retained.consume).not.toHaveBeenCalled();
  } finally {
    await actor.close();
  }
});
