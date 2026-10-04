import { describe, expect, it } from "vitest";
import {
  buildCliSessionDriftNote,
  buildCliSessionUnseenTurnsContext,
} from "../agents/cli-session.js";
import { mergeImportedChatHistoryMessages } from "./cli-session-history.test-support.js";

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
    const carried = buildCliSessionUnseenTurnsContext([
      { prompt: "Child result: CHILD_RESULT_7f3a9c", reply: "The review found one issue." },
    ]);
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
