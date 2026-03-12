import { describe, expect, it } from "vitest";
import {
  deleteDcStateFromDb,
  getDcStateFromDb,
  setDcStateInDb,
} from "./channel-dc-state-sqlite.js";
import {
  deleteTgStateFromDb,
  getTgStateFromDb,
  setTgStateInDb,
} from "./channel-tg-state-sqlite.js";
import { useChannelStateTestDb } from "./test-helpers.channel-state.js";

describe("channel_tg_state SQLite adapter", () => {
  useChannelStateTestDb();

  it("stores and retrieves telegram state", () => {
    setTgStateInDb("default", "update_offset", { lastUpdateId: 42, botId: "123" });
    const val = getTgStateFromDb<{ lastUpdateId: number }>("default", "update_offset");
    expect(val?.lastUpdateId).toBe(42);
  });

  it("returns null for missing key", () => {
    expect(getTgStateFromDb("default", "nonexistent")).toBeNull();
  });

  it("upserts on conflict", () => {
    setTgStateInDb("acct1", "offset", { v: 1 });
    setTgStateInDb("acct1", "offset", { v: 2 });
    expect(getTgStateFromDb<{ v: number }>("acct1", "offset")?.v).toBe(2);
  });

  it("isolates by account_id", () => {
    setTgStateInDb("acct1", "offset", { v: 1 });
    setTgStateInDb("acct2", "offset", { v: 2 });
    expect(getTgStateFromDb<{ v: number }>("acct1", "offset")?.v).toBe(1);
    expect(getTgStateFromDb<{ v: number }>("acct2", "offset")?.v).toBe(2);
  });

  it("deletes state", () => {
    setTgStateInDb("acct1", "offset", { v: 1 });
    expect(deleteTgStateFromDb("acct1", "offset")).toBe(true);
    expect(getTgStateFromDb("acct1", "offset")).toBeNull();
  });

  it("delete returns false for missing key", () => {
    expect(deleteTgStateFromDb("acct1", "nonexistent")).toBe(false);
  });
});

describe("channel_dc_state SQLite adapter", () => {
  useChannelStateTestDb();

  it("stores and retrieves discord state", () => {
    setDcStateInDb("model_picker", "discord:acct:guild:g1:user:u1", {
      recent: ["openai/gpt-4"],
      updatedAt: "2026-01-01",
    });
    const val = getDcStateFromDb<{ recent: string[] }>(
      "model_picker",
      "discord:acct:guild:g1:user:u1",
    );
    expect(val?.recent).toEqual(["openai/gpt-4"]);
  });

  it("returns null for missing key", () => {
    expect(getDcStateFromDb("model_picker", "nonexistent")).toBeNull();
  });

  it("uses empty string as default scope", () => {
    setDcStateInDb("global_setting", "", { enabled: true });
    expect(getDcStateFromDb<{ enabled: boolean }>("global_setting")?.enabled).toBe(true);
  });

  it("upserts on conflict", () => {
    const scope = "discord:a:dm:user:u1";
    setDcStateInDb("prefs", scope, { recent: ["a"] });
    setDcStateInDb("prefs", scope, { recent: ["b"] });
    expect(getDcStateFromDb<{ recent: string[] }>("prefs", scope)?.recent).toEqual(["b"]);
  });

  it("deletes state", () => {
    setDcStateInDb("prefs", "scope1", { v: 1 });
    expect(deleteDcStateFromDb("prefs", "scope1")).toBe(true);
    expect(getDcStateFromDb("prefs", "scope1")).toBeNull();
  });
});
