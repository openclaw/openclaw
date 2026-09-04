import { describe, expect, it } from "vitest";
import { mergeImportedChatHistoryMessages } from "./cli-session-history.test-support.js";

describe("cli session history covered aggregates", () => {
  it.each([
    ["top-level idempotencyKey", { idempotencyKey: "cli-assistant:run-1" }],
    ["nested transcript metadata", { __openclaw: { idempotencyKey: "cli-assistant:run-1" } }],
  ])(
    "drops a local cli-assistant aggregate covered by imported assistant segments (%s)",
    (_label, keyFields) => {
      const timestamp = Date.parse("2026-03-26T16:29:55.700Z");
      const interim = "Thinking about the request";
      const finalSegment = "Here is the finished answer.";
      const localAggregate = {
        role: "assistant",
        content: [{ type: "text", text: `${interim}\n${finalSegment}` }],
        timestamp,
        ...keyFields,
      };
      const importedInterim = {
        role: "assistant",
        content: [{ type: "text", text: interim }],
        timestamp,
        __openclaw: {
          importedFrom: "claude-cli",
          externalId: "assistant-interim",
          cliSessionId: "session-1",
        },
      };
      const importedFinal = {
        role: "assistant",
        content: [{ type: "text", text: finalSegment }],
        timestamp: timestamp + 1,
        __openclaw: {
          importedFrom: "claude-cli",
          externalId: "assistant-final",
          cliSessionId: "session-1",
        },
      };

      const localUser = { role: "user", content: "question", timestamp: timestamp - 1 };
      const importedUser = {
        role: "user",
        content: "question",
        timestamp: timestamp - 1,
        __openclaw: { importedFrom: "claude-cli", externalId: "user-1", cliSessionId: "session-1" },
      };

      const merged = mergeImportedChatHistoryMessages({
        localMessages: [localUser, localAggregate],
        importedMessages: [importedUser, importedInterim, importedFinal],
      });

      expect(merged).toEqual([importedUser, importedInterim, importedFinal]);
    },
  );

  it("drops a local cli-assistant aggregate covered by uuid-less imported segments", () => {
    const timestamp = Date.parse("2026-03-26T16:29:55.700Z");
    const interim = "Thinking about the request";
    const finalSegment = "Here is the finished answer.";
    const localAggregate = {
      role: "assistant",
      content: [{ type: "text", text: `${interim}\n${finalSegment}` }],
      timestamp,
      idempotencyKey: "cli-assistant:run-1",
    };
    // Records without a uuid keep the importer's line-based id and no externalId.
    const uuidless = (line: number) => ({
      id: `claude-cli:session-1:line:${line}`,
      importedFrom: "claude-cli",
      cliSessionId: "session-1",
    });
    const importedInterim = {
      role: "assistant",
      content: [{ type: "text", text: interim }],
      timestamp,
      __openclaw: uuidless(2),
    };
    const importedFinal = {
      role: "assistant",
      content: [{ type: "text", text: finalSegment }],
      timestamp: timestamp + 1,
      __openclaw: uuidless(3),
    };

    const localUser = { role: "user", content: "question", timestamp: timestamp - 1 };
    const importedUser = {
      role: "user",
      content: "question",
      timestamp: timestamp - 1,
      __openclaw: uuidless(1),
    };

    const merged = mergeImportedChatHistoryMessages({
      localMessages: [localUser, localAggregate],
      importedMessages: [importedUser, importedInterim, importedFinal],
    });

    expect(merged).toEqual([
      {
        ...localUser,
        __openclaw: {
          importedFrom: "claude-cli",
          cliSessionId: "session-1",
        },
      },
      importedInterim,
      importedFinal,
    ]);
  });

  it("keeps a local cli-assistant aggregate when only the final imported segment matches", () => {
    const timestamp = Date.parse("2026-03-26T16:29:55.700Z");
    const interim = "Thinking about the request";
    const finalSegment = "Here is the finished answer.";
    const localAggregate = {
      role: "assistant",
      content: [{ type: "text", text: `${interim}\n${finalSegment}` }],
      timestamp,
      idempotencyKey: "cli-assistant:run-1",
    };
    const importedFinal = {
      role: "assistant",
      content: [{ type: "text", text: finalSegment }],
      timestamp: timestamp + 1,
      __openclaw: {
        importedFrom: "claude-cli",
        externalId: "assistant-final",
        cliSessionId: "session-1",
      },
    };

    const merged = mergeImportedChatHistoryMessages({
      localMessages: [localAggregate],
      importedMessages: [importedFinal],
    });

    expect(merged).toEqual([localAggregate, importedFinal]);
  });

  it("keeps a local cli-assistant aggregate that imported segments do not cover", () => {
    const timestamp = Date.parse("2026-03-26T16:29:55.700Z");
    const localAggregate = {
      role: "assistant",
      content: [{ type: "text", text: "Older turn that the truncated CLI session no longer has." }],
      timestamp,
      idempotencyKey: "cli-assistant:run-old",
    };
    const importedFinal = {
      role: "assistant",
      content: [{ type: "text", text: "Here is a later imported answer." }],
      timestamp: timestamp + 60_000,
      __openclaw: {
        importedFrom: "claude-cli",
        externalId: "assistant-later",
        cliSessionId: "session-1",
      },
    };

    const merged = mergeImportedChatHistoryMessages({
      localMessages: [localAggregate],
      importedMessages: [importedFinal],
    });

    expect(merged).toEqual([localAggregate, importedFinal]);
  });

  it("keeps an older cli-assistant aggregate when a later turn repeats its segments", () => {
    const firstTurn = Date.parse("2026-03-26T16:29:55.700Z");
    const laterTurn = firstTurn + 10 * 60_000;
    const interim = "Thinking about the request";
    const finalSegment = "Here is the finished answer.";
    const localUser = { role: "user", content: "first question", timestamp: firstTurn };
    const localAggregate = {
      role: "assistant",
      content: [{ type: "text", text: `${interim}\n${finalSegment}` }],
      timestamp: firstTurn + 3,
      idempotencyKey: "cli-assistant:run-old",
    };
    const importedLaterUser = {
      role: "user",
      content: "second question",
      timestamp: laterTurn,
      __openclaw: { importedFrom: "claude-cli", externalId: "user-later", cliSessionId: "s" },
    };
    const importedLaterInterim = {
      role: "assistant",
      content: [{ type: "text", text: interim }],
      timestamp: laterTurn + 1,
      __openclaw: { importedFrom: "claude-cli", externalId: "later-interim", cliSessionId: "s" },
    };
    const importedLaterFinal = {
      role: "assistant",
      content: [{ type: "text", text: finalSegment }],
      timestamp: laterTurn + 2,
      __openclaw: { importedFrom: "claude-cli", externalId: "later-final", cliSessionId: "s" },
    };

    const merged = mergeImportedChatHistoryMessages({
      localMessages: [localUser, localAggregate],
      importedMessages: [importedLaterUser, importedLaterInterim, importedLaterFinal],
    });

    expect(merged).toEqual([
      localUser,
      localAggregate,
      importedLaterUser,
      importedLaterInterim,
      importedLaterFinal,
    ]);
  });

  it("drops each cli-assistant aggregate only with its own turn's equal-text segments", () => {
    const interim = "Thinking about the request";
    const finalSegment = "Here is the finished answer.";
    const buildTurn = (turn: number, startedAt: number, question: string) => {
      const meta = (externalId: string) => ({
        __openclaw: { importedFrom: "claude-cli", externalId, cliSessionId: "s" },
      });
      return {
        localUser: { role: "user", content: question, timestamp: startedAt },
        localAggregate: {
          role: "assistant",
          content: [{ type: "text", text: `${interim}\n${finalSegment}` }],
          timestamp: startedAt + 3,
          idempotencyKey: `cli-assistant:run-${turn}`,
        },
        importedUser: {
          role: "user",
          content: question,
          timestamp: startedAt,
          ...meta(`user-${turn}`),
        },
        importedInterim: {
          role: "assistant",
          content: [{ type: "text", text: interim }],
          timestamp: startedAt + 1,
          ...meta(`interim-${turn}`),
        },
        importedFinal: {
          role: "assistant",
          content: [{ type: "text", text: finalSegment }],
          timestamp: startedAt + 2,
          ...meta(`final-${turn}`),
        },
      };
    };
    const firstTurn = Date.parse("2026-03-26T16:29:55.700Z");
    const first = buildTurn(1, firstTurn, "first question");
    const second = buildTurn(2, firstTurn + 10 * 60_000, "second question");

    const merged = mergeImportedChatHistoryMessages({
      localMessages: [
        first.localUser,
        first.localAggregate,
        second.localUser,
        second.localAggregate,
      ],
      importedMessages: [
        first.importedUser,
        first.importedInterim,
        first.importedFinal,
        second.importedUser,
        second.importedInterim,
        second.importedFinal,
      ],
    });

    expect(merged).toEqual([
      first.importedUser,
      first.importedInterim,
      first.importedFinal,
      second.importedUser,
      second.importedInterim,
      second.importedFinal,
    ]);
  });

  it("consumes imported segments for one cli-assistant aggregate at most", () => {
    const timestamp = Date.parse("2026-03-26T16:29:55.700Z");
    const interim = "Thinking about the request";
    const finalSegment = "Here is the finished answer.";
    const buildAggregate = (runId: string, at: number) => ({
      role: "assistant",
      content: [{ type: "text", text: `${interim}\n${finalSegment}` }],
      timestamp: at,
      idempotencyKey: `cli-assistant:${runId}`,
    });
    const firstAggregate = buildAggregate("run-1", timestamp + 3);
    const retriedAggregate = buildAggregate("run-2", timestamp + 4);
    const importedInterim = {
      role: "assistant",
      content: [{ type: "text", text: interim }],
      timestamp: timestamp + 1,
      __openclaw: { importedFrom: "claude-cli", externalId: "interim", cliSessionId: "s" },
    };
    const importedFinal = {
      role: "assistant",
      content: [{ type: "text", text: finalSegment }],
      timestamp: timestamp + 2,
      __openclaw: { importedFrom: "claude-cli", externalId: "final", cliSessionId: "s" },
    };

    const localUser = { role: "user", content: "question", timestamp: timestamp - 1 };
    const importedUser = {
      role: "user",
      content: "question",
      timestamp: timestamp - 1,
      __openclaw: { importedFrom: "claude-cli", externalId: "user", cliSessionId: "s" },
    };

    const merged = mergeImportedChatHistoryMessages({
      localMessages: [localUser, firstAggregate, retriedAggregate],
      importedMessages: [importedUser, importedInterim, importedFinal],
    });

    expect(merged).toEqual([importedUser, importedInterim, importedFinal, retriedAggregate]);
  });

  it("maps untimestamped imported segments to their own turn, not the last local one", () => {
    const interim = "Thinking about the request";
    const finalSegment = "Here is the finished answer.";
    const meta = (externalId: string) => ({
      __openclaw: { importedFrom: "claude-cli", externalId, cliSessionId: "s" },
    });
    const firstUser = { role: "user", content: "first question" };
    const firstAggregate = {
      role: "assistant",
      content: [{ type: "text", text: `${interim}\n${finalSegment}` }],
      idempotencyKey: "cli-assistant:run-1",
    };
    const secondUser = { role: "user", content: "second question" };
    const secondAggregate = {
      role: "assistant",
      content: [{ type: "text", text: `${interim}\n${finalSegment}` }],
      idempotencyKey: "cli-assistant:run-2",
    };
    const importedFirstUser = { role: "user", content: "first question", ...meta("u-1") };
    const importedInterim = {
      role: "assistant",
      content: [{ type: "text", text: interim }],
      ...meta("a-1-interim"),
    };
    const importedFinal = {
      role: "assistant",
      content: [{ type: "text", text: finalSegment }],
      ...meta("a-1-final"),
    };
    const importedSecondUser = { role: "user", content: "second question", ...meta("u-2") };

    const merged = mergeImportedChatHistoryMessages({
      localMessages: [firstUser, firstAggregate, secondUser, secondAggregate],
      importedMessages: [importedFirstUser, importedInterim, importedFinal, importedSecondUser],
    });

    // Only run-1 is covered; the equal-text run-2 belongs to a turn nothing was imported for.
    expect(merged).toEqual([
      importedFirstUser,
      importedSecondUser,
      secondAggregate,
      importedInterim,
      importedFinal,
    ]);
  });

  it("keeps both aggregates when a repeated prompt cannot be aligned", () => {
    const interim = "Working on it";
    const finalSegment = "All done.";
    const meta = (externalId: string) => ({
      __openclaw: { importedFrom: "claude-cli", externalId, cliSessionId: "s" },
    });
    const question = { role: "user", content: "same question" };
    const aggregate = (runId: string) => ({
      role: "assistant",
      content: [{ type: "text", text: `${interim}\n${finalSegment}` }],
      idempotencyKey: `cli-assistant:${runId}`,
    });
    // The import starts at the second occurrence, and nothing carries a
    // timestamp, so neither local turn can be proven to own these segments.
    const merged = mergeImportedChatHistoryMessages({
      localMessages: [question, aggregate("run-1"), question, aggregate("run-2")],
      importedMessages: [
        { role: "user", content: "same question", ...meta("u-2") },
        { role: "assistant", content: [{ type: "text", text: interim }], ...meta("a-interim") },
        {
          role: "assistant",
          content: [{ type: "text", text: finalSegment }],
          ...meta("a-final"),
        },
      ],
    });

    const keys = merged.map((message) => {
      if (typeof message !== "object" || message === null || !("idempotencyKey" in message)) {
        return undefined;
      }
      return message.idempotencyKey;
    });
    expect(keys).toContain("cli-assistant:run-1");
    expect(keys).toContain("cli-assistant:run-2");
  });

  it("drops every covered cli-assistant aggregate across untimestamped turns", () => {
    const meta = (externalId: string) => ({
      __openclaw: { importedFrom: "claude-cli", externalId, cliSessionId: "s" },
    });
    const buildTurn = (turn: number, question: string, interim: string, finalSegment: string) => ({
      localUser: { role: "user", content: question },
      localAggregate: {
        role: "assistant",
        content: [{ type: "text", text: `${interim}\n${finalSegment}` }],
        idempotencyKey: `cli-assistant:run-${turn}`,
      },
      importedUser: { role: "user", content: question, ...meta(`u-${turn}`) },
      importedInterim: {
        role: "assistant",
        content: [{ type: "text", text: interim }],
        ...meta(`interim-${turn}`),
      },
      importedFinal: {
        role: "assistant",
        content: [{ type: "text", text: finalSegment }],
        ...meta(`final-${turn}`),
      },
    });
    const first = buildTurn(1, "first question", "Checking the notes.", "Three steps.");
    const second = buildTurn(2, "second question", "Nothing else to add.", "Ping me anytime.");

    const merged = mergeImportedChatHistoryMessages({
      localMessages: [
        first.localUser,
        first.localAggregate,
        second.localUser,
        second.localAggregate,
      ],
      importedMessages: [
        first.importedUser,
        first.importedInterim,
        first.importedFinal,
        second.importedUser,
        second.importedInterim,
        second.importedFinal,
      ],
    });

    expect(merged).toEqual([
      first.importedUser,
      second.importedUser,
      first.importedInterim,
      first.importedFinal,
      second.importedInterim,
      second.importedFinal,
    ]);
  });
});
