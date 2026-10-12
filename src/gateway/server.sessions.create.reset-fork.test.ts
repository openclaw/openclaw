import { expect, onTestFinished, test } from "vitest";
import { closeGatewayTestWebSocket } from "../../test/helpers/gateway-websocket.js";
import { SessionManager } from "../agents/sessions/session-manager.js";
import { loadTranscriptEvents } from "../config/sessions/session-accessor.js";
import {
  setupSessionCreateTestHarness,
  requireNonEmptyString,
} from "./server.sessions.create.test-support.js";
import { embeddedRunMock, rpcReq, testState, writeSessionStore } from "./test-helpers.js";
import { sessionStoreEntry, seedSessionTranscript } from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir, openClient } = setupSessionCreateTestHarness();

test("sessions.create does not revive reset context when forking an active parent", async () => {
  const { storePath } = await createSessionStoreDir();
  testState.sessionConfig = { scope: "per-sender" };
  const parentSessionId = "sess-reset-fork-parent";
  const parentKey = "agent:main:dashboard:reset-fork-parent";
  const childKey = "agent:main:dashboard:reset-fork-child";
  const parentScope = {
    agentId: "main",
    sessionId: parentSessionId,
    sessionKey: parentKey,
    storePath,
  };
  onTestFinished(() => {
    embeddedRunMock.activeIds.delete(parentSessionId);
    testState.sessionConfig = undefined;
  });
  await writeSessionStore({ entries: { [parentKey]: sessionStoreEntry(parentSessionId) } });
  await seedSessionTranscript({
    ...parentScope,
    messages: [
      { role: "user", content: "discarded question" },
      {
        role: "assistant",
        content: [{ type: "text", text: "discarded answer" }],
        stopReason: "stop",
      },
    ],
  });

  const { ws } = await openClient();
  onTestFinished(() => closeGatewayTestWebSocket(ws));
  const reset = await rpcReq<{ entry: { sessionId: string } }>(ws, "sessions.reset", {
    key: parentKey,
    reason: "new",
  });
  expect(reset.ok, JSON.stringify(reset.error)).toBe(true);
  expect(reset.payload?.entry.sessionId).toBe(parentSessionId);
  const activeMessages = [
    { role: "user", content: "new question" },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "new-call", name: "lookup", arguments: {} }],
      stopReason: "toolUse",
    },
  ];
  await seedSessionTranscript({ ...parentScope, messages: activeMessages });
  const originalEvents = await loadTranscriptEvents(parentScope);
  expect(originalEvents).toContainEqual(expect.objectContaining({ type: "reset", reason: "new" }));
  const parent = await SessionManager.openModelContextAsync(parentScope);
  const parentMessages = parent.buildSessionContext().messages;
  expect(parentMessages).toMatchObject(activeMessages);

  // The shared fixture simulates run liveness; reset, fork, and transcript reads stay real.
  embeddedRunMock.activeIds.add(parentSessionId);
  const created = await rpcReq<{ key: string; sessionId: string }>(ws, "sessions.create", {
    key: childKey,
    parentSessionKey: parentKey,
    fork: true,
    forkFrom: "last-completed",
  });
  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  expect(created.payload?.key).toBe(childKey);
  const childSessionId = requireNonEmptyString(created.payload?.sessionId, "forked session id");
  expect(childSessionId).not.toBe(parentSessionId);
  const child = await SessionManager.openModelContextAsync({
    agentId: "main",
    sessionId: childSessionId,
    sessionKey: childKey,
    storePath,
  });
  expect(child.buildSessionContext().messages).toEqual([]);
  const history = await rpcReq<{ messages: unknown[] }>(ws, "chat.history", {
    sessionKey: childKey,
  });
  expect(history.ok, JSON.stringify(history.error)).toBe(true);
  expect(history.payload?.messages).toEqual([
    expect.objectContaining({
      role: "system",
      __openclaw: expect.objectContaining({ kind: "reset" }),
    }),
  ]);

  embeddedRunMock.activeIds.delete(parentSessionId);
  const full = await rpcReq<{ key: string; sessionId: string }>(ws, "sessions.create", {
    key: "agent:main:dashboard:reset-fork-full-child",
    parentSessionKey: parentKey,
    fork: true,
  });
  expect(full.ok, JSON.stringify(full.error)).toBe(true);
  const fullChild = await SessionManager.openModelContextAsync({
    agentId: "main",
    sessionId: requireNonEmptyString(full.payload?.sessionId, "full fork session id"),
    sessionKey: requireNonEmptyString(full.payload?.key, "full fork session key"),
    storePath,
  });
  expect(fullChild.buildSessionContext().messages).toEqual(parentMessages);
  expect(await loadTranscriptEvents(parentScope)).toEqual(originalEvents);
});
