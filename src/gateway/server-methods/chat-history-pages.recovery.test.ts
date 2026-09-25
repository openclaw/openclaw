import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installSessionToolResultGuard } from "../../agents/session-tool-result-guard.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import {
  appendTranscriptMessage,
  replaceSessionEntry,
  replaceTranscriptEvents,
} from "../../config/sessions/session-accessor.js";
import * as nestedActivity from "../../sessions/nested-tool-activity.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import * as historySanitize from "../chat-display-projection.sanitize.js";
import { resolveCurrentUserProfileDisplay } from "../current-user-profile-display.js";
import { readChatHistoryMessageId } from "../session-history-tail.js";
import * as anchorReader from "../session-transcript-readers.js";
import { readSessionMessagesAsync } from "../session-transcript-readers.js";
import { createChatHistoryActivityProjection } from "./chat-history-budget.js";
import { readChatHistoryPageKernel } from "./chat-history-page-kernel.js";

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

type PageOptions = Pick<Parameters<typeof readChatHistoryPageKernel>[0], "offset" | "messageId"> & {
  maxHistoryBytes?: number;
};

async function withTranscript(
  messages: Array<[id: string, message: Record<string, unknown>]>,
  use: (fixture: {
    append: (id: string, message: Record<string, unknown>) => Promise<unknown>;
    read: (options: PageOptions) => ReturnType<typeof readChatHistoryPageKernel>;
    raw: () => ReturnType<typeof readSessionMessagesAsync>;
  }) => Promise<void>,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:page-recovery",
      sessionId: "page-recovery",
      storePath: path.join(state.sessionsDir(), "sessions.json"),
    };
    const entry = { sessionId: scope.sessionId, updatedAt: 1 };
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
      read: (options) =>
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
            ...options,
          },
          { readers: anchorReader, resolveCurrentUserProfileDisplay },
        ),
      raw: () => readSessionMessagesAsync(scope, { mode: "full", reason: "recovery immutability" }),
    });
  });
}

describe("historical page recovery context", () => {
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
          {
            role: "toolResult",
            toolCallId: id,
            toolName: "process",
            isError: false,
            details,
            content: [{ type: "text", text: "Raw result retained" }],
          },
        ]),
      ],
      async ({ read, raw }) => {
        const original = await raw();
        for (const { id, quiet } of rows) {
          const page = await read({ messageId: id, offset: undefined });
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
      const page = await read({ offset: undefined, messageId: undefined });
      const item = page.activity?.[0]?.items[0];
      expect(item).toMatchObject({ phase: "end", summary: "Outcome unknown" });
      expect(item).not.toHaveProperty("status");
    });
  });

  it("retains nested approval outcome before sanitizing its result", async () => {
    const nested = nestedActivity.createNestedToolActivity({
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
    });
    await withTranscript(
      [
        ["user", user],
        ["nested", nested],
      ],
      async ({ read }) => {
        const page = await read({ offset: 0, messageId: undefined });
        const descriptor = createChatHistoryActivityProjection(page.messages, page.activity).get(
          page.messages[0],
        );
        expect(descriptor?.items).toMatchObject([
          { status: "blocked", approvalId: "approval", approvalSlug: "approve" },
        ]);
      },
    );
  });

  it("projects known executed waits on isolated pages without guessing requested poll arguments", async () => {
    const nested = nestedActivity.createNestedToolActivity({
      runId: "run",
      scopeId: "nested",
      afterEntryId: "requested",
      startOrder: 0,
      parentToolCallId: "outer",
      toolCallId: "nested-poll",
      toolName: "process",
      input: { action: "poll", sessionId: "process-1" },
      result: { content: [{ type: "text", text: "still running" }] },
      isError: false,
      startedAt: 10,
      timestamp: 11,
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
          {
            role: "toolResult",
            toolName: "process",
            toolCallId: "requested-poll",
            isError: false,
            content: "executed action unavailable",
          },
        ],
        ["nested", nested],
        [
          "native",
          {
            role: "toolResult",
            toolName: "collab.wait",
            toolCallId: "native-wait",
            isError: false,
            content: "finished waiting",
          },
        ],
      ],
      async ({ read, raw }) => {
        const original = await raw();
        for (const [offset, id, quiet] of [
          [0, "native", true],
          [1, "nested", true],
          [2, "unknown-execution", false],
        ] as const) {
          const page = await read({ offset, messageId: undefined });
          const activity = [
            ...createChatHistoryActivityProjection(page.messages, page.activity).values(),
          ];
          expect(page.messages.map(readChatHistoryMessageId)).toEqual([id]);
          expect(activity).toHaveLength(1);
          expect(activity[0]?.messageId).toBe(id);
          if (quiet) {
            expect(activity).toEqual([{ messageId: id, items: [] }]);
          } else {
            expect(activity[0]?.items).toMatchObject([{ name: "process", status: "completed" }]);
          }
        }
        expect(await raw()).toEqual(original);
      },
    );
  });
  it.each([
    { offset: 1, messageId: undefined, expectedIds: ["user"] },
    { offset: undefined, messageId: "failed", expectedIds: [] },
  ])(
    "omits a recovered failure outside the newer page (offset=$offset, anchor=$messageId)",
    async ({ expectedIds, ...options }) => {
      await withTranscript(
        [
          ["user", user],
          ["failed", failed],
          ["answer", answer],
        ],
        async ({ read, raw }) => {
          const original = await raw();
          const page = await read(options);

          expect(page.messages.map(readChatHistoryMessageId)).toEqual(expectedIds);
          if (options.offset !== undefined) {
            expect(page.pagination).toEqual({ offset: 1, totalMessages: 3, rawPageMessages: 2 });
          }
          expect(await raw()).toEqual(original);
        },
      );
    },
  );

  it("does not use a later turn to hide an unrecovered historical failure", async () => {
    await withTranscript(
      [
        ["user", user],
        ["failed", failed],
        ["next-user", user],
        ["answer", answer],
      ],
      async ({ read }) => {
        const page = await read({ offset: 2, messageId: undefined });
        expect(page.messages).toEqual([
          expect.objectContaining({
            stopReason: "error",
            __openclaw: expect.objectContaining({ id: "failed" }),
          }),
        ]);
      },
    );
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

        const page = await read({ offset: 1, messageId: undefined });

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
            ...(mode === "offset"
              ? { offset: progress.length + 1, messageId: undefined }
              : { offset: undefined, messageId: "failed" }),
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
            expect(Object.keys(page)).toEqual(["messages"]);
          }
          expect(await raw()).toEqual(original);
          expect(renderedMessages).toBeLessThanOrEqual(original.length * 5);
          expect(decodedMessages).toBeLessThanOrEqual(original.length * 8);
        },
      );
    },
  );

  it("keeps the failure when newer recovery evidence exceeds the read byte budget", async () => {
    await withTranscript(
      [
        ["user", user],
        ["failed", failed],
        ["answer", answer],
      ],
      async ({ read }) => {
        const page = await read({ offset: 1, messageId: undefined, maxHistoryBytes: 1 });
        expect(page.messages.map(readChatHistoryMessageId)).toEqual(["failed"]);
      },
    );
  });

  it.each([
    { offset: 1, messageId: undefined, expectedReads: 0 },
    { offset: undefined, messageId: "answer", expectedReads: 1 },
  ])(
    "does not read recovery context for an ordinary page (offset=$offset, anchor=$messageId)",
    async ({ expectedReads, ...options }) => {
      await withTranscript(
        [
          ["user", user],
          ["answer", answer],
          ["next-user", user],
        ],
        async ({ read }) => {
          const reads = vi.spyOn(anchorReader, "readSessionMessagesAroundIdWithStatsAsync");
          const page = await read(options);
          expect(page.messages.map(readChatHistoryMessageId)).toEqual(["answer"]);
          expect(reads).toHaveBeenCalledTimes(expectedReads);
        },
      );
    },
  );
});
