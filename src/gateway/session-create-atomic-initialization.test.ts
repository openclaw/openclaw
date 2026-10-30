import { expect, it } from "vitest";
import {
  loadSessionEntryReadOnly,
  loadTranscriptEvents,
} from "../config/sessions/session-accessor.js";
import { withSessionTranscriptWriteLock } from "../plugin-sdk/session-transcript-runtime.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createGatewaySession } from "./session-create-service.js";
import type { CreatedGatewaySession } from "./session-create-service.types.js";

async function appendImportedMessage({ agentId, entry, key, storePath }: CreatedGatewaySession) {
  const scope = { agentId, sessionId: entry.sessionId, sessionKey: key, storePath };
  await withSessionTranscriptWriteLock(scope, async (transcript) => {
    await transcript.appendMessage({
      message: { role: "user", content: "Imported snapshot", timestamp: 1 },
    });
  });
  return scope;
}

it.each([
  ["atomic success", true, undefined],
  ["atomic rollback", true, "snapshot changed"],
  ["ordinary post-commit failure", false, "initial turn failed"],
] as const)("initializes sessions: %s", async (label, atomic, failure) => {
  await withOpenClawTestState({ label }, async () => {
    const key = "agent:main:initializer";
    let scope: Awaited<ReturnType<typeof appendImportedMessage>> | undefined;
    const created = await createGatewaySession({
      cfg: {},
      key,
      commandSource: "test",
      operatorRoleActor: { kind: "system" },
      atomicInitialization: atomic ? true : undefined,
      afterCreate: async (session) => {
        if (atomic) {
          expect(session.entry.initializationPending).toBe(true);
          scope = await appendImportedMessage(session);
        }
        if (failure) {
          throw new Error(failure);
        }
      },
    });
    if (atomic && failure) {
      expect(created).toMatchObject({
        ok: false,
        error: { code: "UNAVAILABLE", message: `session initialization failed: ${failure}` },
      });
      expect(loadSessionEntryReadOnly({ sessionKey: key })).toBeUndefined();
      return;
    }
    expect(created).toMatchObject({
      ok: true,
      postCommit: failure
        ? { status: "failed", error: expect.any(Error) }
        : { status: "completed" },
    });
    if (!created.ok) {
      throw new Error(created.error.message);
    }
    expect(created.entry.initializationPending).toBeUndefined();
    expect(loadSessionEntryReadOnly({ sessionKey: key })?.initializationPending).toBeUndefined();
    if (!failure) {
      expect(scope).toBeDefined();
      expect(JSON.stringify(await loadTranscriptEvents(scope!))).toContain("Imported snapshot");
    }
  });
});
