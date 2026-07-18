// sessions.create succession-declaration contract (succeedsParent): an explicit
// non-dashboard successor with a parent and command hooks rolls the parent over,
// while dashboard/minted/fork children and incomplete declarations are rejected at
// the boundary rather than silently retiring the still-active parent's Codex
// binding (#106778). Split out of server.sessions.reset-hooks.test.ts to keep that
// suite under the max-lines limit (#106932).
import { expect, test } from "vitest";
import { writeSessionStore } from "./test-helpers.js";
import {
  setupGatewaySessionsTestHarness,
  sessionLifecycleHookMocks,
  directSessionReq,
  seedSessionTranscript,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsTestHarness();

type HookEventRecord = Record<string, unknown> & {
  context?: Record<string, unknown> & {
    previousSessionEntry?: { sessionId?: string };
  };
  messages?: Array<{ role?: string; content?: unknown }>;
};

function firstHookCall(mock: { mock: { calls: unknown[][] } }): [HookEventRecord, HookEventRecord] {
  const call = mock.mock.calls.at(0);
  if (!call) {
    throw new Error("Expected hook call");
  }
  return [call[0] as HookEventRecord, call[1] as HookEventRecord];
}

async function writeMessageTranscript(params: {
  sessionId: string;
  sessionKey: string;
  storePath: string;
  agentId?: string;
  content: string;
  messageId?: string;
}) {
  await seedSessionTranscript({
    agentId: params.agentId,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
    messages: [{ role: "user", content: params.content, id: params.messageId ?? "m1" }],
  });
}

test("sessions.create rejects succeedsParent for an explicit dashboard-keyed child (#106932)", async () => {
  const { storePath } = await createSessionStoreDir();
  await writeSessionStore({
    entries: { main: { sessionId: "sess-parent-dash", updatedAt: Date.now() } },
  });
  await writeMessageTranscript({
    agentId: "main",
    sessionId: "sess-parent-dash",
    sessionKey: "agent:main:main",
    storePath,
    content: "hello before dashboard replace",
  });

  // A dashboard key is an auto-managed, detached namespace — never a successor.
  // Declaring succession on it is a contradiction and must be rejected loudly,
  // not silently retire the still-active parent's Codex binding (#106778).
  const result = await directSessionReq("sessions.create", {
    key: "dashboard:manual-successor",
    agentId: "main",
    parentSessionKey: "main",
    emitCommandHooks: true,
    succeedsParent: true,
  });

  expect(result.ok).toBe(false);
  expect(result.error).toMatchObject({ code: "INVALID_REQUEST" });
  expect(result.error?.message).toMatch(/explicit non-dashboard successor key/i);
  expect(sessionLifecycleHookMocks.runSessionEnd).not.toHaveBeenCalled();
});

test("sessions.create rejects succeedsParent for a minted (keyless) child (#106932)", async () => {
  const { storePath } = await createSessionStoreDir();
  await writeSessionStore({
    entries: { main: { sessionId: "sess-parent-minted", updatedAt: Date.now() } },
  });
  await writeMessageTranscript({
    agentId: "main",
    sessionId: "sess-parent-minted",
    sessionKey: "agent:main:main",
    storePath,
    content: "hello before new chat",
  });

  // A keyless create mints a detached dashboard child (webchat "new chat"); it
  // runs in parallel and cannot succeed its parent. A stray succeedsParent here
  // is a client bug and is rejected rather than retiring the active parent.
  const result = await directSessionReq("sessions.create", {
    parentSessionKey: "main",
    emitCommandHooks: true,
    succeedsParent: true,
  });

  expect(result.ok).toBe(false);
  expect(result.error).toMatchObject({ code: "INVALID_REQUEST" });
  expect(result.error?.message).toMatch(/explicit non-dashboard successor key/i);
  expect(sessionLifecycleHookMocks.runSessionEnd).not.toHaveBeenCalled();
  expect(sessionLifecycleHookMocks.runSessionStart).not.toHaveBeenCalled();
});

test("sessions.create rejects succeedsParent combined with fork (#106932)", async () => {
  const { storePath } = await createSessionStoreDir();
  await writeSessionStore({
    entries: { main: { sessionId: "sess-parent-fork", updatedAt: Date.now() } },
  });
  await writeMessageTranscript({
    agentId: "main",
    sessionId: "sess-parent-fork",
    sessionKey: "agent:main:main",
    storePath,
    content: "hello before fork",
  });

  // A fork runs in parallel to its parent by definition; pairing it with an
  // explicit succession declaration is contradictory and rejected.
  const result = await directSessionReq("sessions.create", {
    key: "tui-forked",
    agentId: "main",
    parentSessionKey: "main",
    emitCommandHooks: true,
    fork: true,
    succeedsParent: true,
  });

  expect(result.ok).toBe(false);
  expect(result.error).toMatchObject({ code: "INVALID_REQUEST" });
  expect(result.error?.message).toMatch(/fork/i);
  expect(sessionLifecycleHookMocks.runSessionEnd).not.toHaveBeenCalled();
});

// Omitting succeedsParent on an explicit non-dashboard successor + emitCommandHooks
// preserves the legacy parent rollover — succession is not silently dropped (#106932 P1).
test("sessions.create preserves the legacy rollover when succeedsParent is omitted (#106932)", async () => {
  const { storePath } = await createSessionStoreDir();
  await writeSessionStore({
    entries: { main: { sessionId: "sess-legacy", updatedAt: Date.now() } },
  });
  await writeMessageTranscript({
    agentId: "main",
    sessionId: "sess-legacy",
    sessionKey: "agent:main:main",
    storePath,
    content: "before legacy /new",
  });
  const result = await directSessionReq<{ key: string }>("sessions.create", {
    key: "tui-legacy",
    agentId: "main",
    parentSessionKey: "main",
    emitCommandHooks: true,
  });
  expect(result.ok).toBe(true);
  expect(result.payload?.key).toBe("agent:main:tui-legacy");
  const [endEvent] = firstHookCall(sessionLifecycleHookMocks.runSessionEnd);
  expect(endEvent.sessionKey).toBe("agent:main:main");
  expect(endEvent.nextSessionKey).toBe("agent:main:tui-legacy");
});

// An eligible successor can explicitly opt out of rollover with false: child is
// created (session_start) but the parent is not ended (#106932).
test("sessions.create honors succeedsParent:false as an explicit parallel opt-out (#106932)", async () => {
  const { storePath } = await createSessionStoreDir();
  await writeSessionStore({
    entries: { main: { sessionId: "sess-optout", updatedAt: Date.now() } },
  });
  await writeMessageTranscript({
    agentId: "main",
    sessionId: "sess-optout",
    sessionKey: "agent:main:main",
    storePath,
    content: "before parallel /new",
  });
  const result = await directSessionReq<{ key: string }>("sessions.create", {
    key: "tui-parallel",
    agentId: "main",
    parentSessionKey: "main",
    emitCommandHooks: true,
    succeedsParent: false,
  });
  expect(result.ok).toBe(true);
  expect(sessionLifecycleHookMocks.runSessionEnd).not.toHaveBeenCalled();
  expect(firstHookCall(sessionLifecycleHookMocks.runSessionStart)[0].sessionKey).toBe(
    "agent:main:tui-parallel",
  );
});

// succeedsParent rolls the parent over, so an explicit declaration must name a
// parent and opt into hooks; reject the incomplete declaration at the boundary (#106932 P2).
test("sessions.create rejects succeedsParent without parentSessionKey (#106932)", async () => {
  await createSessionStoreDir();
  const result = await directSessionReq("sessions.create", {
    key: "tui-noparent",
    agentId: "main",
    emitCommandHooks: true,
    succeedsParent: true,
  });
  expect(result.ok).toBe(false);
  expect(result.error).toMatchObject({ code: "INVALID_REQUEST" });
  expect(result.error?.message).toMatch(/parentSessionKey/i);
  expect(sessionLifecycleHookMocks.runSessionEnd).not.toHaveBeenCalled();
});

test("sessions.create rejects succeedsParent without emitCommandHooks (#106932)", async () => {
  await createSessionStoreDir();
  const result = await directSessionReq("sessions.create", {
    key: "tui-nohook",
    agentId: "main",
    parentSessionKey: "main",
    succeedsParent: true,
  });
  expect(result.ok).toBe(false);
  expect(result.error).toMatchObject({ code: "INVALID_REQUEST" });
  expect(result.error?.message).toMatch(/emitCommandHooks/i);
  expect(sessionLifecycleHookMocks.runSessionEnd).not.toHaveBeenCalled();
});
