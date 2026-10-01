import { describe, expect, it } from "vitest";
import { REQUESTER_PROFILE_GUIDANCE } from "../auto-reply/reply/inbound-context-marker.js";
import { mergeImportedChatHistoryMessages } from "./cli-session-history.merge.js";

const cliMeta = {
  importedFrom: "claude-cli",
  externalId: "native-user",
  cliSessionId: "session-1",
};

function user(content: string, timestamp: number, meta?: Record<string, unknown>) {
  return { role: "user", content, timestamp, ...(meta ? { __openclaw: meta } : {}) };
}

describe("Claude CLI user-turn dedupe", () => {
  it("dedupes an import that carries the verified requester guidance", () => {
    const localMessage = user("you there?", 1_000);
    const importedMessage = user(`${REQUESTER_PROFILE_GUIDANCE}\n\nyou there?`, 1_400, cliMeta);

    expect(
      mergeImportedChatHistoryMessages({
        localMessages: [localMessage],
        importedMessages: [importedMessage],
      }),
    ).toHaveLength(1);
  });

  it("matches a queued send by its transcript record time", () => {
    const sentAt = 1_000;
    const recordedAt = sentAt + 13 * 60 * 1_000;
    const localMessage = user("give me a link", sentAt, { recordTimestampMs: recordedAt });
    const importedMessage = user("give me a link", recordedAt + 1_100, cliMeta);

    expect(
      mergeImportedChatHistoryMessages({
        localMessages: [localMessage],
        importedMessages: [importedMessage],
      }),
    ).toHaveLength(1);
  });
});
