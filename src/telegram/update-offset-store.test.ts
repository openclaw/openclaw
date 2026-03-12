import { describe, expect, it } from "vitest";
import { useChannelStateTestDb } from "../infra/state-db/test-helpers.channel-state.js";
import {
  deleteTelegramUpdateOffset,
  readTelegramUpdateOffset,
  writeTelegramUpdateOffset,
} from "./update-offset-store.js";

describe("deleteTelegramUpdateOffset", () => {
  useChannelStateTestDb();

  it("removes the offset so a new bot starts fresh", async () => {
    await writeTelegramUpdateOffset({ accountId: "default", updateId: 432_000_000 });
    expect(await readTelegramUpdateOffset({ accountId: "default" })).toBe(432_000_000);

    await deleteTelegramUpdateOffset({ accountId: "default" });
    expect(await readTelegramUpdateOffset({ accountId: "default" })).toBeNull();
  });

  it("does not throw when the offset does not exist", async () => {
    await expect(deleteTelegramUpdateOffset({ accountId: "nonexistent" })).resolves.not.toThrow();
  });

  it("only removes the targeted account offset, leaving others intact", async () => {
    await writeTelegramUpdateOffset({ accountId: "default", updateId: 100 });
    await writeTelegramUpdateOffset({ accountId: "alerts", updateId: 200 });

    await deleteTelegramUpdateOffset({ accountId: "default" });

    expect(await readTelegramUpdateOffset({ accountId: "default" })).toBeNull();
    expect(await readTelegramUpdateOffset({ accountId: "alerts" })).toBe(200);
  });

  it("returns null when stored offset was written by a different bot token", async () => {
    await writeTelegramUpdateOffset({
      accountId: "default",
      updateId: 321,
      botToken: "111111:token-a",
    });

    expect(
      await readTelegramUpdateOffset({
        accountId: "default",
        botToken: "222222:token-b",
      }),
    ).toBeNull();
    expect(
      await readTelegramUpdateOffset({
        accountId: "default",
        botToken: "111111:token-a",
      }),
    ).toBe(321);
  });

  it("returns null for empty DB (no legacy file)", async () => {
    expect(
      await readTelegramUpdateOffset({
        accountId: "default",
        botToken: "333333:token-c",
      }),
    ).toBeNull();
  });

  it("rejects writing invalid update IDs", async () => {
    await expect(
      writeTelegramUpdateOffset({ accountId: "default", updateId: -1 as number }),
    ).rejects.toThrow(/non-negative safe integer/i);
  });
});
