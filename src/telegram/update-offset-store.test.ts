import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  extractBotIdFromToken,
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

  it("invalidates offset when bot token changes", async () => {
    await withTempStateDir(async () => {
      const oldToken = "111111111:AAFxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
      const newToken = "222222222:AAFyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy";

      await writeTelegramUpdateOffset({
        accountId: "default",
        updateId: 432527632,
        botToken: oldToken,
      });

      // Same token reads back fine
      expect(await readTelegramUpdateOffset({ accountId: "default", botToken: oldToken })).toBe(
        432527632,
      );

      // Different token invalidates the offset
      expect(
        await readTelegramUpdateOffset({ accountId: "default", botToken: newToken }),
      ).toBeNull();
    });
  });

  it("reads offset when no botToken provided (backward compat)", async () => {
    await withTempStateDir(async () => {
      await writeTelegramUpdateOffset({
        accountId: "default",
        updateId: 12345,
        botToken: "111111111:AAFxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      });

      // No token provided — should still return the offset (no validation)
      expect(await readTelegramUpdateOffset({ accountId: "default" })).toBe(12345);
    });
  });

  it("reads legacy offset files without botId field", async () => {
    await withTempStateDir(async () => {
      // Write a legacy-format file (no botId)
      await writeTelegramUpdateOffset({
        accountId: "default",
        updateId: 99999,
      });

      // Should read fine even with a token (no stored botId to compare)
      expect(
        await readTelegramUpdateOffset({
          accountId: "default",
          botToken: "111111111:AAFxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        }),
      ).toBe(99999);
    });
  });
});

describe("extractBotIdFromToken", () => {
  it("extracts bot ID from valid token", () => {
    expect(extractBotIdFromToken("8125167982:AAF35OFUg31nrRW0H60qglgZXfQm5D4xGE0")).toBe(
      "8125167982",
    );
  });

  it("returns undefined for invalid token", () => {
    expect(extractBotIdFromToken("not-a-token")).toBeUndefined();
    expect(extractBotIdFromToken("")).toBeUndefined();
    expect(extractBotIdFromToken(":secret")).toBeUndefined();
  });
});

describe("malformed token edge case", () => {
  it("invalidates offset when new token is malformed but stored botId exists", async () => {
    await withTempStateDir(async () => {
      await writeTelegramUpdateOffset({
        accountId: "default",
        updateId: 999999,
        botToken: "111111111:AAFxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      });

      // Malformed token can't extract a botId — should discard stale offset
      expect(
        await readTelegramUpdateOffset({ accountId: "default", botToken: "malformed-token" }),
      ).toBeNull();
    });
  });
});
