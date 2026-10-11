import path from "node:path";
import { createSessionProjection, reduceSessionProjection } from "@openclaw/gateway-client/browser";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, onTestFinished, test, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { HEARTBEAT_PROMPT } from "../auto-reply/heartbeat.js";
import { composeTranscriptDisplay } from "../chat/transcript-display-position.js";
import { clearConfigCache } from "../config/config.js";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  replaceTranscriptEvents,
} from "../config/sessions/session-accessor.js";
import { readTranscriptDisplayDelta } from "../config/sessions/session-accessor.sqlite-history-events.js";
import { waitForSessionTranscriptProjection } from "../config/sessions/session-transcript-reconcile.js";
import { createNestedToolActivity } from "../sessions/nested-tool-activity.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../state/openclaw-agent-db.js";
import * as userProfileList from "../state/user-profile-list.js";
import { setAvatar } from "../state/user-profile-writes.worker.js";
import * as userProfiles from "../state/user-profiles.js";
import { buildControlUiUserAvatarPath } from "./control-ui-contract.js";
import * as managedOutgoingMedia from "./managed-image-attachments.js";
import { serializeGatewayFrame } from "./serialized-json.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import {
  disposeSessionReadContexts,
  initializeSessionReadContext,
} from "./server-methods/sessions-read-cache.test-support.js";
import type { GatewayRequestContext } from "./server-methods/shared-types.js";
import { createTranscriptUpdateBroadcastHandler } from "./server-session-events.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";
import { installGatewayTestHooks, testState, writeSessionStore } from "./test-helpers.js";
installGatewayTestHooks({ scope: "suite" });
const tempDirs = createTempDirTracker();

type ChatMethod = "chat.history" | "chat.startup";
type History = { deltaCursor: string; messages: unknown[] };
type RpcResult<T = Record<string, unknown>> = {
  error?: unknown;
  ok: boolean;
  payload?: T;
};

const sessionKey = "agent:main:main";
const sessionId = "cursor-session";

function transcriptEvent(id: string, parentId: string | null, role: string, content: unknown) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date().toISOString(),
    message: { role, content, timestamp: Date.now() },
  };
}

function currentScope(storePath: string) {
  return { agentId: "main", sessionId, sessionKey, storePath };
}

async function createCursorSession(
  initialEvents?: unknown[],
  metadata: Record<string, unknown> = {},
) {
  const directory = tempDirs.make("openclaw-history-cursor-");
  const storePath = path.join(directory, "sessions.json");
  testState.sessionStorePath = storePath;
  await writeSessionStore({
    entries: {
      main: { ...metadata, sessionId, updatedAt: Date.now() },
    },
  });
  await replaceTranscriptEvents(
    currentScope(storePath),
    (initialEvents ?? [transcriptEvent("cached", null, "user", "cached")]) as Parameters<
      typeof replaceTranscriptEvents
    >[1],
  );
  const config = { session: { store: storePath } };
  const context = createDirectChatContext({ getRuntimeConfig: () => config });
  await initializeSessionReadContext(context);
  return { context, storePath };
}

async function callChat<T extends Record<string, unknown>>(
  context: GatewayRequestContext,
  method: ChatMethod,
  params: Record<string, unknown> = {},
): Promise<RpcResult<T>> {
  const { chatHandlers } = await import("./server-methods/chat.js");
  const result: RpcResult<T> = { ok: false };
  await chatHandlers[method]?.({
    client: null,
    context,
    acceptsSerializedJson: true,
    isWebchatConnect: () => false,
    params: { sessionKey: "main", ...params },
    req: { id: method, method, params, type: "req" },
    respond: (ok, payload, error) => {
      result.ok = ok;
      result.payload = JSON.parse(
        serializeGatewayFrame({ type: "res", payload }).toString(),
      ).payload;
      result.error = error;
    },
  });
  return result;
}

function renderedMessages(messages: readonly unknown[]): unknown[] {
  return messages.map((message) => {
    const record = asOptionalRecord(message);
    const metadata = asOptionalRecord(record?.["__openclaw"]);
    if (!metadata) {
      return message;
    }
    const { recordTimestampMs: _recordTimestampMs, ...visibleMetadata } = metadata;
    return { ...record, __openclaw: visibleMetadata };
  });
}

function messageIds(messages: readonly unknown[]) {
  return messages.map((message) => asOptionalRecord(asOptionalRecord(message)?.["__openclaw"])?.id);
}

afterEach(async () => {
  await disposeSessionReadContexts();
  for (const directory of tempDirs.dirs) {
    await closeOpenClawAgentDatabasesAsync(directory);
    closeOpenClawAgentDatabasesForTest(directory);
  }
  testState.sessionStorePath = undefined;
  clearConfigCache();
  tempDirs.cleanup();
});

describe("chat.history cursor catch-up", () => {
  test("keeps live and cursor sequences identical after compaction and a same-session reset", async () => {
    type Envelope = { message: unknown; messageId: string; messageSeq: number };
    const oldEvents: Array<Record<string, unknown>> = [];
    for (let turn = 1; turn <= 3; turn += 1) {
      oldEvents.push({
        type: "message",
        id: `old-user-${turn}`,
        message: { role: "user", content: `ARCHIVED_USER_${turn}` },
      });
      if (turn === 1) {
        oldEvents.push(
          { type: "thinking_level_change", id: "thinking", thinkingLevel: "off" },
          { type: "custom", id: "model", customType: "model-snapshot" },
        );
      }
      oldEvents.push(
        {
          type: "message",
          id: `old-reply-${turn}`,
          message: { role: "assistant", content: `ARCHIVED_REPLY_${turn}` },
        },
        {
          type: "custom",
          id: `old-bootstrap-${turn}`,
          customType: "openclaw:bootstrap-context:full",
        },
      );
    }
    for (const [index, event] of oldEvents.entries()) {
      event.parentId = oldEvents[index - 1]?.id ?? null;
    }
    const { context, storePath } = await createCursorSession(
      [{ type: "session", version: 3, id: sessionId }, ...oldEvents],
      {
        compactionCheckpoints: [
          {
            preCompaction: { sessionId },
            postCompaction: { sessionId, entryId: "fresh-compaction" },
            tokensBefore: 42_000,
            tokensAfter: 8_000,
          },
        ],
      },
    );
    const scope = currentScope(storePath);
    await appendTranscriptEvent(scope, {
      type: "compaction",
      id: "old-compaction",
      parentId: "old-bootstrap-3",
      summary: "old summary",
      firstKeptEntryId: "old-user-3",
      timestamp: new Date().toISOString(),
    });
    await appendTranscriptEvent(scope, {
      type: "reset",
      id: "reset",
      parentId: "old-compaction",
      reason: "reset",
      timestamp: new Date().toISOString(),
    });
    const cleanup = vi
      .spyOn(managedOutgoingMedia, "cleanupManagedOutgoingMediaRecords")
      .mockResolvedValue({ deletedRecordCount: 0, deletedFileCount: 0, retainedCount: 0 });
    onTestFinished(() => cleanup.mockRestore());
    const cached = await callChat<History>(context, "chat.history");
    expect(cached.ok).toBe(true);
    expect(cleanup).not.toHaveBeenCalled();
    cleanup.mockRestore();
    expect(cached.payload?.messages).toMatchObject([
      { __openclaw: { id: "reset", seq: 1, transcriptPosition: { rawSeq: 13 } } },
    ]);
    let cursor = cached.payload!.deltaCursor;
    let projection = createSessionProjection({ sessionId, sessionKey }, cached.payload!.messages);
    const broadcast = vi.fn();
    const handler = createTranscriptUpdateBroadcastHandler({
      getSessionRowProjection: () => getSessionRowProjection(context),
      broadcastToConnIds: broadcast,
      chatAbortControllers: context.chatAbortControllers,
      sessionEventSubscribers: { getAll: () => new Set<string>() },
      sessionMessageSubscribers: { get: () => new Set(["subscriber"]) },
    });
    const replay = (envelope: Envelope) => {
      projection = reduceSessionProjection(projection, {
        type: "messagePersisted",
        message: envelope.message,
        envelope,
        sessionId,
        sessionKey,
      });
    };
    let parentId = "reset";
    for (let turn = 1; turn <= 3; turn += 1) {
      for (const role of ["user", "assistant"] as const) {
        const id = `fresh-${role}-${turn}`;
        const message = { role, content: `FRESH_${role === "user" ? "USER" : "REPLY"}_${turn}` };
        await appendTranscriptMessage(scope, { eventId: id, parentId, message });
        parentId = id;
        broadcast.mockClear();
        await handler({ target: scope, messageId: id, message });
        expect(broadcast).toHaveBeenCalledTimes(1);
        expect(broadcast.mock.calls[0]?.[0]).toBe("session.message");
        const live = broadcast.mock.calls[0]?.[1] as Envelope;
        replay(live);
        const delta = await callChat<{ kind: string; deltaCursor: string; messages: Envelope[] }>(
          context,
          "chat.history",
          { cursor },
        );
        expect(delta).toMatchObject({ ok: true, payload: { kind: "delta" } });
        expect(delta.payload!.messages).toHaveLength(1);
        const caughtUp = delta.payload!.messages[0]!;
        expect.soft(caughtUp.messageSeq).toBe(live.messageSeq);
        expect.soft(renderedMessages([caughtUp.message])).toEqual(renderedMessages([live.message]));
        replay(caughtUp);
        cursor = delta.payload!.deltaCursor;
      }
      const bootstrapId = `fresh-bootstrap-${turn}`;
      await appendTranscriptEvent(scope, {
        type: "custom",
        id: bootstrapId,
        parentId,
        customType: "openclaw:bootstrap-context:full",
      });
      parentId = bootstrapId;
    }
    const fresh = await callChat<History>(context, "chat.history");
    expect
      .soft(renderedMessages(projection.messages))
      .toEqual(renderedMessages(fresh.payload!.messages));
    const expectedIds = [
      "reset",
      "fresh-user-1",
      "fresh-assistant-1",
      "fresh-user-2",
      "fresh-assistant-2",
      "fresh-user-3",
      "fresh-assistant-3",
    ];
    expect.soft(messageIds(projection.messages)).toEqual(expectedIds);
    await appendTranscriptEvent(scope, {
      type: "compaction",
      id: "fresh-compaction",
      parentId,
      summary: "fresh summary",
      firstKeptEntryId: "fresh-user-3",
      timestamp: new Date().toISOString(),
    });
    expect(await callChat(context, "chat.history", { cursor })).toMatchObject({
      ok: true,
      payload: { kind: "reset" },
    });
    const reloaded = await callChat<History>(context, "chat.history");
    expect(messageIds(reloaded.payload!.messages)).toEqual([...expectedIds, "fresh-compaction"]);
    expect(reloaded.payload!.messages.at(-1)).toMatchObject({
      __openclaw: { tokensBefore: 42_000, tokensAfter: 8_000 },
    });
  });

  test("composes nested completions identically after cursor catch-up and fresh history", async () => {
    const { context, storePath } = await createCursorSession();
    const cached = await callChat<History>(context, "chat.history");
    let parentId = "cached";
    for (const [id, afterEntryId, startOrder] of [
      ["exec", undefined, 0],
      ["wait", undefined, 0],
      ["second", "exec", 1],
      ["first", "exec", 0],
      ["later", "second", 2],
    ] as const) {
      const message =
        afterEntryId === undefined
          ? { role: "assistant", content: id }
          : createNestedToolActivity({
              runId: "nested-run",
              scopeId: "attempt",
              afterEntryId,
              startOrder,
              parentToolCallId: "exec",
              toolCallId: id,
              toolName: "read",
              input: {},
              result: { content: [{ type: "text", text: id }] },
              isError: false,
              startedAt: 1,
              timestamp: 2,
            });
      await appendTranscriptMessage(currentScope(storePath), { eventId: id, parentId, message });
      parentId = id;
    }
    const delta = await callChat<{
      kind?: string;
      messages?: Array<{ message?: unknown; messageId?: unknown; messageSeq?: unknown }>;
    }>(context, "chat.history", { cursor: cached.payload?.deltaCursor });
    const fresh = await callChat<{ messages?: unknown[] }>(context, "chat.history");
    expect(delta).toMatchObject({ ok: true, payload: { kind: "delta" } });
    expect(fresh.ok).toBe(true);
    let projection = createSessionProjection(
      { sessionId, sessionKey },
      cached.payload?.messages ?? [],
    );
    for (const envelope of delta.payload?.messages ?? []) {
      projection = reduceSessionProjection(projection, {
        type: "messagePersisted",
        message: envelope.message,
        envelope,
        sessionId,
        sessionKey,
      });
    }
    const composed = composeTranscriptDisplay([...projection.messages]);
    expect(renderedMessages(composed)).toEqual(renderedMessages(fresh.payload?.messages ?? []));
    expect(messageIds(composed)).toEqual(["cached", "exec", "first", "second", "wait", "later"]);
  });

  test("refreshes sender display across transferred history pages and cursor deltas", async () => {
    const { context, storePath } = await createCursorSession();
    const profile = userProfiles.ensureProfileForEmail("cursor-profile@example.test");
    const cached = await callChat<{ deltaCursor: string }>(context, "chat.history");
    expect(cached.ok).toBe(true);
    expect(cached.payload?.deltaCursor).toEqual(expect.any(String));
    let parentId = "cached";
    for (let index = 0; index < 3; index += 1) {
      const eventId = `profile-message-${index}`;
      await appendTranscriptMessage(currentScope(storePath), {
        eventId,
        parentId,
        message: {
          role: "user",
          content: `question ${index}`,
          __openclaw: { senderIdentity: { type: "profile", id: profile.id } },
        },
      });
      parentId = eventId;
    }
    const lookup = vi.spyOn(userProfileList, "getUserProfileDisplay");
    try {
      const avatarUrls: string[] = [];
      for (const byte of [1, 2]) {
        expect(setAvatar(profile.id, new Uint8Array([byte]), "image/png").ok).toBe(true);
        const { avatarRevision } = userProfiles.getUserProfileDisplay(profile.id);
        const avatarUrl = buildControlUiUserAvatarPath(profile.id, avatarRevision);
        avatarUrls.push(avatarUrl);
        lookup.mockClear();
        const history = await callChat<History>(context, "chat.history");
        expect(history.ok).toBe(true);
        expect(lookup).not.toHaveBeenCalled();
        expect(history.payload?.messages).toHaveLength(4);
        for (const message of history.payload?.messages.slice(-3) ?? []) {
          expect(message).toMatchObject({
            __openclaw: {
              senderIdentity: { type: "profile", id: profile.id },
              senderProfileAvatarUrl: avatarUrl,
            },
          });
        }
        const delta = await callChat<{ kind: string; messages: unknown[] }>(
          context,
          "chat.history",
          { cursor: cached.payload?.deltaCursor },
        );
        expect(delta.ok).toBe(true);
        expect(delta.payload?.kind).toBe("delta");
        expect(lookup.mock.calls).toEqual([[profile.id]]);
        expect(delta.payload?.messages).toHaveLength(3);
        for (const envelope of delta.payload?.messages ?? []) {
          expect(envelope).toMatchObject({
            message: {
              __openclaw: {
                senderIdentity: { type: "profile", id: profile.id },
                senderProfileAvatarUrl: avatarUrl,
              },
            },
          });
        }
      }
      expect(avatarUrls[1]).not.toBe(avatarUrls[0]);
    } finally {
      lookup.mockRestore();
    }
  });

  test("returns an empty delta at the cached head with a fixed multi-agent store", async () => {
    testState.agentsConfig = {
      ownership: "explicit",
      entries: { main: {}, ops: {} },
    };
    testState.agentConfig = { sessionStore: { agentId: "main" } };
    const { context } = await createCursorSession();
    const page = await callChat<History>(context, "chat.history", { sessionKey });
    expect(page.ok).toBe(true);
    expect(page.payload?.deltaCursor).toEqual(expect.any(String));
    const explicitFirstPage = await callChat<{ deltaCursor?: string }>(context, "chat.history", {
      sessionKey,
      offset: 0,
    });
    expect(explicitFirstPage.payload?.deltaCursor).toEqual(expect.any(String));

    const delta = await callChat(context, "chat.history", {
      sessionKey,
      cursor: page.payload?.deltaCursor,
    });
    expect(delta).toMatchObject({
      ok: true,
      payload: {
        kind: "delta",
        messages: [],
        deltaCursor: page.payload?.deltaCursor,
        sessionInfo: { activeLeafEntryId: "cached" },
      },
    });
  });

  test.each([
    { name: "no sibling", sibling: [] },
    {
      name: "a tool sibling",
      sibling: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }],
    },
  ])("keeps heartbeat boundaries after filtered commentary with $name", async ({ sibling }) => {
    const { context, storePath } = await createCursorSession();
    const cached = await callChat<{ deltaCursor: string }>(context, "chat.history");
    expect(cached.ok).toBe(true);
    expect(cached.payload?.deltaCursor).toEqual(expect.any(String));
    const scope = currentScope(storePath);
    await appendTranscriptMessage(scope, {
      eventId: "heartbeat",
      parentId: "cached",
      message: { role: "user", content: HEARTBEAT_PROMPT, timestamp: 2 },
    });
    await appendTranscriptMessage(scope, {
      eventId: "commentary",
      parentId: "heartbeat",
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "ANNOUNCE_SKIP REPLY_SKIP",
            textSignature: JSON.stringify({ v: 1, id: "commentary", phase: "commentary" }),
          },
          ...sibling,
        ],
        timestamp: 3,
      },
    });
    await appendTranscriptMessage(scope, {
      eventId: "after-commentary",
      parentId: "commentary",
      message: { role: "assistant", content: "visible after commentary", timestamp: 4 },
    });

    const delta = await callChat<{
      kind: string;
      messages: Array<{ messageId: string; message: Record<string, unknown> }>;
    }>(context, "chat.history", { cursor: cached.payload?.deltaCursor });
    expect(delta).toMatchObject({ ok: true, payload: { kind: "delta" } });
    // Hidden commentary must not consume the boundary owed to the next visible row.
    expect(
      delta.payload?.messages.map(({ messageId, message }) => ({
        messageId,
        content: message.content,
        turnBoundary: asOptionalRecord(message["__openclaw"])?.turnBoundary === true,
      })),
    ).toEqual([
      ...(sibling.length > 0
        ? [{ messageId: "commentary", content: sibling, turnBoundary: true }]
        : []),
      {
        messageId: "after-commentary",
        content: "visible after commentary",
        turnBoundary: sibling.length === 0,
      },
    ]);
  });

  test("resets cached history after an appended leaf rewinds the active branch", async () => {
    const { context, storePath } = await createCursorSession([
      transcriptEvent("root", null, "user", "retained"),
      transcriptEvent("abandoned", "root", "assistant", "rejected draft"),
    ]);
    const cached = await callChat<{ deltaCursor: string }>(context, "chat.history");
    expect(cached).toMatchObject({
      ok: true,
      payload: {
        deltaCursor: expect.any(String),
        messages: [{ __openclaw: { id: "root" } }, { __openclaw: { id: "abandoned" } }],
      },
    });
    const scope = currentScope(storePath);
    await appendTranscriptEvent(scope, {
      type: "leaf",
      id: "rewind",
      parentId: "abandoned",
      targetId: "root",
      appendParentId: "root",
    });
    await waitForSessionTranscriptProjection(scope);

    const fresh = await callChat(context, "chat.history");
    expect(fresh).toMatchObject({
      ok: true,
      payload: { messages: [{ __openclaw: { id: "root" } }] },
    });
    expect(
      readTranscriptDisplayDelta(scope, { cursor: cached.payload!.deltaCursor }),
    ).toMatchObject({
      kind: "page",
      activeLeafEntryId: "root",
      events: [{ event: { type: "leaf", id: "rewind" } }],
    });
    const delta = await callChat(context, "chat.history", { cursor: cached.payload!.deltaCursor });
    expect(delta).toMatchObject({ ok: true, payload: { kind: "reset" } });
  });

  test.each(["offset", "messageId"] as const)("rejects cursor with %s", async (field) => {
    const { context } = await createCursorSession();
    const result = await callChat(context, "chat.history", {
      cursor: "cursor",
      [field]: field === "offset" ? 0 : "cached",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({ code: "INVALID_REQUEST" });
  });

  test("chat.startup returns startup projections with a delta", async () => {
    const { context, storePath } = await createCursorSession();
    context.readChatStartupProjection = async () => ({
      metadata: { swarmEnabled: false },
      sessionModelCatalog: [],
      defaultModelCatalog: [],
    });
    const page = await callChat<{ deltaCursor?: string }>(context, "chat.startup");
    await appendTranscriptMessage(currentScope(storePath), {
      eventId: "startup-append",
      parentId: "cached",
      message: { role: "assistant", content: "startup delta", timestamp: 2 },
    });
    const delta = await callChat(context, "chat.startup", { cursor: page.payload?.deltaCursor });
    expect(delta).toMatchObject({
      ok: true,
      payload: {
        kind: "delta",
        messages: [expect.any(Object)],
        sessionInfo: expect.any(Object),
        metadata: expect.any(Object),
      },
    });
    expect(delta.payload).not.toHaveProperty("agentsList");
  });
});
