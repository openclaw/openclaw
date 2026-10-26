import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { expectNoReaddirSyncDuring } from "../../test-utils/fs-scan-assertions.js";
import { listGitTrackedFiles } from "../../test-utils/repo-files.js";
import { runChannelTurn } from "./run-channel-turn.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const migratedMessageTurnFiles = new Set([
  "extensions/discord/src/monitor/message-handler.context.ts",
  "extensions/discord/src/monitor/message-handler.preflight.ts",
  "extensions/feishu/src/bot.ts",
  "extensions/imessage/src/monitor/inbound-processing.ts",
  "extensions/line/src/bot-handlers.ts",
  "extensions/line/src/bot-message-context.ts",
  "extensions/mattermost/src/mattermost/monitor-posts.ts",
  "extensions/msteams/src/monitor-handler/message-handler.ts",
  "extensions/signal/src/monitor/event-handler.ts",
  "extensions/slack/src/monitor/message-handler/prepare.ts",
  "extensions/telegram/src/bot-message-context.body.ts",
  "extensions/telegram/src/bot-message-context.session.ts",
  "extensions/telegram/src/bot-message-dispatch-context.ts",
  "extensions/telegram/src/bot-message-dispatch.ts",
  "extensions/whatsapp/src/auto-reply/monitor/on-message.ts",
  "extensions/zalouser/src/monitor.ts",
]);

const lowLevelHistoryHelpers =
  /\b(?:buildInboundHistoryFromMap|buildHistoryContextFromMap|buildPendingHistoryContextFromMap|clearHistoryEntriesIfEnabled|recordPendingHistoryEntryIfEnabled|recordPendingHistoryEntryWithMedia)\b/;

const legacyReplyHistoryCompatibilityFiles = new Set([
  "extensions/mattermost/runtime-api.ts",
  "extensions/mattermost/src/mattermost/runtime-api.ts",
]);

const skippedExtensionScanDirs = /^(?:\.cache|\.turbo|build|coverage|dist|node_modules|tmp)$/;

function listTsFiles(relativeDir: string): string[] {
  return expectDefined(
    listGitTrackedFiles({ repoRoot, pathspecs: relativeDir }),
    "migration guardrails require a Git checkout",
  ).filter(
    (file) =>
      !file.split("/").some((part) => skippedExtensionScanDirs.test(part)) &&
      file.endsWith(".ts") &&
      !file.endsWith(".d.ts"),
  );
}

const importOrExportPattern =
  /\b(?:import|export)\s*\{([\s\S]*?)\}\s*from\s*["']openclaw\/plugin-sdk\/reply-history["']/g;

describe("message turn migration guardrails", () => {
  it("drops when ingest returns null", async () => {
    const result = await runChannelTurn({
      channel: "test",
      raw: {},
      adapter: { ingest: () => null, resolveTurn: vi.fn() },
    });

    expect(result).toEqual({
      admission: { kind: "drop", reason: "ingest-null" },
      dispatched: false,
    });
  });

  it("lists plugin TypeScript files from git without walking extension roots", () => {
    expectNoReaddirSyncDuring(() => {
      const files = listTsFiles("extensions");

      expect(files.length).toBeGreaterThan(0);
      expect(files.every((file) => file.startsWith("extensions/"))).toBe(true);
      expect(files.some((file) => file.endsWith(".d.ts"))).toBe(false);
    });
  });

  it("keeps migrated paths and plugin runtime imports off low-level reply-history helpers", () => {
    for (const file of new Set([...listTsFiles("extensions"), ...migratedMessageTurnFiles])) {
      if (
        !migratedMessageTurnFiles.has(file) &&
        (file.includes(".test.") || legacyReplyHistoryCompatibilityFiles.has(file))
      ) {
        continue;
      }
      const source = fs.readFileSync(path.join(repoRoot, file), "utf8");
      const bindings = migratedMessageTurnFiles.has(file)
        ? source
        : Array.from(source.matchAll(importOrExportPattern), ([, names]) => names).join(" ");
      expect(bindings, file).not.toMatch(lowLevelHistoryHelpers);
    }
  });
});
