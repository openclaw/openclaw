import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  readRecentSessionMessagesWithStatsAsync,
  readSessionArtifacts,
  readSessionConversationBindingAsync,
  readSessionMessageByIdAsync,
  readSessionMessageCountAsync,
  readSessionMessagesAroundIdWithStatsAsync,
  readSessionMessagesAsync,
  readSessionMessagesMatchingIdAsync,
  readSessionMessagesPageWithStatsAsync,
  readSessionMessagesWithSourceAsync,
  readSessionTranscriptAccountingAsync,
  readSessionTranscriptBoundedMessageTailPageAsync,
  readSessionTranscriptSummaryAsync,
} from "./session-transcript-readers.js";
import {
  readSessionTitleFieldsFromTranscript,
  readSessionTitleFieldsFromTranscriptAsync,
} from "./session-transcript-title-reader.js";

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

function event(id: string, parentId: string | null, message: Record<string, unknown>) {
  return { type: "message" as const, id, parentId, timestamp: "2026-10-11T00:00:00.000Z", message };
}

async function fixture(sessionId = "one", agentId = "main", announce = false) {
  const storePath = resolveIncognitoOpenClawAgentSqlitePath({ agentId, env });
  const owner = memorySessionActorOwners.get({ agentId, path: storePath });
  const sessionKey = `agent:${agentId}:dashboard:incognito-${sessionId}`;
  const actor = await owner.acquire({ database: owner.identity, sessionKey }, lifetime);
  const storage = actor.storage!;
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
  readSessionActorStorageResult(
    await storage.mutate(
      {
        type: "session.entry.create",
        input: { entry: { sessionId, updatedAt: 1, incognito: true }, transcriptEvents },
      },
      authority,
    ),
  );
  const scope = { agentId, sessionKey, sessionId, storePath, env };
  const append = async (
    input: Pick<SessionMetadataOperations["session.metadata.append"]["input"], "event" | "message">,
  ) =>
    readSessionActorStorageResult(
      await storage.mutate(
        { type: "session.metadata.append", input: { scope, ...input, options: {} } },
        authority,
      ),
    );
  return {
    owner,
    actor,
    scope,
    binding: { actor, authority, agentId, path: storePath },
    append: (next: unknown) => append({ event: JSON.stringify(next) }),
    appendMessage: ({ message, ...envelope }: ReturnType<typeof event>) =>
      append({
        event: envelope,
        message: { messageJson: JSON.stringify(message), cwd: "/synthetic", validateTurn: false },
      }),
  };
}

describe("Gateway memory transcript readers", () => {
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
      await runWithSessionActorStorage(target.binding, () =>
        registerConversationAddresses(target.scope, [identity], 100),
      );
    }
    await runWithSessionActorStorage(root.binding, async () => {
      for (const target of [root, other]) {
        expect(
          await readSessionConversationBindingAsync(target.scope, identity.conversationRef),
        ).toEqual({
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
      expect(
        await readSessionConversationBindingAsync(root.scope, identity.conversationRef),
      ).toMatchObject({ target: "reef:new-address" });
      expect(
        await readSessionConversationBindingAsync(
          root.scope,
          "conv_00000000000000000000000000000000",
        ),
      ).toBeNull();
    });
  });

  it("serves queued writes through pages, exact reads, accounting, summaries, and artifacts", async () => {
    const { binding, scope, append, appendMessage } = await fixture();
    await runWithSessionActorStorage(binding, async () => {
      expect(await readSessionMessageCountAsync(scope)).toBe(2);
      expect(await readSessionTranscriptSummaryAsync(scope, { kind: "usage" })).toMatchObject({
        usage: { inputTokens: 10, outputTokens: 2 },
      });
      const writing = appendMessage(
        event("next", "answer", {
          role: "assistant",
          content: [
            { type: "text", text: "New answer" },
            { type: "file", fileName: "report.txt", mimeType: "text/plain", data: "aGVsbG8=" },
          ],
          usage: { input: 20, output: 3 },
        }),
      );
      expect(
        messageIds(
          (await readRecentSessionMessagesWithStatsAsync(scope, { maxMessages: 1 })).messages,
        ),
      ).toEqual(["next"]);
      await writing;
      expect(await readSessionMessageCountAsync(scope)).toBe(3);
      expect(
        messageIds(await readSessionMessagesAsync(scope, { mode: "full", reason: "export" })),
      ).toEqual(["user", "answer", "next"]);
      expect(
        messageIds(await readSessionMessagesAsync(scope, { mode: "recent", maxMessages: 1 })),
      ).toEqual(["next"]);
      expect(
        messageIds((await readSessionMessagesWithSourceAsync(scope, { mode: "page" })).messages),
      ).toEqual(["user", "answer", "next"]);
      expect(
        messageIds(
          (await readSessionMessagesPageWithStatsAsync(scope, { offset: 1, maxMessages: 1 }))
            .messages,
        ),
      ).toEqual(["answer"]);
      expect(
        messageIds(
          (
            await readSessionMessagesAroundIdWithStatsAsync(scope, {
              messageId: "answer",
              direction: "older",
              maxMessages: 2,
            })
          ).messages,
        ),
      ).toEqual(["user", "answer"]);
      expect(
        await readSessionMessageByIdAsync(scope, "next", { currentOnly: true, maxBytes: 16384 }),
      ).toMatchObject({
        found: true,
        message: { __openclaw: { id: "next" } },
      });
      expect(messageIds(await readSessionMessagesMatchingIdAsync(scope, "next"))).toEqual(["next"]);
      expect(
        await readSessionTranscriptAccountingAsync(scope, {
          includeByteSize: true,
          includeUsage: true,
        }),
      ).toMatchObject({
        byteSize: expect.any(Number),
        usage: { promptTokens: 20, outputTokens: 3 },
      });
      const tail = await readSessionTranscriptBoundedMessageTailPageAsync(scope, {
        maxBytes: 16384,
        maxMessages: 2,
        offset: 0,
      });
      expect(tail.events.map(({ event: row }) => isRecord(row) && row.id)).toEqual([
        "answer",
        "next",
      ]);
      expect(await readSessionTranscriptSummaryAsync(scope, { kind: "usage" })).toMatchObject({
        usage: { inputTokens: 30, outputTokens: 5 },
      });
      expect(
        await readSessionArtifacts(scope, { kind: "list", sessionKey: scope.sessionKey }),
      ).toMatchObject({
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
      expect(await readSessionTranscriptSummaryAsync(scope, { kind: "usage" })).toEqual({
        kind: "usage",
        usage: null,
      });
      expect(
        await readSessionArtifacts(scope, { kind: "list", sessionKey: scope.sessionKey }),
      ).toEqual({ kind: "list", artifacts: [] });
    });
  });

  it("reads sibling and cross-agent windows while absent history stays absent", async () => {
    const root = await fixture();
    const sibling = await fixture("two");
    const other = await fixture("three", "helper");
    await runWithSessionActorStorage(root.binding, async () => {
      for (const target of [sibling, other]) {
        const scope = { ...target.scope, sessionKey: undefined };
        expect(await readSessionMessageByIdAsync(scope, "answer")).toMatchObject({
          message: { content: `Answer ${target.scope.sessionId}` },
        });
        expect(await readSessionMessageCountAsync(scope)).toBe(2);
      }
      const before = root.owner.listSessions(authority).length;
      const missing = { ...root.scope, sessionKey: undefined, sessionId: "absent" };
      expect(await readSessionMessageCountAsync(missing)).toBe(0);
      expect(await readSessionMessagesAsync(missing, { mode: "full", reason: "export" })).toEqual(
        [],
      );
      expect(await readSessionMessagesMatchingIdAsync(missing, "answer")).toEqual([]);
      expect(await readSessionMessageByIdAsync(missing, "answer")).toEqual({
        found: false,
        oversized: false,
      });
      expect(
        await readSessionMessagesAroundIdWithStatsAsync(missing, {
          messageId: "answer",
          maxMessages: 1,
        }),
      ).toMatchObject({
        found: false,
        messages: [],
        totalMessages: 0,
      });
      expect(await readSessionTranscriptSummaryAsync(missing, { kind: "usage" })).toEqual({
        kind: "usage",
        usage: null,
      });
      expect(
        await readSessionArtifacts(missing, { kind: "list", sessionKey: root.scope.sessionKey }),
      ).toEqual({ kind: "list", artifacts: [] });
      expect(root.owner.listSessions(authority)).toHaveLength(before);
    });
  });

  it("hides out-of-page coordination errors and reveals output after an in-process human steer", async () => {
    const { binding, scope, append } = await fixture();
    await append(
      event("coordination-input", "answer", {
        role: "user",
        content: "Internal coordination",
        idempotencyKey: "coordination:user",
        provenance: { kind: "inter_session", sourceTool: "subagent_announce" },
      }),
    );
    await append(
      event("coordination-error", "coordination-input", {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "Internal failure",
        __openclaw: { runId: "coordination" },
      }),
    );
    await runWithSessionActorStorage(binding, async () => {
      const hidden = await readSessionMessageByIdAsync(scope, "coordination-error", {
        historyVisibility: {},
      });
      expect(hidden).toEqual({ found: false, oversized: false, historyHidden: true });
      const before = await readSessionHistorySnapshotAsync({ target: scope, limit: 1 });
      expect(messageIds(before.history.messages)).toEqual(["answer"]);
      await append(
        event("human-steer", "coordination-error", {
          role: "user",
          content: "Show me the result",
          __openclaw: { steerTargetRunId: "coordination" },
        }),
      );
      await append(
        event("visible-result", "human-steer", {
          role: "assistant",
          content: "Visible result",
          __openclaw: { runId: "coordination" },
        }),
      );
      const after = await readSessionHistorySnapshotAsync({ target: scope, limit: 1 });
      expect(messageIds(after.history.messages)).toEqual(["visible-result"]);
    });
  });

  it("preserves exact-message visibility and cancellation at the Gateway reader boundary", async () => {
    const { binding, scope } = await fixture("announce", "main", true);
    await runWithSessionActorStorage(binding, async () => {
      expect(
        await readSessionMessageByIdAsync(scope, "answer", {
          historyVisibility: { sessionStartedAt: Date.parse("2026-10-11T00:01:00.000Z") },
        }),
      ).toEqual({ found: false, oversized: false, historyHidden: true });
      const controller = new AbortController();
      controller.abort(new Error("reader cancelled"));
      await expect(
        readSessionMessagesPageWithStatsAsync(
          scope,
          { offset: 0, maxMessages: 1 },
          controller.signal,
        ),
      ).rejects.toThrow("reader cancelled");
    });
  });
});

it("reads unbound Gateway transcript state after an in-process append without creating missing owners", async () => {
  const target = await fixture();
  expect(await readSessionMessageCountAsync(target.scope)).toBe(2);
  await target.append(event("next", "answer", { role: "user", content: "Next question" }));
  expect(await readSessionMessageCountAsync(target.scope)).toBe(3);
  expect(await readSessionMessageByIdAsync(target.scope, "next")).toMatchObject({ found: true });
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
  expect(await readSessionMessageCountAsync(target.scope)).toBe(0);
  const missing = {
    ...target.scope,
    agentId: "absent",
    sessionKey: "agent:absent:dashboard:incognito-missing",
    storePath: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "absent", env }),
  };
  expect(await readSessionMessageCountAsync(missing)).toBe(0);
  expect(memorySessionActorOwners.list()).toHaveLength(1);
});
