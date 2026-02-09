import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  computeBotTokenHash,
  readTelegramUpdateOffset,
  writeTelegramUpdateOffset,
} from "./update-offset-store.js";

async function withTempStateDir<T>(fn: (dir: string) => Promise<T>) {
  const previous = process.env.OPENCLAW_STATE_DIR;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-"));
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

describe("telegram update offset store", () => {
  it("persists and reloads the last update id", async () => {
    await withTempStateDir(async () => {
      expect(await readTelegramUpdateOffset({ accountId: "primary" })).toBeNull();

      await writeTelegramUpdateOffset({
        accountId: "primary",
        updateId: 421,
      });

      expect(await readTelegramUpdateOffset({ accountId: "primary" })).toBe(421);
    });
  });

  it("discards offset when tokenHash does not match (bot token swap)", async () => {
    await withTempStateDir(async () => {
      const hashOld = computeBotTokenHash("old-bot-token");
      const hashNew = computeBotTokenHash("new-bot-token");

      await writeTelegramUpdateOffset({
        accountId: "primary",
        updateId: 999_999,
        tokenHash: hashOld,
      });

      // Same token hash reads back fine
      expect(await readTelegramUpdateOffset({ accountId: "primary", tokenHash: hashOld })).toBe(
        999_999,
      );

      // Different token hash resets to null (prevents silent message drop)
      expect(
        await readTelegramUpdateOffset({ accountId: "primary", tokenHash: hashNew }),
      ).toBeNull();
    });
  });

  it("reads legacy offset files without tokenHash (backward compat)", async () => {
    await withTempStateDir(async () => {
      // Legacy file written without tokenHash
      await writeTelegramUpdateOffset({
        accountId: "primary",
        updateId: 500,
      });

      // Reading with a tokenHash should still return the offset
      // (legacy file has no tokenHash to mismatch against)
      const hash = computeBotTokenHash("any-token");
      expect(await readTelegramUpdateOffset({ accountId: "primary", tokenHash: hash })).toBe(500);
    });
  });
});
