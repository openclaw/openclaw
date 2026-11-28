import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, onTestFinished, test } from "vitest";
import type { SessionsSearchResult } from "../../packages/gateway-protocol/src/schema/sessions-search.js";
import { closeGatewayTestWebSocket } from "../../test/helpers/gateway-websocket.js";
import { SessionManager } from "../agents/sessions/session-manager.js";
import { loadSessionEntry, loadTranscriptEvents } from "../config/sessions/session-accessor.js";
import { SESSION_TOTAL_TOKENS_VERSION } from "../config/sessions/types.js";
import { captureSessionControllerSettlement } from "../sessions/session-controller.lifecycle.js";
import { registerForkableCliBackend } from "./server.sessions.create.forks.test-support.js";
import {
  setupSessionCreateTestHarness,
  requireNonEmptyString,
} from "./server.sessions.create.test-support.js";
import {
  agentDiscoveryMock,
  dispatchInboundMessageMock,
  embeddedRunMock,
  rpcReq,
  testState,
  writeSessionStore,
} from "./test-helpers.js";
import {
  createCompactedSessionFixture,
  seedSessionTranscript,
  sessionStoreEntry,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir, openClient } = setupSessionCreateTestHarness();

test("an explicit API chat fork preserves searchable history larger than its model window", async () => {
  registerForkableCliBackend();
  const model = "fork-test";
  const contextWindow = 4096;
  testState.agentConfig = { model: { primary: `openai/${model}` } };
  agentDiscoveryMock.enabled = true;
  agentDiscoveryMock.models = [{ id: model, name: model, provider: "openai", contextWindow }];
  onTestFinished(() => {
    agentDiscoveryMock.enabled = false;
    agentDiscoveryMock.models = [];
    testState.agentConfig = undefined;
    testState.sessionConfig = undefined;
  });
  const { dir, storePath } = await createSessionStoreDir();
  testState.sessionConfig = { scope: "per-sender" };
  const parent = await createCompactedSessionFixture(dir);
  const projectRoot = path.join(dir, "qa-writer");
  await fs.mkdir(projectRoot);
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry(parent.sessionId, {
        visibility: "draft",
        sessionFile: parent.sessionFile,
        projectId: "qa-writer",
        spawnedCwd: projectRoot,
        sessionRoot: projectRoot,
        totalTokens: 123,
        totalTokensFresh: false,
        totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
        cliSessionBindings: {
          "claude-cli": { sessionId: "native-parent", resumeCheckpointId: "parent-checkpoint" },
        },
      }),
    },
  });
  const parentScope = { sessionId: parent.sessionId, sessionKey: "agent:main:main", storePath };
  const receipt = "VaultSlipRaven91";
  const decision = "The QA canary code is CobaltTrellis49.";
  const continuation = "What was the QA canary code we chose?";
  // Real, distinct ledger rows in the selected branch, not a large recorded usage counter.
  const ledger = Array.from({ length: 400 }, (_, i) =>
    createHash("sha256").update(String(i)).digest("hex"),
  ).join(" ");
  await seedSessionTranscript({
    ...parentScope,
    messages: [
      { role: "user", content: `Retired receipt: ${receipt}.` },
      { role: "assistant", content: [{ type: "text", text: "Receipt filed." }] },
      { role: "user", content: `Archived ledger: ${ledger}` },
      { role: "assistant", content: [{ type: "text", text: "Ledger filed." }] },
      { role: "user", content: decision },
      {
        role: "assistant",
        content: [{ type: "text", text: "Decision noted." }],
        stopReason: "stop",
      },
    ],
  });
  const parentEvents = await loadTranscriptEvents(parentScope);
  const { ws } = await openClient();
  onTestFinished(() => closeGatewayTestWebSocket(ws));
  const createParams = { agentId: "main", parentSessionKey: "main", fork: true };
  // The same branch must actually overflow the selected window when admission is bounded.
  const bounded = await rpcReq(ws, "sessions.create", { ...createParams, spawnDepth: 1 });
  expect(bounded).toMatchObject({
    ok: false,
    error: {
      code: "INVALID_REQUEST",
      message: expect.stringContaining(`/${contextWindow} tokens)`),
    },
  });
  const created = await rpcReq<{
    key?: string;
    sessionId?: string;
    entry?: {
      sessionFile?: string;
      parentSessionKey?: string;
      forkSource?: { sessionKey: string; sessionId: string };
      forkedFromParent?: boolean;
      totalTokens?: number;
      totalTokensFresh?: boolean;
    };
  }>(ws, "sessions.create", { ...createParams, key: "agent:main:dashboard:fork-publication" });

  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  expect(created.payload?.entry?.parentSessionKey).toBe("agent:main:main");
  expect(created.payload?.entry?.forkSource).toEqual({
    sessionKey: "agent:main:main",
    sessionId: parent.sessionId,
  });
  expect(created.payload?.entry?.forkedFromParent).toBe(true);
  expect(created.payload?.entry?.totalTokens).toBeUndefined();
  expect(created.payload?.entry?.totalTokensFresh).toBe(false);
  expect(created.payload?.sessionId).not.toBe(parent.sessionId);
  expect(created.payload?.entry).not.toHaveProperty("sessionFile");
  const forkedSessionId = requireNonEmptyString(created.payload?.sessionId, "forked session id");
  const key = requireNonEmptyString(created.payload?.key, "forked session key");
  const childScope = { sessionId: forkedSessionId, sessionKey: key, storePath };
  // Only the header changes in this linear branch: preserve every selected event and its identity.
  expect((await loadTranscriptEvents(childScope)).slice(1)).toEqual(parentEvents.slice(1));
  const match = await rpcReq<SessionsSearchResult>(ws, "sessions.search", {
    agentId: "main",
    sessionKeys: [key],
    query: receipt,
  });
  expect(match).toMatchObject({
    ok: true,
    payload: {
      results: [
        { sessionKey: key, sessionId: forkedSessionId, snippet: expect.stringContaining(receipt) },
      ],
    },
  });
  expect(loadSessionEntry({ sessionKey: key, storePath })).toMatchObject({
    visibility: "draft",
    projectId: "qa-writer",
    spawnedCwd: projectRoot,
    sessionRoot: projectRoot,
    sessionId: created.payload?.sessionId,
    cliSessionBindings: {
      "claude-cli": {
        sessionId: "native-parent",
        resumeCheckpointId: "parent-checkpoint",
        forkNextResume: true,
      },
    },
    forkSource: {
      sessionKey: "agent:main:main",
      sessionId: parent.sessionId,
    },
  });
  const listed = await rpcReq<{
    sessions?: Array<{
      key: string;
      forkedFromParent?: boolean;
    }>;
  }>(ws, "sessions.list", {});
  expect(listed.payload?.sessions?.find((row) => row.key === key)?.forkedFromParent).toBe(true);
  // Persist the neutral child turn via chat.send without invoking an inference provider.
  dispatchInboundMessageMock.mockImplementationOnce(async ({ replyOptions }) => {
    await replyOptions?.userTurnTranscriptRecorder?.persistApproved();
    return { queuedFinal: false, counts: { block: 0, final: 0, tool: 0 } };
  });
  const sent = await rpcReq(ws, "chat.send", {
    sessionKey: key,
    message: continuation,
    idempotencyKey: "fork-continuation",
  });
  expect(sent.ok, JSON.stringify(sent.error)).toBe(true);
  await captureSessionControllerSettlement({
    scope: storePath,
    identities: [key, forkedSessionId],
  });
  expect(JSON.stringify((await loadTranscriptEvents(childScope)).at(-1))).toContain(continuation);
  // Byte-identical serialized events include the original parent chain and leaf.
  expect(JSON.stringify(await loadTranscriptEvents(parentScope))).toBe(
    JSON.stringify(parentEvents),
  );
});

test.each([false, true])("does not revive reset context in forks (active=%s)", async (active) => {
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
  const contextMessages = async (sessionId = parentSessionId, sessionKey = parentKey) =>
    (
      await SessionManager.openModelContextAsync({ ...parentScope, sessionId, sessionKey })
    ).buildSessionContext().messages;
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
  const activeMessages = active
    ? [
        { role: "user", content: "new question" },
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "new-call", name: "lookup", arguments: {} }],
          stopReason: "toolUse",
        },
      ]
    : [];
  if (active) {
    await seedSessionTranscript({ ...parentScope, messages: activeMessages });
  }
  const originalEvents = await loadTranscriptEvents(parentScope);
  expect(originalEvents).toContainEqual(expect.objectContaining({ type: "reset", reason: "new" }));
  const parentMessages = await contextMessages();
  expect(parentMessages).toMatchObject(activeMessages);

  // The shared fixture simulates run liveness; reset, fork, and transcript reads stay real.
  if (active) {
    embeddedRunMock.activeIds.add(parentSessionId);
  }
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
  expect(await contextMessages(childSessionId, childKey)).toEqual([]);
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
  expect(
    await contextMessages(
      requireNonEmptyString(full.payload?.sessionId, "full fork session id"),
      requireNonEmptyString(full.payload?.key, "full fork session key"),
    ),
  ).toEqual([
    ...parentMessages,
    ...(active
      ? [
          {
            role: "toolResult",
            toolCallId: "new-call",
            toolName: "lookup",
            content: [
              {
                type: "text",
                text: "The parent session's result for this tool call was not available when this conversation was forked.",
              },
            ],
            isError: false,
            timestamp: expect.any(Number),
          },
        ]
      : []),
  ]);
  expect(await loadTranscriptEvents(parentScope)).toEqual(originalEvents);
});
