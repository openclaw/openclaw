// Snooze patch coverage preserves active lifecycle, target guards, and wake semantics.
import { describe, expect, test, vi } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import {
  MAIN_SESSION_KEY,
  runPatch,
  expectPatchOk,
  expectPatchError,
} from "./sessions-patch.test-support.js";

describe("snooze", () => {
  const key = "agent:main:dashboard:work";
  const now = 1_800_000_000_000;
  const wakeAt = now + 3_600_000;

  test("preserves the pin and the original snooze stamp until a different wake time is chosen", async () => {
    using clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const store = {
      [key]: {
        sessionId: "work",
        updatedAt: 1,
        pinnedAt: 10,
        parentSessionKey: MAIN_SESSION_KEY,
      },
    };
    const patch = (snoozedUntil: number) =>
      runPatch({ store, storeKey: key, patch: { key, snoozedUntil, expectedSessionId: "work" } });
    expect(expectPatchOk(await patch(wakeAt))).toMatchObject({
      snoozedUntil: wakeAt,
      snoozedAt: now,
      pinnedAt: 10,
    });
    expect(store[key]).not.toHaveProperty("archivedAt");
    clock.mockReturnValue(now + 100);
    expect(expectPatchOk(await patch(wakeAt)).snoozedAt).toBe(now);
    expect(expectPatchOk(await patch(wakeAt + 100))).toMatchObject({
      snoozedUntil: wakeAt + 100,
      snoozedAt: now + 100,
      pinnedAt: 10,
    });
  });

  test.each([now - 1, now])(
    "rejects a wake time that is not in the future: %s",
    async (snoozedUntil) => {
      using clock = vi.spyOn(Date, "now");
      clock.mockReturnValue(now);
      const entry = { sessionId: "work", updatedAt: 1 };
      const store = { [key]: entry };
      expectPatchError(
        await runPatch({
          store,
          storeKey: key,
          patch: { key, snoozedUntil, expectedSessionId: "work" },
        }),
        "snooze wake time must be in the future",
      );
      expect(store[key]).toBe(entry);
    },
  );

  test.each([
    {
      key,
      entry: { archivedAt: 10 },
      error: "cannot snooze an archived session; restore it first",
    },
    {
      key,
      entry: { spawnedBy: MAIN_SESSION_KEY },
      error: "cannot snooze a child session; snooze its parent session instead",
    },
    {
      key,
      entry: { parentSessionKey: "agent:main:dashboard:parent" },
      error: "cannot snooze a child session; snooze its parent session instead",
    },
    {
      key: "agent:main:subagent:child",
      entry: {},
      error: "cannot snooze a child session; snooze its parent session instead",
    },
    { key: "unknown", entry: {}, error: "Cannot snooze the unknown session sentinel." },
    { key: "global", entry: {}, error: "Cannot snooze an agent's main session." },
    { key: MAIN_SESSION_KEY, entry: {}, error: "Cannot snooze an agent's main session." },
  ])("rejects snoozing $key with $entry", async ({ key: storeKey, entry, error }) => {
    using clock = vi.spyOn(Date, "now");
    clock.mockReturnValue(now);
    const original = { sessionId: "work", updatedAt: 1, ...entry };
    const store = { [storeKey]: original };
    expectPatchError(
      await runPatch({
        store,
        storeKey,
        patch: { key: storeKey, snoozedUntil: wakeAt, expectedSessionId: "work" },
      }),
      error,
    );
    expect(store[storeKey]).toBe(original);
  });

  test("wakes idempotently without losing the pin", async () => {
    const store = {
      [key]: {
        sessionId: "work",
        updatedAt: 1,
        pinnedAt: 10,
        snoozedUntil: wakeAt,
        snoozedAt: now,
      },
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      const entry = expectPatchOk(
        await runPatch({
          store,
          storeKey: key,
          patch: { key, snoozedUntil: null, expectedSessionId: "work" },
        }),
      );
      expect(entry.snoozedUntil).toBeUndefined();
      expect(entry.snoozedAt).toBeUndefined();
      expect(entry.pinnedAt).toBe(10);
    }
  });

  test.each([
    {
      patch: { archived: true, snoozedUntil: wakeAt },
      error: "cannot snooze an archived session; restore it first",
    },
    { patch: { archived: false, snoozedUntil: wakeAt }, snoozed: true },
    { patch: { pinned: true, snoozedUntil: wakeAt }, snoozed: false },
  ])("applies combined visibility patch $patch consistently", async ({ patch, error, snoozed }) => {
    using clock = vi.spyOn(Date, "now");
    clock.mockReturnValue(now);
    const entry = {
      sessionId: "work",
      updatedAt: 1,
      ...(patch.archived === false ? { archivedAt: 10 } : {}),
    };
    const store = { [key]: entry };
    const result = await runPatch({
      store,
      storeKey: key,
      patch: { key, ...patch, expectedSessionId: "work" },
    });
    if (error) {
      expectPatchError(result, error);
      expect(store[key]).toBe(entry);
    } else {
      const next = expectPatchOk(result);
      expect(next.archivedAt).toBeUndefined();
      expect(next.snoozedUntil).toBe(snoozed ? wakeAt : undefined);
      expect(next.snoozedAt).toBe(snoozed ? now : undefined);
      if (patch.pinned) {
        expect(next.pinnedAt).toBe(now);
      }
    }
  });

  test.each([
    { action: "snooze", snoozedUntil: wakeAt, sessionId: undefined },
    { action: "snooze", snoozedUntil: wakeAt, sessionId: "" },
    { action: "wake", snoozedUntil: null, sessionId: undefined },
    { action: "wake", snoozedUntil: null, sessionId: "" },
  ])("rejects $action for a provisional session identity", async ({ snoozedUntil, sessionId }) => {
    const entry = { sessionId, updatedAt: 1 } as SessionEntry;
    const store = { [key]: entry };
    expectPatchError(
      await runPatch({ store, storeKey: key, patch: { key, snoozedUntil } }),
      `session not found: ${key}`,
    );
    expect(store[key]).toBe(entry);
  });

  test.each([wakeAt, null])(
    "requires the caller-observed durable identity for %j",
    async (snoozedUntil) => {
      expectPatchError(
        await runPatch({
          store: { [key]: { sessionId: "work", updatedAt: 1 } },
          storeKey: key,
          patch: { key, snoozedUntil },
        }),
        "expectedSessionId required for session lifecycle patch",
      );
    },
  );

  test.each([{ archived: true }, { pinned: true }])(
    "clears snooze when applying %j",
    async (patch) => {
      using clock = vi.spyOn(Date, "now");
      clock.mockReturnValue(now);
      const entry = expectPatchOk(
        await runPatch({
          store: {
            [key]: {
              sessionId: "work",
              updatedAt: 1,
              pinnedAt: 10,
              snoozedUntil: wakeAt,
              snoozedAt: now - 1,
            },
          },
          storeKey: key,
          patch: { key, ...patch, expectedSessionId: "work" },
        }),
      );
      expect(entry.snoozedUntil).toBeUndefined();
      expect(entry.snoozedAt).toBeUndefined();
      expect(entry.archivedAt).toBe(patch.archived ? now : undefined);
      expect(entry.pinnedAt).toBe(patch.pinned ? 10 : undefined);
    },
  );
});
