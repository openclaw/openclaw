import { describe, expect, it } from "vitest";
import {
  loadSessionEntryReadOnly,
  loadTranscriptEvents,
} from "../config/sessions/session-accessor.js";
import { withSessionTranscriptWriteLock } from "../plugin-sdk/session-transcript-runtime.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createGatewaySession } from "./session-create-service.js";
import type {
  CreatedGatewaySession,
  CreateGatewaySessionParams,
} from "./session-create-service.types.js";

function createSession(
  key: string,
  afterCreate: CreateGatewaySessionParams["afterCreate"],
  atomicInitialization = true,
) {
  return createGatewaySession({
    cfg: {},
    key,
    commandSource: "test",
    operatorRoleActor: { kind: "system" },
    atomicInitialization: atomicInitialization ? true : undefined,
    afterCreate,
  });
}

async function appendImportedMessage(created: CreatedGatewaySession) {
  const scope = {
    agentId: created.agentId,
    sessionId: created.entry.sessionId,
    sessionKey: created.key,
    storePath: created.storePath,
  };
  await withSessionTranscriptWriteLock(scope, async (transcript) => {
    await transcript.appendMessage({
      message: { role: "user", content: "Imported snapshot", timestamp: 1 },
    });
  });
  return scope;
}

describe("atomic Gateway session initialization", () => {
  it("publishes a usable session only after its transcript initializer succeeds", async () => {
    await withOpenClawTestState({ label: "atomic-session-success" }, async () => {
      let transcriptScope: Awaited<ReturnType<typeof appendImportedMessage>> | undefined;
      const created = await createSession("agent:main:atomic-success", async (entry) => {
        expect(entry.entry.initializationPending).toBe(true);
        transcriptScope = await appendImportedMessage(entry);
      });

      expect(created).toMatchObject({
        ok: true,
        postCommit: { status: "completed" },
      });
      if (!created.ok) {
        throw new Error(created.error.message);
      }
      expect(created.entry.initializationPending).toBeUndefined();
      expect(loadSessionEntryReadOnly({ sessionKey: created.key })?.initializationPending).toBe(
        undefined,
      );
      expect(transcriptScope).toBeDefined();
      expect(JSON.stringify(await loadTranscriptEvents(transcriptScope!))).toContain(
        "Imported snapshot",
      );
    });
  });

  it("removes the new session and transcript when initialization fails", async () => {
    await withOpenClawTestState({ label: "atomic-session-failure" }, async () => {
      const sessionKey = "agent:main:atomic-failure";
      const created = await createSession(sessionKey, async (entry) => {
        await appendImportedMessage(entry);
        throw new Error("snapshot changed");
      });

      expect(created).toMatchObject({
        ok: false,
        error: { code: "UNAVAILABLE", message: "session initialization failed: snapshot changed" },
      });
      expect(loadSessionEntryReadOnly({ sessionKey })).toBeUndefined();
    });
  });

  it("preserves the existing post-commit contract for ordinary session creation", async () => {
    await withOpenClawTestState({ label: "ordinary-session-initializer" }, async () => {
      const sessionKey = "agent:main:ordinary-initializer";
      const created = await createSession(
        sessionKey,
        async () => {
          throw new Error("initial turn failed");
        },
        false,
      );

      expect(created).toMatchObject({
        ok: true,
        postCommit: { status: "failed", error: expect.any(Error) },
      });
      expect(loadSessionEntryReadOnly({ sessionKey })?.initializationPending).toBeUndefined();
    });
  });
});
