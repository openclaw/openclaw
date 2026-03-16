import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { listObservedTelegramGroups, recordObservedTelegramGroup } from "./observed-groups.js";

async function withTempStateDir<T>(fn: (dir: string) => Promise<T>) {
  const previous = process.env.OPENCLAW_STATE_DIR;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tg-groups-"));
  process.env.OPENCLAW_STATE_DIR = dir;
  try {
    return await fn(dir);
  } finally {
    if (previous === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previous;
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe("telegram observed groups", () => {
  it("records and lists observed telegram groups", async () => {
    await withTempStateDir(async () => {
      await recordObservedTelegramGroup({
        accountId: "default",
        chatId: -1001234567890,
        kind: "supergroup",
        title: "Panama KYC Agent",
        username: "panama_kyc_agent",
        source: "message",
      });

      const groups = await listObservedTelegramGroups({ accountId: "default" });
      expect(groups).toEqual([
        expect.objectContaining({
          kind: "group",
          id: "-1001234567890",
          name: "Panama KYC Agent",
          handle: "@panama_kyc_agent",
        }),
      ]);
    });
  });

  it("ignores non-group chats and keeps the latest title", async () => {
    await withTempStateDir(async () => {
      await recordObservedTelegramGroup({
        accountId: "default",
        chatId: 123456789,
        kind: "private",
        title: "Direct chat",
      });
      await recordObservedTelegramGroup({
        accountId: "default",
        chatId: -1001234567890,
        kind: "supergroup",
        title: "Old Title",
        source: "my_chat_member",
      });
      await recordObservedTelegramGroup({
        accountId: "default",
        chatId: -1001234567890,
        kind: "supergroup",
        title: "New Title",
        source: "message",
      });

      const groups = await listObservedTelegramGroups({ accountId: "default" });
      expect(groups).toHaveLength(1);
      expect(groups[0]).toEqual(
        expect.objectContaining({
          id: "-1001234567890",
          name: "New Title",
        }),
      );
    });
  });
});
