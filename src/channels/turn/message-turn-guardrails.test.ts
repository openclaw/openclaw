import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const migratedMessageTurnFiles = [
  "extensions/discord/src/monitor/message-handler.context.ts",
  "extensions/discord/src/monitor/message-handler.preflight.ts",
  "extensions/slack/src/monitor/message-handler/prepare.ts",
  "extensions/zalouser/src/monitor.ts",
];

const historyWindowFiles = [
  "extensions/discord/src/monitor/message-handler.context.ts",
  "extensions/slack/src/monitor/message-handler/prepare.ts",
  "extensions/zalouser/src/monitor.ts",
];

const lowLevelHistoryHelpers = [
  "buildInboundHistoryFromMap",
  "buildPendingHistoryContextFromMap",
  "clearHistoryEntriesIfEnabled",
  "recordPendingHistoryEntry",
  "recordPendingHistoryEntryIfEnabled",
  "recordPendingHistoryEntryWithMedia",
];

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

describe("message turn migration guardrails", () => {
  it("keeps migrated message paths off low-level reply-history helpers", () => {
    for (const file of migratedMessageTurnFiles) {
      const source = readRepoFile(file);
      for (const helper of lowLevelHistoryHelpers) {
        expect(source, `${file} should use the channel history window, not ${helper}`).not.toMatch(
          new RegExp(`\\b${helper}\\b`),
        );
      }
    }
  });

  it("keeps migrated history users on the channel history window facade", () => {
    for (const file of historyWindowFiles) {
      expect(readRepoFile(file), `${file} should keep using createChannelHistoryWindow`).toContain(
        "createChannelHistoryWindow",
      );
    }
  });
});
