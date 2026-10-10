import { describe, expect, it } from "vitest";
import {
  formatCliImageTurnContext,
  hashCliImageTurnEntryId,
} from "../agents/cli-image-turn-correlation.js";
import {
  takeAlignedLocalTurn,
  type LocalTurnBucket,
} from "./cli-session-history.merge-aggregates.js";
import { mergeImportedChatHistoryMessages } from "./cli-session-history.test-support.js";

const RESUME_DRIFT_NOTE =
  "OpenClaw resumed this CLI session after prompt content changed. Follow the current turn's instructions; changed=system-prompt.";

function idempotencyKeys(messages: unknown[]): Array<string | undefined> {
  return messages.map((message) => {
    if (typeof message !== "object" || message === null || !("idempotencyKey" in message)) {
      return undefined;
    }
    const key = message.idempotencyKey;
    return typeof key === "string" ? key : undefined;
  });
}

function claudeMeta(externalId: string) {
  return { __openclaw: { importedFrom: "claude-cli", externalId, cliSessionId: "s" } };
}

function segment(text: string, externalId: string, timestamp?: number) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    ...(timestamp === undefined ? {} : { timestamp }),
    ...claudeMeta(externalId),
  };
}

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

  it("drops a covered aggregate when locals arrive in production page order", () => {
    const timestamp = Date.parse("2026-03-26T16:29:55.700Z");
    const localUser = { role: "user", content: "question", timestamp: timestamp - 1 };
    const localAggregate = {
      role: "assistant",
      content: [{ type: "text", text: "Thinking about the request\nHere is the finished answer." }],
      timestamp,
      idempotencyKey: "cli-assistant:run-1",
    };
    const merged = mergeImportedChatHistoryMessages({
      localOrder: "production-pages",
      localMessages: [localUser, localAggregate],
      importedMessages: [
        {
          role: "user",
          content: "question",
          timestamp: timestamp - 1,
          ...claudeMeta("user-1"),
        },
        segment("Thinking about the request", "interim", timestamp),
        segment("Here is the finished answer.", "final", timestamp + 1),
      ],
    });

    expect(idempotencyKeys(merged)).not.toContain("cli-assistant:run-1");
    expect(merged).toHaveLength(3);
  });

  it("assigns aggregates to the older user across a backward local page", () => {
    const timestamp = Date.parse("2026-03-26T16:00:00.000Z");
    const olderUser = { role: "user", content: "older question", timestamp };
    const olderAggregate = {
      role: "assistant",
      content: [{ type: "text", text: "Older interim\nOlder final" }],
      timestamp: timestamp + 3,
      idempotencyKey: "cli-assistant:older",
    };
    const newerUser = { role: "user", content: "newer question", timestamp: timestamp + 60_000 };
    const newerAggregate = {
      role: "assistant",
      content: [{ type: "text", text: "Newer interim\nNewer final" }],
      timestamp: timestamp + 60_003,
      idempotencyKey: "cli-assistant:newer",
    };
    const pads = Array.from({ length: 62 }, (_, index) => ({
      role: "assistant",
      content: `pad ${index}`,
      timestamp: timestamp + 120_000 + index,
    }));
    const merged = mergeImportedChatHistoryMessages({
      localOrder: "production-pages",
      localMessages: [olderUser, olderAggregate, newerUser, newerAggregate, ...pads],
      importedMessages: [
        {
          role: "user",
          content: "older question",
          timestamp,
          ...claudeMeta("user-older"),
        },
        segment("Older interim", "older-interim", timestamp + 1),
        segment("Older final", "older-final", timestamp + 2),
      ],
    });

    const keys = idempotencyKeys(merged);
    expect(keys).not.toContain("cli-assistant:older");
    expect(keys).toContain("cli-assistant:newer");
  });

  it("keeps both aggregates when repeated prompts share a timestamp window", () => {
    const start = Date.parse("2026-03-26T16:00:00.000Z");
    const reply = "Working on it.\nAll done.";
    const turn = (runId: string, at: number) => ({
      user: { role: "user", content: "ping", timestamp: at },
      aggregate: {
        role: "assistant",
        content: [{ type: "text", text: reply }],
        timestamp: at + 3,
        idempotencyKey: `cli-assistant:${runId}`,
      },
    });
    const first = turn("run-1", start);
    const second = turn("run-2", start + 60_000);
    const merged = mergeImportedChatHistoryMessages({
      localMessages: [first.user, first.aggregate, second.user, second.aggregate],
      importedMessages: [
        { role: "user", content: "ping", timestamp: start + 60_000, ...claudeMeta("user-2") },
        segment("Working on it.", "interim-2", start + 60_001),
        segment("All done.", "final-2", start + 60_002),
      ],
    });

    const keys = idempotencyKeys(merged);
    expect(keys).toContain("cli-assistant:run-1");
    expect(keys).toContain("cli-assistant:run-2");
  });

  it("drops only the later aggregate when a repeated prompt is outside the window", () => {
    const start = Date.parse("2026-03-26T16:00:00.000Z");
    const reply = "Working on it.\nAll done.";
    const turn = (runId: string, at: number) => ({
      user: { role: "user", content: "ping", timestamp: at },
      aggregate: {
        role: "assistant",
        content: [{ type: "text", text: reply }],
        timestamp: at + 3,
        idempotencyKey: `cli-assistant:${runId}`,
      },
    });
    const first = turn("run-1", start);
    const later = turn("run-2", start + 10 * 60_000);
    const merged = mergeImportedChatHistoryMessages({
      localMessages: [first.user, first.aggregate, later.user, later.aggregate],
      importedMessages: [
        {
          role: "user",
          content: "ping",
          timestamp: start + 10 * 60_000,
          ...claudeMeta("user-later"),
        },
        segment("Working on it.", "interim-later", start + 10 * 60_000 + 1),
        segment("All done.", "final-later", start + 10 * 60_000 + 2),
      ],
    });

    const keys = idempotencyKeys(merged);
    expect(keys).toContain("cli-assistant:run-1");
    expect(keys).not.toContain("cli-assistant:run-2");
  });

  it("does not rescan untimestamped prompts for every timestamped import", () => {
    const turns = Array.from({ length: 400 }, (_, order) => ({
      order,
      timestamp: undefined,
    }));
    const bucket: LocalTurnBucket = {
      turns,
      cursor: 0,
      timestamped: [],
      timestampedCursor: 0,
      visits: 0,
    };
    for (let index = 0; index < turns.length; index += 1) {
      expect(takeAlignedLocalTurn(bucket, 1_000 + index)).toBeUndefined();
    }
    expect(bucket.visits).toBe(0);
    expect(bucket.cursor).toBe(0);
    expect(takeAlignedLocalTurn(bucket, 5_000)).toBeUndefined();
  });

  it("aligns the only untimestamped prompt without scanning a timestamp index", () => {
    const bucket: LocalTurnBucket = {
      turns: [{ order: 7, timestamp: undefined }],
      cursor: 0,
      timestamped: [],
      timestampedCursor: 0,
      visits: 0,
    };
    expect(takeAlignedLocalTurn(bucket, 5_000)).toBe(7);
    expect(bucket.visits).toBe(0);
  });

  it("drops a covered aggregate for a resumed prompt the matcher already aligned", () => {
    const timestamp = Date.parse("2026-03-26T16:29:55.700Z");
    const localUser = { role: "user", content: "test ping...", timestamp };
    const localAggregate = {
      role: "assistant",
      content: [{ type: "text", text: "Resumed check.\nResumed answer." }],
      timestamp: timestamp + 3,
      idempotencyKey: "cli-assistant:resume",
    };
    const merged = mergeImportedChatHistoryMessages({
      localMessages: [localUser, localAggregate],
      importedMessages: [
        {
          role: "user",
          content: `${RESUME_DRIFT_NOTE}\n\ntest ping...`,
          timestamp: timestamp + 1,
          ...claudeMeta("user-resume"),
        },
        segment("Resumed check.", "resume-interim", timestamp + 1),
        segment("Resumed answer.", "resume-final", timestamp + 2),
      ],
    });

    expect(idempotencyKeys(merged)).not.toContain("cli-assistant:resume");
  });

  it("drops a covered aggregate when external identity pins the local user", () => {
    const timestamp = Date.parse("2026-03-26T16:29:55.700Z");
    const localUser = {
      role: "user",
      content: "stored prompt",
      timestamp,
      ...claudeMeta("user-ext"),
    };
    const localAggregate = {
      role: "assistant",
      content: [{ type: "text", text: "Identity interim\nIdentity final" }],
      timestamp: timestamp + 3,
      idempotencyKey: "cli-assistant:identity",
    };
    const merged = mergeImportedChatHistoryMessages({
      localMessages: [localUser, localAggregate],
      importedMessages: [
        {
          role: "user",
          content: "rewritten prompt",
          timestamp,
          ...claudeMeta("user-ext"),
        },
        segment("Identity interim", "identity-interim", timestamp + 1),
        segment("Identity final", "identity-final", timestamp + 2),
      ],
    });

    expect(idempotencyKeys(merged)).not.toContain("cli-assistant:identity");
  });

  it("drops a covered aggregate when an image match pins the local user", () => {
    const timestamp = Date.parse("2026-03-26T16:29:55.700Z");
    const localEntryId = "local-image-coverage";
    const imageLocal = {
      role: "user",
      content: "look at this",
      timestamp,
      __openclaw: {
        id: localEntryId,
        media: [{ kind: "image", contentType: "image/png", path: "/media/inbound/coverage.png" }],
      },
    };
    const localAggregate = {
      role: "assistant",
      content: [{ type: "text", text: "Image interim\nImage final" }],
      timestamp: timestamp + 3,
      idempotencyKey: "cli-assistant:image",
    };
    const merged = mergeImportedChatHistoryMessages({
      localMessages: [imageLocal, localAggregate],
      importedMessages: [
        {
          role: "user",
          content: `unrelated caption\n\n${formatCliImageTurnContext(hashCliImageTurnEntryId(localEntryId))}\n\n@/tmp/openclaw/openclaw-cli-images/${"a".repeat(64)}.png`,
          timestamp,
          ...claudeMeta("image-user"),
        },
        segment("Image interim", "image-interim", timestamp + 1),
        segment("Image final", "image-final", timestamp + 2),
      ],
    });

    expect(idempotencyKeys(merged)).not.toContain("cli-assistant:image");
  });

  it("keeps tool results inside a mixed text and tool assistant turn", () => {
    const timestamp = Date.parse("2026-03-26T16:29:55.700Z");
    const localUser = { role: "user", content: "run the tool", timestamp: timestamp - 1 };
    const localAggregate = {
      role: "assistant",
      content: [{ type: "text", text: "I'll check.\nThe answer is 4." }],
      timestamp: timestamp + 4,
      idempotencyKey: "cli-assistant:tool",
    };
    const merged = mergeImportedChatHistoryMessages({
      localMessages: [localUser, localAggregate],
      importedMessages: [
        {
          role: "user",
          content: "run the tool",
          timestamp: timestamp - 1,
          ...claudeMeta("user-tool"),
        },
        {
          role: "assistant",
          content: [
            { type: "text", text: "I'll check." },
            { type: "toolcall", id: "tool-1", name: "calc", arguments: {} },
          ],
          timestamp,
          ...claudeMeta("assistant-mixed"),
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tool-1", content: "4" }],
          timestamp: timestamp + 1,
          ...claudeMeta("tool-result-1"),
        },
        segment("The answer is 4.", "assistant-final", timestamp + 2),
      ],
    });

    expect(idempotencyKeys(merged)).not.toContain("cli-assistant:tool");
    expect(JSON.stringify(merged)).toContain("tool_result");
    expect(JSON.stringify(merged)).toContain("The answer is 4.");
  });
});
