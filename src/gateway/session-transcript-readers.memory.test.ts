import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { buildConversationIdentity } from "../config/sessions/conversation-identity.js";
import { registerConversationAddresses } from "../config/sessions/conversation-registry.js";
import type { SessionActorAuthority } from "../config/sessions/session-actor-contract.js";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import { runWithSessionActorStorage } from "../config/sessions/session-actor-storage-binding.js";
import { readSessionActorStorageResult } from "../config/sessions/session-actor-storage-result.js";
import type { SessionMetadataOperations } from "../config/sessions/session-manager-write-contract.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { readSessionHistorySnapshotAsync } from "./session-history-state.js";
import { readSessionPreviewItemsFromTranscriptAsync } from "./session-transcript-preview.js";
import {
  readRecentSessionMessagesWithStatsAsync as readRecent,
  readSessionArtifacts as readArtifacts,
  readSessionConversationBindingAsync as readBinding,
  readSessionMessageByIdAsync as readById,
  readSessionMessageCountAsync as readCount,
  readSessionMessagesAroundIdWithStatsAsync as readAround,
  readSessionMessagesAsync as readMessages,
  readSessionMessagesMatchingIdAsync as readMatching,
  readSessionMessagesPageWithStatsAsync as readPage,
  readSessionMessagesWithSourceAsync as readSource,
  readSessionTranscriptAccountingAsync as readAccounting,
  readSessionTranscriptBoundedMessageTailPageAsync as readTail,
  readSessionTranscriptSummaryAsync as readSummary,
} from "./session-transcript-readers.js";
import { readSessionTitleFieldsFromTranscriptAsync } from "./session-transcript-title-reader.js";
import { readSessionTitleFieldsFromTranscript } from "./session-transcript-title-reader.worker.js";

vi.mock("node:sqlite", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:sqlite")>()),
  DatabaseSync: vi.fn(function () {
    throw new Error("Gateway memory history opened SQLite");
  }),
}));
vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  Worker: vi.fn(function () {
    throw new Error("Gateway memory history allocated a worker");
  }),
}));

const env = { OPENCLAW_STATE_DIR: "/synthetic/gateway-memory-history" };
const authority: SessionActorAuthority = { assertCurrent() {}, authorize() {} };
const lifetime = { assertCurrent() {}, assertReadable() {} };
afterEach(() => memorySessionActorOwners.reset());

const messageIds = (messages: readonly unknown[]) =>
  messages.map((message) =>
    isRecord(message) && isRecord(message["__openclaw"]) ? message["__openclaw"].id : undefined,
  );

async function readIds(result: Promise<readonly unknown[] | { messages: readonly unknown[] }>) {
  const value = await result;
  return messageIds("messages" in value ? value.messages : value);
}

type ReadScope = Parameters<typeof readSummary>[0];
const usage = (scope: ReadScope) => readSummary(scope, { kind: "usage" });
const artifacts = (scope: ReadScope, sessionKey = scope.sessionKey) => {
  if (!sessionKey) {
    throw new Error("Expected a session key for artifact reads");
  }
  return readArtifacts(scope, { kind: "list", sessionKey });
};

async function expectEmptyOverview(scope: ReadScope, sessionKey = scope.sessionKey) {
  expect([await usage(scope), await artifacts(scope, sessionKey)]).toEqual([
    { kind: "usage", usage: null },
    { kind: "list", artifacts: [] },
  ]);
}

function event(id: string, parentId: string | null, message: Record<string, unknown>) {
  return { type: "message" as const, id, parentId, timestamp: "2026-10-11T00:00:00.000Z", message };
}

async function fixture(sessionId = "one", agentId = "main", announce = false) {
  const storePath = resolveIncognitoOpenClawAgentSqlitePath({ agentId, env });
  const owner = memorySessionActorOwners.get({ agentId, path: storePath });
  const sessionKey = `agent:${agentId}:dashboard:incognito-${sessionId}`;
  const actor = await owner.acquire({ database: owner.identity, sessionKey }, lifetime);
  const storage = actor.storage!;
  const mutate = async (operation: Parameters<typeof storage.mutate>[0]) =>
    readSessionActorStorageResult(await storage.mutate(operation, authority));
  const transcriptEvents = [
    { type: "session", id: sessionId, version: 3, cwd: "/synthetic" },
    event("user", null, {
      role: "user",
      content: "Question",
      ...(announce
        ? { provenance: { kind: "inter_session", sourceTool: "subagent_announce" } }
        : {}),
    }),
    event("answer", "user", {
      role: "assistant",
      content: `Answer ${sessionId}`,
      usage: { input: 10, output: 2 },
    }),
  ];
  await mutate({
    type: "session.entry.create",
    input: { entry: { sessionId, updatedAt: 1, incognito: true }, transcriptEvents },
  });
  const scope = { agentId, sessionKey, sessionId, storePath, env };
  const append = async (
    input: Pick<SessionMetadataOperations["session.metadata.append"]["input"], "event" | "message">,
  ) => mutate({ type: "session.metadata.append", input: { scope, ...input, options: {} } });
  return {
    owner,
    scope,
    run: <T>(callback: () => T) =>
      runWithSessionActorStorage({ actor, authority, agentId, path: storePath }, callback),
    append: (next: unknown) => append({ event: JSON.stringify(next) }),
    appendMessage: (...args: Parameters<typeof event>) => {
      const { message, ...envelope } = event(...args);
      return append({
        event: envelope,
        message: { messageJson: JSON.stringify(message), cwd: "/synthetic", validateTurn: false },
      });
    },
  };
}

it("reads current conversation bindings from the selected owner's catalog", async () => {
  const root = await fixture();
  const other = await fixture("other", "helper");
  const identity = buildConversationIdentity({
    channel: "reef",
    accountId: "default",
    kind: "direct",
    peerId: "peer-a",
    deliveryTarget: "reef:peer-a",
  })!;
  for (const target of [root, other]) {
    await target.run(() => registerConversationAddresses(target.scope, [identity], 100));
  }
  await root.run(async () => {
    for (const target of [root, other]) {
      expect(await readBinding(target.scope, identity.conversationRef)).toEqual({
        channel: "reef",
        accountId: "default",
        target: "reef:peer-a",
        threadId: undefined,
        nativeChannelId: undefined,
      });
    }
    await registerConversationAddresses(
      root.scope,
      [{ ...identity, deliveryTarget: "reef:new-address" }],
      200,
    );
    expect(await readBinding(root.scope, identity.conversationRef)).toMatchObject({
      target: "reef:new-address",
    });
    expect(await readBinding(root.scope, "conv_00000000000000000000000000000000")).toBeNull();
  });
});

it("serves queued writes through pages, exact reads, accounting, summaries, and artifacts", async () => {
  const { run, scope, append, appendMessage } = await fixture();
  await run(async () => {
    expect(await readCount(scope)).toBe(2);
    expect(await usage(scope)).toMatchObject({
      usage: { inputTokens: 10, outputTokens: 2 },
    });
    const writing = appendMessage("next", "answer", {
      role: "assistant",
      content: [
        { type: "text", text: "New answer" },
        { type: "file", fileName: "report.txt", mimeType: "text/plain", data: "aGVsbG8=" },
      ],
      usage: { input: 20, output: 3 },
    });
    expect(await readIds(readRecent(scope, { maxMessages: 1 }))).toEqual(["next"]);
    await writing;
    expect({
      count: await readCount(scope),
      full: await readIds(readMessages(scope, { mode: "full", reason: "export" })),
      recent: await readIds(readMessages(scope, { mode: "recent", maxMessages: 1 })),
      source: await readIds(readSource(scope, { mode: "page" })),
      page: await readIds(readPage(scope, { offset: 1, maxMessages: 1 })),
      older: await readIds(
        readAround(scope, { messageId: "answer", direction: "older", maxMessages: 2 }),
      ),
      exact: await readById(scope, "next", { currentOnly: true, maxBytes: 16384 }),
      matching: await readIds(readMatching(scope, "next")),
      accounting: await readAccounting(scope, { includeByteSize: true, includeUsage: true }),
    }).toMatchObject({
      count: 3,
      full: ["user", "answer", "next"],
      recent: ["next"],
      source: ["user", "answer", "next"],
      page: ["answer"],
      older: ["user", "answer"],
      exact: { found: true, message: { __openclaw: { id: "next" } } },
      matching: ["next"],
      accounting: { byteSize: expect.any(Number), usage: { promptTokens: 20, outputTokens: 3 } },
    });
    const tail = await readTail(scope, {
      maxBytes: 16384,
      maxMessages: 2,
      offset: 0,
    });
    expect(tail.events.map(({ event: row }) => isRecord(row) && row.id)).toEqual([
      "answer",
      "next",
    ]);
    expect(await usage(scope)).toMatchObject({
      usage: { inputTokens: 30, outputTokens: 5 },
    });
    expect(await artifacts(scope)).toMatchObject({
      kind: "list",
      artifacts: [{ title: "report.txt", type: "file", messageSeq: 3 }],
    });
    await append({
      type: "reset",
      id: "reset",
      parentId: "next",
      reason: "new",
      timestamp: "2026-10-11T00:00:01.000Z",
    });
    await append({
      type: "custom_message",
      id: "display",
      parentId: "reset",
      customType: "fixture",
      display: true,
      timestamp: "2026-10-11T00:00:02.000Z",
      content: [
        { type: "file", fileName: "display-only.txt", mimeType: "text/plain", data: "aGVsbG8=" },
      ],
    });
    await expectEmptyOverview(scope);
  });
});

it("reads sibling and cross-agent windows while absent history stays absent", async () => {
  const root = await fixture();
  const sibling = await fixture("two");
  const other = await fixture("three", "helper");
  await root.run(async () => {
    for (const target of [sibling, other]) {
      const scope = { ...target.scope, sessionKey: undefined };
      expect(await readById(scope, "answer")).toMatchObject({
        message: { content: `Answer ${target.scope.sessionId}` },
      });
      expect(await readCount(scope)).toBe(2);
    }
    const before = root.owner.listSessions(authority).length;
    const missing = { ...root.scope, sessionKey: undefined, sessionId: "absent" };
    expect({
      count: await readCount(missing),
      messages: await readMessages(missing, { mode: "full", reason: "export" }),
      matching: await readMatching(missing, "answer"),
      exact: await readById(missing, "answer"),
    }).toEqual({ count: 0, messages: [], matching: [], exact: { found: false, oversized: false } });
    expect(
      await readAround(missing, {
        messageId: "answer",
        maxMessages: 1,
      }),
    ).toMatchObject({
      found: false,
      messages: [],
      totalMessages: 0,
    });
    await expectEmptyOverview(missing, root.scope.sessionKey);
    expect(root.owner.listSessions(authority)).toHaveLength(before);
  });
});

it("hides out-of-page coordination errors and reveals output after an in-process human steer", async () => {
  const { run, scope, appendMessage } = await fixture();
  await appendMessage("coordination-input", "answer", {
    role: "user",
    content: "Internal coordination",
    idempotencyKey: "coordination:user",
    provenance: { kind: "inter_session", sourceTool: "sessions_send", sourceRole: "subagent" },
  });
  await appendMessage("coordination-error", "coordination-input", {
    role: "assistant",
    content: [],
    stopReason: "error",
    errorMessage: "Internal failure",
    __openclaw: { runId: "coordination" },
  });
  await run(async () => {
    const hidden = await readById(scope, "coordination-error", {
      historyVisibility: {},
    });
    expect(hidden).toEqual({ found: false, oversized: false, historyHidden: true });
    const before = await readSessionHistorySnapshotAsync({ target: scope, limit: 1 });
    expect(messageIds(before.history.messages)).toEqual(["answer"]);
    await appendMessage("human-steer", "coordination-error", {
      role: "user",
      content: "Show me the result",
      __openclaw: { steerTargetRunId: "coordination" },
    });
    await appendMessage("visible-result", "human-steer", {
      role: "assistant",
      content: "Visible result",
      __openclaw: { runId: "coordination" },
    });
    const after = await readSessionHistorySnapshotAsync({ target: scope, limit: 1 });
    expect(messageIds(after.history.messages)).toEqual(["visible-result"]);
  });
});

it("preserves exact-message visibility and cancellation at the Gateway reader boundary", async () => {
  const { run, scope } = await fixture("announce", "main", true);
  await run(async () => {
    expect(
      await readById(scope, "answer", {
        historyVisibility: { sessionStartedAt: Date.parse("2026-10-11T00:01:00.000Z") },
      }),
    ).toEqual({ found: false, oversized: false, historyHidden: true });
    const controller = new AbortController();
    controller.abort(new Error("reader cancelled"));
    await expect(readPage(scope, { offset: 0, maxMessages: 1 }, controller.signal)).rejects.toThrow(
      "reader cancelled",
    );
  });
});
it("reads unbound Gateway transcript state after an in-process append without creating missing owners", async () => {
  const target = await fixture();
  expect(await readCount(target.scope)).toBe(2);
  await target.appendMessage("next", "answer", { role: "user", content: "Next question" });
  expect(await readCount(target.scope)).toBe(3);
  expect(await readById(target.scope, "next")).toMatchObject({ found: true });
  expect(readSessionTitleFieldsFromTranscript(target.scope)).toMatchObject({
    firstUserMessage: "Question",
    lastMessagePreview: "Next question",
  });
  expect(await readSessionTitleFieldsFromTranscriptAsync(target.scope)).toEqual(
    readSessionTitleFieldsFromTranscript(target.scope),
  );
  expect(await readSessionPreviewItemsFromTranscriptAsync(target.scope, 3, 100)).toEqual(
    expect.arrayContaining([expect.objectContaining({ role: "user", text: "Next question" })]),
  );
  target.owner.closeSession(target.scope.sessionKey);
  expect(await readCount(target.scope)).toBe(0);
  const missing = {
    ...target.scope,
    agentId: "absent",
    sessionKey: "agent:absent:dashboard:incognito-missing",
    storePath: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "absent", env }),
  };
  expect(await readCount(missing)).toBe(0);
  expect(memorySessionActorOwners.list()).toHaveLength(1);
});
