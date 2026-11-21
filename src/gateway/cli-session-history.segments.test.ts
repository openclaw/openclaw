import fs from "node:fs/promises";
import { expect, it } from "vitest";
import {
  mergeImportedChatHistoryMessages,
  readClaudeCliSessionMessagesAsync,
  user,
  withClaudeProjectsDir,
} from "./cli-session-history.test-support.js";
import { requireGatewayRecord } from "./test-helpers.assertions.js";

it.each([
  { name: "output replacement", native: "Ask OldName.", canonical: "Ask NewName." },
  {
    name: "tagged reasoning",
    native: "<thinking>Private analysis.</thinking>The answer is here.",
    canonical: "The answer is here.",
  },
])(
  "pairs canonical commentary with its native record by identity when texts differ: $name",
  async ({ native, canonical }) => {
    await withClaudeProjectsDir(async ({ projectsDir, sessionId, filePath }) => {
      const at = Date.parse("2026-03-26T16:30:00.000Z");
      await fs.appendFile(
        filePath,
        `\n${JSON.stringify({
          type: "assistant",
          uuid: "pre-tool",
          timestamp: new Date(at).toISOString(),
          message: {
            id: "msg-pre-tool",
            role: "assistant",
            content: [{ type: "text", text: native }],
          },
        })}`,
      );
      const localMessages = [
        user("Explain, then check a tool", at - 1_000),
        {
          role: "assistant",
          content: [{ type: "text", text: canonical }],
          timestamp: at,
          __openclaw: {
            externalId: "pre-tool",
            importedFrom: "claude-cli",
            cliSessionId: sessionId,
          },
        },
      ];
      for (const nativeSessionId of [sessionId, "replacement-session"]) {
        const entry = { sessionId: "local-session" };
        const messages = mergeImportedChatHistoryMessages({
          localMessages,
          importedMessages: await readClaudeCliSessionMessagesAsync({
            cliSessionId: nativeSessionId,
            projectsDir,
            localSessionId: entry.sessionId,
          }),
        });
        const texts = messages.map((message) =>
          JSON.stringify(requireGatewayRecord(message, "message").content),
        );
        expect(texts.filter((text) => text.includes(canonical))).toHaveLength(1);
        expect(texts.some((text) => text.includes(native))).toBe(false);
      }
    });
  },
);
