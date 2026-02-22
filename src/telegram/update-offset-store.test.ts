import { describe, expect, it } from "vitest";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import {
  deleteTelegramUpdateOffset,
  readTelegramUpdateOffset,
  writeTelegramUpdateOffset,
} from "./update-offset-store.js";

describe("deleteTelegramUpdateOffset", () => {
  it("removes the offset file so a new bot starts fresh", async () => {
    await withStateDirEnv("openclaw-tg-offset-", async () => {
      await writeTelegramUpdateOffset({ accountId: "default", updateId: 432_000_000 });
      expect(await readTelegramUpdateOffset({ accountId: "default" })).toBe(432_000_000);

      await deleteTelegramUpdateOffset({ accountId: "default" });
      expect(await readTelegramUpdateOffset({ accountId: "default" })).toBeNull();
    });
  });

  it("does not throw when the offset file does not exist", async () => {
    await withStateDirEnv("openclaw-tg-offset-", async () => {
      await expect(deleteTelegramUpdateOffset({ accountId: "nonexistent" })).resolves.not.toThrow();
    });
  });

  it("only removes the targeted account offset, leaving others intact", async () => {
    await withStateDirEnv("openclaw-tg-offset-", async () => {
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
