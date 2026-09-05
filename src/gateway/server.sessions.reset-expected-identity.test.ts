import { afterEach, expect, test } from "vitest";
import { loadSessionEntry, replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { beginSessionWorkAdmission } from "../sessions/session-lifecycle-admission.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq,
  sessionStoreEntry,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

test("sessions.reset rejects a stale expected session without interrupting current work", async () => {
  const sessionKey = "agent:main:subagent:guarded-reset";
  const currentSessionId = "sess-current";
  const { storePath } = await createSessionStoreDir();
  await writeSessionStore({
    entries: { [sessionKey]: sessionStoreEntry(currentSessionId) },
  });
  let interrupted = false;
  const admission = await beginSessionWorkAdmission({
    scope: storePath,
    identities: [sessionKey, currentSessionId],
    assertAllowed: () => {},
    onInterrupt: () => {
      interrupted = true;
    },
  });

  try {
    const reset = await directSessionReq("sessions.reset", {
      key: sessionKey,
      expectedSessionId: "sess-stale",
    });

    expect(reset).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        details: { reason: "session-changed" },
      },
    });
    expect(interrupted).toBe(false);
    expect(loadSessionEntry({ sessionKey, storePath })?.sessionId).toBe(currentSessionId);
  } finally {
    admission.release();
  }
});

test("sessions.reset accepts a matching expected session", async () => {
  const sessionKey = "agent:main:subagent:guarded-reset";
  const sessionId = "sess-current";
  const { storePath } = await createSessionStoreDir();
  await writeSessionStore({
    entries: { [sessionKey]: sessionStoreEntry(sessionId) },
  });

  const reset = await directSessionReq<{ entry: { sessionId: string } }>("sessions.reset", {
    key: sessionKey,
    expectedSessionId: sessionId,
  });

  expect(reset).toMatchObject({ ok: true, payload: { entry: { sessionId } } });
  expect(loadSessionEntry({ sessionKey, storePath })?.sessionId).toBe(sessionId);
});

test("sessions.reset rechecks the expected session before interrupting replacement work", async () => {
  const sessionKey = "agent:main:subagent:guarded-reset-race";
  const observedSessionId = "sess-observed";
  const replacementSessionId = "sess-replacement";
  const { storePath } = await createSessionStoreDir();
  await writeSessionStore({
    entries: { [sessionKey]: sessionStoreEntry(observedSessionId) },
  });
  let replacementInterrupted = false;
  const replacementAdmission = await beginSessionWorkAdmission({
    scope: storePath,
    identities: [sessionKey, replacementSessionId],
    assertAllowed: () => {},
    onInterrupt: () => {
      replacementInterrupted = true;
    },
  });
  const { performGatewaySessionReset } = await import("./session-reset-service.js");
  let replaced = false;

  try {
    const reset = await performGatewaySessionReset({
      key: sessionKey,
      reason: "reset",
      commandSource: "gateway:sessions.reset",
      workerPlacementContext: {},
      expectedSessionId: observedSessionId,
      assertCurrent: () => {
        if (!replaced) {
          replaced = true;
          replaceSessionEntrySync(
            { sessionKey, storePath },
            sessionStoreEntry(replacementSessionId),
          );
        }
      },
    });

    expect(reset).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST", details: { reason: "session-changed" } },
    });
    expect(replaced).toBe(true);
    expect(replacementInterrupted).toBe(false);
    expect(loadSessionEntry({ sessionKey, storePath })?.sessionId).toBe(replacementSessionId);
  } finally {
    replacementAdmission.release();
  }
});

test("sessions.reset classifies a post-drain replacement as session-changed", async () => {
  const sessionKey = "agent:main:subagent:guarded-reset-post-drain-race";
  const observedSessionId = "sess-observed";
  const replacementSessionId = "sess-replacement";
  const { storePath } = await createSessionStoreDir();
  await writeSessionStore({
    entries: { [sessionKey]: sessionStoreEntry(observedSessionId) },
  });
  const { performGatewaySessionReset } = await import("./session-reset-service.js");

  const reset = await performGatewaySessionReset({
    key: sessionKey,
    reason: "reset",
    commandSource: "gateway:sessions.reset",
    workerPlacementContext: {},
    expectedSessionId: observedSessionId,
    prepareLifecycle: async () => {
      replaceSessionEntrySync({ sessionKey, storePath }, sessionStoreEntry(replacementSessionId));
      return { ok: true, value: {} };
    },
  });

  expect(reset).toMatchObject({
    ok: false,
    error: { code: "INVALID_REQUEST", details: { reason: "session-changed" } },
  });
  expect(loadSessionEntry({ sessionKey, storePath })?.sessionId).toBe(replacementSessionId);
});
