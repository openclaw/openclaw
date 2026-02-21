import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  deleteTelegramUpdateOffset,
  readTelegramUpdateOffset,
  writeTelegramUpdateOffset,
} from "./update-offset-store.js";

async function withTempStateDir<T>(fn: (dir: string) => Promise<T>) {
  const previous = process.env.OPENCLAW_STATE_DIR;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tg-offset-"));
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

describe("deleteTelegramUpdateOffset", () => {
  it("removes the offset file so a new bot starts fresh", async () => {
    await withTempStateDir(async () => {
      await writeTelegramUpdateOffset({ accountId: "default", updateId: 432_000_000 });
      expect(await readTelegramUpdateOffset({ accountId: "default" })).toBe(432_000_000);

      await deleteTelegramUpdateOffset({ accountId: "default" });
      expect(await readTelegramUpdateOffset({ accountId: "default" })).toBeNull();
    });
  });

  it("does not throw when the offset file does not exist", async () => {
    await withTempStateDir(async () => {
      await expect(deleteTelegramUpdateOffset({ accountId: "nonexistent" })).resolves.not.toThrow();
    });
  });

  it("only removes the targeted account offset, leaving others intact", async () => {
    await withTempStateDir(async () => {
      await writeTelegramUpdateOffset({ accountId: "default", updateId: 100 });
      await writeTelegramUpdateOffset({ accountId: "alerts", updateId: 200 });

      await deleteTelegramUpdateOffset({ accountId: "default" });

      expect(await readTelegramUpdateOffset({ accountId: "default" })).toBeNull();
      expect(await readTelegramUpdateOffset({ accountId: "alerts" })).toBe(200);
    });
  });

  it("does not share offset across different telegram tokens", async () => {
    await withTempStateDir(async () => {
      await writeTelegramUpdateOffset({
        accountId: "default",
        updateId: 100,
        token: "tok-alpha",
      });

      expect(await readTelegramUpdateOffset({ accountId: "default", token: "tok-alpha" })).toBe(
        100,
      );
      expect(
        await readTelegramUpdateOffset({ accountId: "default", token: "tok-beta" }),
      ).toBeNull();
    });
  });

  it("ignores legacy v1 offset files when token is provided", async () => {
    await withTempStateDir(async () => {
      const stateDir = process.env.OPENCLAW_STATE_DIR;
      if (!stateDir) {
        return;
      }
      const legacyPath = path.join(stateDir, "telegram", "update-offset-default.json");
      await fs.mkdir(path.dirname(legacyPath), { recursive: true });
      await fs.writeFile(
        legacyPath,
        `${JSON.stringify({ version: 1, lastUpdateId: 250 }, null, 2)}\n`,
        "utf-8",
      );
      expect(
        await readTelegramUpdateOffset({ accountId: "default", token: "tok-alpha" }),
      ).toBeNull();
    });
  });
});
