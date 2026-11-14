import { describe, expect, it } from "vitest";
import { buildCliSessionDriftNote } from "../agents/cli-session-drift.js";
import { MemoryCliSessionHistoryIndex } from "./cli-session-history-index-memory.js";
import { CliSessionHistoryIndex } from "./cli-session-history-index.worker.js";
import { mergeImportedChatHistoryMessages } from "./cli-session-history.test-support.js";

const nativeMeta = (externalId: string) => ({
  importedFrom: "claude-cli",
  cliSessionId: "s-1",
  externalId,
});
const nativeUser = (text: string, timestamp: number, id: string) => ({
  role: "user",
  content: text,
  timestamp,
  __openclaw: nativeMeta(id),
});
const nativeAnswer = (text: string, timestamp: number, id: string) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  timestamp,
  __openclaw: nativeMeta(id),
});
const nativeToolTurn = (timestamp: number, id: string) => [
  {
    role: "assistant",
    content: [
      { type: "text", text: "Checking." },
      { type: "toolCall", id: `call-${id}`, name: "lookup", arguments: {} },
    ],
    stopReason: "toolUse",
    timestamp,
    __openclaw: nativeMeta(`${id}-commentary`),
  },
  {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: `call-${id}`, content: "ok" }],
    timestamp: timestamp + 1,
    __openclaw: nativeMeta(`${id}-result`),
  },
  nativeAnswer("Done.", timestamp + 2, `${id}-final`),
];
const prompt = (timestamp: number) => ({ role: "user", content: "question", timestamp });
const finalRow = (text: string, timestamp: number, runId: string) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "cli",
  stopReason: "stop",
  timestamp,
  idempotencyKey: `cli-assistant:${runId}`,
});
const textOf = (message: unknown) => {
  const content = (message as { content: unknown }).content;
  return typeof content === "string"
    ? content
    : (content as Array<{ text?: string }>).flatMap((block) => block.text ?? []).join("");
};

describe.each([
  ["SQLite", CliSessionHistoryIndex],
  ["memory", MemoryCliSessionHistoryIndex],
])("Claude CLI run-final rows in the %s index", (_name, Index) => {
  const visible = (localMessages: unknown[], importedMessages: unknown[]) =>
    mergeImportedChatHistoryMessages({ localMessages, importedMessages }, new Index()).map(textOf);

  it("shows commentary and the answer once when the run-final row joins them", () => {
    expect(
      visible(
        [prompt(1_000), finalRow("Checking.\n\nDone.", 1_300, "run-1")],
        [nativeUser("question", 1_001, "u-1"), ...nativeToolTurn(1_002, "t-1")],
      ),
    ).toEqual(["question", "Checking.", "", "Done."]);
  });

  it("keeps the run-final row when a run has no commentary", () => {
    expect(
      visible(
        [prompt(1_000), finalRow("Done.", 1_300, "run-1")],
        [nativeUser("question", 1_001, "u-1"), nativeAnswer("Done.", 1_002, "a-1")],
      ),
    ).toEqual(["question", "Done."]);
  });

  it("never treats an identical later answer as covered by an earlier turn", () => {
    const later = 600_000;
    expect(
      visible(
        [
          prompt(1_000),
          finalRow("Checking.\n\nDone.", 1_300, "run-1"),
          prompt(later),
          finalRow("Checking.\n\nDone.", later + 300, "run-2"),
        ],
        // Claude has not written the second turn yet.
        [nativeUser("question", 1_001, "u-1"), ...nativeToolTurn(1_002, "t-1")],
      ),
    ).toEqual(["question", "Checking.", "", "Done.", "question", "Checking.\n\nDone."]);
  });

  it("counts and pages only the visible rows after dropping a covered run-final row", () => {
    const index = new Index();
    try {
      index.appendLocal([
        { message: prompt(1_000), seq: 1 },
        { message: finalRow("Checking.\n\nDone.", 1_300, "run-1"), seq: 2 },
      ]);
      for (const message of [
        nativeUser("question", 1_001, "u-1"),
        ...nativeToolTurn(1_002, "t-1"),
      ]) {
        index.appendImported(message);
      }
      index.finish();
      expect(index.count).toBe(4);
      expect(index.rows(0, 10).map((row) => row.local_seq)).toEqual([1, null, null, null]);
      expect(index.localOrdinal(1)).toBe(0);
      expect(index.localOrdinal(2)).toBeUndefined();
    } finally {
      index.close();
    }
  });
});

describe("imported Claude history merge", () => {
  it.each([
    ["alone", ""],
    ["after a drift note", `${buildCliSessionDriftNote(["prompt-tools"])}\n\n`],
  ])("shows a resumed turn carrying unseen exchanges once %s", (_label, driftNote) => {
    const timestamp = Date.parse("2026-09-10T10:57:09.764Z");
    const localMeta = { id: "local-review-ask" };
    const importedMeta = { importedFrom: "claude-cli", externalId: "carried", cliSessionId: "s-1" };
    const localMessage = {
      role: "user",
      content: "What did the review find?",
      timestamp,
      __openclaw: localMeta,
    };
    const carried = [
      "Recorded completion events: ⟦openclaw:ctx⟧",
      "```json",
      '[{"source":"subagent_announce","reply":"The review found one issue."}]',
      "```",
    ].join("\n");
    const importedMessage = {
      role: "user",
      content: [
        {
          type: "text",
          text: `${driftNote}${carried}\n\n[Thu 2026-03-26 16:29 GMT] What did the review find?`,
        },
      ],
      timestamp: timestamp + 1_531,
      __openclaw: importedMeta,
    };

    expect(
      mergeImportedChatHistoryMessages({
        localMessages: [localMessage],
        importedMessages: [importedMessage],
      }),
    ).toEqual([{ ...localMessage, __openclaw: { ...localMeta, ...importedMeta } }]);
  });
});
