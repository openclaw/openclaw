import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installSessionToolResultGuard } from "../../agents/session-tool-result-guard.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { captureRuntimeConfigAsyncReader } from "../../config/config.js";
import {
  appendTranscriptMessage,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { replaceTranscriptEvents } from "../../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import * as nestedActivity from "../../sessions/nested-tool-activity.js";
import { recordGatewaySessionRunFailure } from "../../sessions/session-run-error.js";
import { readRunFailureNotice } from "../../shared/run-failure-notice.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import * as historySanitize from "../chat-display-projection.sanitize.js";
import { createChatHistoryActivityProjection } from "../chat-history-budget.js";
import { readChatHistoryPageKernel } from "../chat-history-page-kernel.js";
import { resolveCurrentUserProfileDisplay } from "../current-user-profile-display.js";
import { readChatHistoryMessageId } from "../session-history-tail.js";
import * as anchorReader from "../session-transcript-readers.js";
import { readSessionMessagesAsync } from "../session-transcript-readers.js";

afterEach(() => vi.restoreAllMocks());

const user = { role: "user", content: "Question" };
const failed = {
  role: "assistant",
  content: [],
  stopReason: "error",
  errorMessage: "The selected model is unavailable.",
  __openclaw: { runId: "recovered-run" },
};
const answer = {
  role: "assistant",
  content: [{ type: "text", text: "Recovered answer" }],
  stopReason: "stop",
  __openclaw: { runId: "recovered-run" },
};
const toolResult = (toolCallId: string, toolName: string, content: unknown, details?: unknown) => ({
  role: "toolResult",
  toolCallId,
  toolName,
  isError: false,
  content,
  ...(details === undefined ? {} : { details }),
});
const nested = (
  overrides: Partial<Parameters<typeof nestedActivity.createNestedToolActivity>[0]>,
) =>
  nestedActivity.createNestedToolActivity({
    runId: "run",
    scopeId: "nested",
    afterEntryId: "user",
    startOrder: 0,
    toolCallId: "exec",
    toolName: "exec",
    input: { command: "private command" },
    result: {
      content: [{ type: "text", text: "Approval needed" }],
      details: { status: "approval-pending", approvalId: "approval", approvalSlug: "approve" },
    },
    isError: false,
    startedAt: 10,
    timestamp: 11,
    ...overrides,
  });

type PageOptions = Partial<
  Pick<Parameters<typeof readChatHistoryPageKernel>[0], "offset" | "messageId">
> & {
  max?: number;
  maxHistoryBytes?: number;
};

async function withTranscript(
  messages: Array<[id: string, message: Record<string, unknown>]>,
  use: (fixture: {
    append: (id: string, message: Record<string, unknown>) => Promise<unknown>;
    read: (options?: PageOptions) => ReturnType<typeof readChatHistoryPageKernel>;
    raw: () => ReturnType<typeof readSessionMessagesAsync>;
    fail: (runId: string) => Promise<void>;
  }) => Promise<void>,
  entryOptions: Pick<InternalSessionEntry, "sessionStartedAt" | "lifecycleRunId"> = {},
) {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    await captureRuntimeConfigAsyncReader()();
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:page-recovery",
      sessionId: "page-recovery",
      storePath: path.join(state.sessionsDir(), "sessions.json"),
    };
    const entry: InternalSessionEntry = {
      sessionId: scope.sessionId,
      updatedAt: 1,
      ...entryOptions,
    };
    await replaceSessionEntry(scope, entry);
    await replaceTranscriptEvents(scope, [
      { type: "session", version: 3, id: scope.sessionId },
      ...messages.map(([id, message], index) => ({
        type: "message",
        id,
        parentId: messages[index - 1]?.[0] ?? null,
        message,
      })),
    ]);
    await use({
      append: (id, message) => appendTranscriptMessage(scope, { eventId: id, message }),
      read: (options = {}) =>
        readChatHistoryPageKernel(
          {
            entry,
            provider: "openai",
            sessionId: scope.sessionId,
            storePath: scope.storePath,
            sessionAgentId: scope.agentId,
            canonicalKey: scope.sessionKey,
            max: 1,
            maxHistoryBytes: 100_000,
            effectiveMaxChars: 10_000,
            ignoreCliSessionImports: true,
            offset: undefined,
            messageId: undefined,
            ...options,
          },
          { readers: anchorReader, resolveCurrentUserProfileDisplay },
        ),
      raw: () => readSessionMessagesAsync(scope, { mode: "full", reason: "recovery immutability" }),
      fail: async (runId) => {
        entry.lifecycleRunId = undefined;
        entry.lastRunId = runId;
        entry.status = "failed";
        await replaceSessionEntry(scope, entry);
        await recordGatewaySessionRunFailure({
          target: scope,
          runId,
          error: "All model attempts failed",
        });
      },
    });
  });
}

describe("historical page recovery context", () => {
  it("hides active attempt diagnostics on reload and publishes one persisted final notice", async () => {
    const partial = { ...failed, content: [{ type: "text", text: "Useful partial output" }] };
    await withTranscript(
      [
        ["user", user],
        ["partial", partial],
        ["attempt", failed],
      ],
      async ({ read, raw, fail }) => {
        const before = await raw();
        const active = await read({ max: 20, offset: 0 });
        expect(active.messages.map(readChatHistoryMessageId)).toEqual(["user", "partial"]);
        expect(active.messages.some(readRunFailureNotice)).toBe(false);
        expect(active.messages[1]).toMatchObject({ content: partial.content });
        expect(active.messages[1]).not.toHaveProperty("stopReason");
        await fail("recovered-run");
        await fail("recovered-run");
        const settled = await read({ max: 20, offset: 0 });
        expect(settled.messages.map(readRunFailureNotice).filter(Boolean)).toEqual([
          {
            runId: "recovered-run",
            summary: "Your request couldn't be completed: All model attempts failed",
          },
        ]);
        expect(settled.messages[1]).toMatchObject({ content: partial.content });
        const older = await read({ max: 2, offset: 1 });
        expect(older.messages.some(readRunFailureNotice)).toBe(false);
        expect(older.messages).toContainEqual(
          expect.objectContaining({ content: partial.content }),
        );
        const after = await raw();
        expect(after.slice(0, before.length)).toEqual(before);
        expect(after).toHaveLength(before.length + 1);
      },
      { lifecycleRunId: "recovered-run" },
    );
  });

  it("includes bounded off-page originals once for repeated reply references", async () => {
    const originalText = "q".repeat(600);
    await withTranscript(
      [
        [
          "original",
          {
            role: "assistant",
            content: originalText,
            provider: "example",
            model: "historical",
          },
        ],
        ["reply-one", { ...user, __openclaw: { replyToId: "original" } }],
        [
          "reply-two",
          {
            role: "assistant",
            content: "Second reply",
            openclawDelivery: { replyToId: "original" },
          },
        ],
      ],
      async ({ read, raw }) => {
        const persisted = await raw();
        const exactReads = vi.spyOn(anchorReader, "readSessionMessageByIdAsync");
        const sourceReads = vi.spyOn(anchorReader, "readSessionMessagesWithSourceAsync");
        const page = await read({ max: 2, offset: 0 });

        expect(page.messages.map(readChatHistoryMessageId)).toEqual(["reply-one", "reply-two"]);
        for (const message of page.messages) {
          expect(message).toHaveProperty("__openclaw.replyToMessage", {
            ok: true,
            message: expect.objectContaining({
              role: "assistant",
              // The quoted original shares its 500-char preview budget with a tail
              // slice so its terminal facts stay visible (Precedent: #186382).
              content: `${"q".repeat(286)}\n...(truncated)...\n${"q".repeat(150)}`,
              __openclaw: expect.objectContaining({ id: "original", truncated: true }),
            }),
          });
          expect(message).not.toHaveProperty("__openclaw.replyToMessage.message.provider");
          expect(message).not.toHaveProperty("__openclaw.replyToMessage.message.model");
        }
        expect(exactReads).toHaveBeenCalledTimes(1);
        expect(sourceReads).not.toHaveBeenCalled();
        expect(await raw()).toEqual(persisted);
      },
    );
  });

  it("carries unavailable reply previews without exposing hidden or oversized originals", async () => {
    const sessionStartedAt = 10_000;
    const references = [
      ["missing", "not_found"],
      ["announce", "not_found"],
      ["announce-reply", "not_found"],
      ["pending:missing", "not_found"],
      ["oversized", "oversized"],
    ] as const;
    await withTranscript(
      [
        [
          "announce",
          {
            role: "user",
            content: "Old announce",
            timestamp: sessionStartedAt - 2_000,
            provenance: { kind: "inter_session", sourceTool: "subagent_announce" },
          },
        ],
        [
          "announce-reply",
          { role: "assistant", content: "Old paired reply", timestamp: sessionStartedAt - 1_000 },
        ],
        ["oversized", { ...user, attachmentMetadata: { description: "x".repeat(9_000) } }],
        ["pending:missing", { ...user, content: "Transcript row is not pending custody" }],
        ...references.map(([target]): [string, Record<string, unknown>] => [
          `reply-${target}`,
          {
            ...user,
            timestamp: sessionStartedAt + 1,
            __openclaw: { replyToId: target },
          },
        ]),
      ],
      async ({ read }) => {
        const sourceReads = vi.spyOn(anchorReader, "readSessionMessagesWithSourceAsync");
        const page = await read({ max: references.length, offset: 0 });

        expect(page.messages.map(readChatHistoryMessageId)).toEqual(
          references.map(([target]) => `reply-${target}`),
        );
        for (const [index, [, unavailableReason]] of references.entries()) {
          expect(page.messages[index]).toHaveProperty("__openclaw.replyToMessage", {
            ok: false,
            unavailableReason,
          });
        }
        expect(sourceReads).not.toHaveBeenCalled();
      },
      { sessionStartedAt },
    );
  });

  it("classifies isolated poll results before display sanitation", async () => {
    const poll = {
      status: "completed",
      sessionId: "job",
      aggregated: "private output",
      exitCode: 0,
    };
    const rows = [
      { id: "poll", details: poll, quiet: true },
      { id: "kill", details: { status: "completed" }, quiet: false },
      {
        id: "log",
        details: {
          status: "completed",
          sessionId: "job",
          output: "output",
          totalLines: 1,
          total: 1,
          totalChars: 6,
          truncated: false,
        },
        quiet: false,
      },
      {
        id: "failed-poll",
        details: { ...poll, status: "failed", exitCode: 2 },
        quiet: false,
      },
      {
        id: "large-poll",
        details: {
          status: "running",
          sessionId: "job",
          persistedDetailsTruncated: true,
          originalDetailKeys: ["status", "sessionId", "aggregated"],
        },
        quiet: true,
      },
    ];
    await withTranscript(
      [
        ["user", user],
        ...rows.map(({ id, details }): [string, Record<string, unknown>] => [
          id,
          toolResult(id, "process", [{ type: "text", text: "Raw result retained" }], details),
        ]),
      ],
      async ({ read, raw }) => {
        const original = await raw();
        for (const { id, quiet } of rows) {
          const page = await read({ messageId: id });
          const descriptor = createChatHistoryActivityProjection(page.messages, page.activity).get(
            page.messages[0],
          );
          expect(descriptor?.messageId).toBe(id);
          expect(descriptor?.items.length === 0).toBe(quiet);
          expect(page.messages[0]).not.toHaveProperty("details.aggregated");
          expect(page.messages[0]).toMatchObject({ content: [{ text: "Raw result retained" }] });
        }
        expect(await raw()).toEqual(original);
      },
    );
  });

  it("keeps a capped nonzero result neutral when its stop reason was not retained", async () => {
    const session = SessionManager.inMemory();
    installSessionToolResultGuard(session);
    session.appendMessage({
      role: "toolResult",
      toolCallId: "stopped",
      toolName: "process",
      isError: false,
      timestamp: 1,
      content: [{ type: "text", text: "Stopped process" }],
      details: {
        status: "completed",
        sessionId: "job",
        exitCode: 143,
        exitReason: "manual-cancel",
        aggregated: "x".repeat(20_000),
      },
    });
    const result = session.getEntries().find((entry) => entry.type === "message");
    if (result?.type !== "message") {
      throw new Error("Expected persisted result");
    }
    expect(result.message).toMatchObject({
      details: {
        persistedDetailsTruncated: true,
        originalDetailKeys: expect.arrayContaining(["exitReason"]),
      },
    });
    expect(result.message).not.toHaveProperty("details.exitReason");
    await withTranscript([["stopped", { ...result.message }]], async ({ read }) => {
      const page = await read();
      const item = page.activity?.[0]?.items[0];
      expect(item).toMatchObject({ phase: "end", summary: "Outcome unknown" });
      expect(item).not.toHaveProperty("status");
    });
  });

  it("projects isolated waits and approvals from executed outcomes before sanitation", async () => {
    const poll = nested({
      afterEntryId: "requested",
      parentToolCallId: "outer",
      toolCallId: "nested-poll",
      toolName: "process",
      input: { action: "poll", sessionId: "process-1" },
      result: { content: [{ type: "text", text: "still running" }] },
    });
    await withTranscript(
      [
        ["user", user],
        [
          "requested",
          {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "requested-poll",
                name: "process",
                arguments: { action: "poll" },
              },
            ],
          },
        ],
        [
          "unknown-execution",
          toolResult("requested-poll", "process", "executed action unavailable"),
        ],
        ["approval", nested({})],
        ["nested", poll],
        ["native", toolResult("native-wait", "collab.wait", "finished waiting")],
      ],
      async ({ read, raw }) => {
        const original = await raw();
        for (const [offset, id, quiet] of [
          [0, "native", true],
          [1, "nested", true],
          [2, "approval", false],
          [3, "unknown-execution", false],
        ] as const) {
          const page = await read({ offset });
          const activity = [
            ...createChatHistoryActivityProjection(page.messages, page.activity).values(),
          ];
          expect(page.messages.map(readChatHistoryMessageId)).toEqual([id]);
          expect(activity).toHaveLength(1);
          expect(activity[0]?.messageId).toBe(id);
          if (quiet) {
            expect(activity).toEqual([{ messageId: id, items: [] }]);
          } else if (id === "approval") {
            expect(activity[0]?.items).toMatchObject([
              { status: "blocked", approvalId: "approval", approvalSlug: "approve" },
            ]);
          } else {
            expect(activity[0]?.items).toMatchObject([{ name: "process", status: "completed" }]);
          }
        }
        expect(await raw()).toEqual(original);
      },
    );
  });

  it("recovers a failed page across a hidden runtime continuation without rewriting history", async () => {
    await withTranscript(
      [
        ["user", user],
        ["failed", failed],
        [
          "continuation",
          {
            role: "user",
            content: "Continue from the current transcript.",
            display: false,
            provenance: { kind: "internal_system" },
          },
        ],
        ["answer", answer],
      ],
      async ({ read, raw }) => {
        const original = await raw();
        const page = await read({ messageId: "failed" });
        expect(page.messages.map(readChatHistoryMessageId)).toEqual([]);
        expect(await raw()).toEqual(original);
      },
    );
  });

  it.each([
    { reason: "later turn", offset: 2, messageId: undefined },
    { reason: "byte budget", offset: 1, messageId: undefined },
    { reason: "ordinary offset", offset: 1, messageId: undefined },
    { reason: "ordinary anchor", offset: undefined, messageId: "answer" },
  ])("selects recovery context for $reason", async ({ reason, offset, messageId }) => {
    const ordinary = reason.startsWith("ordinary");
    const messages: Array<[string, Record<string, unknown>]> = [["user", user]];
    if (!ordinary) {
      messages.push(["failed", failed]);
    }
    if (reason === "later turn") {
      messages.push(["next-user", user]);
    }
    messages.push(["answer", answer]);
    if (ordinary) {
      messages.push(["next-user", user]);
    }
    await withTranscript(messages, async ({ read }) => {
      const reads = vi.spyOn(anchorReader, "readSessionMessagesAroundIdWithStatsAsync");
      const page = await read({
        offset,
        messageId,
        ...(reason === "byte budget" ? { maxHistoryBytes: 1 } : {}),
      });
      expect(page.messages.map(readChatHistoryMessageId)).toEqual(ordinary ? ["answer"] : ["user"]);
      if (ordinary) {
        expect(reads).toHaveBeenCalledTimes(messageId ? 1 : 0);
      }
    });
  });

  it("keeps original page boundaries when messages append during recovery lookahead", async () => {
    await withTranscript(
      [
        ["user", user],
        ["failed", failed],
        ["answer", answer],
      ],
      async ({ append, read }) => {
        const readAround = anchorReader.readSessionMessagesAroundIdWithStatsAsync;
        vi.spyOn(anchorReader, "readSessionMessagesAroundIdWithStatsAsync").mockImplementationOnce(
          async (scope, options) => {
            await append("next-user", user);
            await append("next-answer", { ...answer, __openclaw: { runId: "next-run" } });
            return readAround(scope, options);
          },
        );

        const page = await read({ offset: 1 });

        expect(page.messages.map(readChatHistoryMessageId)).toEqual(["user"]);
        expect(page.pagination).toEqual({ offset: 1, totalMessages: 3, rawPageMessages: 2 });
      },
    );
  });

  it.each(["offset", "anchor"] as const)(
    "finds recovery across multiple newer pages without repeatedly rendering them (%s)",
    async (mode) => {
      const progress: Array<[string, Record<string, unknown>]> = Array.from(
        { length: 1000 },
        (_, index) => [
          `progress-${index}`,
          { role: "toolResult", content: "Still working", toolCallId: `tool-${index}` },
        ],
      );
      await withTranscript(
        [["user", user], ["failed", failed], ...progress, ["answer", answer]],
        async ({ read, raw }) => {
          const original = await raw();
          const sanitize = historySanitize.sanitizeChatHistoryMessages;
          let renderedMessages = 0;
          let decodedMessages = 0;
          const readActivity = nestedActivity.readNestedToolActivity;
          const activityReads = vi
            .spyOn(nestedActivity, "readNestedToolActivity")
            .mockImplementation((message) => {
              decodedMessages++;
              return readActivity(message);
            });
          vi.spyOn(historySanitize, "sanitizeChatHistoryMessages").mockImplementation((...args) => {
            renderedMessages += args[0].length;
            return sanitize(...args);
          });
          const page = await read({
            ...(mode === "offset" ? { offset: progress.length + 1 } : { messageId: "failed" }),
            maxHistoryBytes: 8 * 1024 * 1024,
          });

          activityReads.mockRestore();
          expect(page.messages.map(readChatHistoryMessageId)).toEqual(
            mode === "offset" ? ["user"] : [],
          );
          if (mode === "offset") {
            expect(page.pagination).toEqual({
              offset: progress.length + 1,
              totalMessages: progress.length + 3,
              rawPageMessages: 2,
            });
          } else {
            expect(page.pagination).toBeUndefined();
            expect(page.anchor).toMatchObject({
              oldestMessageId: "failed",
              newestMessageId: "failed",
              hasOlder: true,
              hasNewer: true,
            });
          }
          expect(await raw()).toEqual(original);
          expect(renderedMessages).toBeLessThanOrEqual(original.length * 5);
          expect(decodedMessages).toBeLessThanOrEqual(original.length * 8);
        },
      );
    },
  );
});
