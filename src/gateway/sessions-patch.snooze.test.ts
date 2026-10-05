import { beforeEach, describe, expect, test, vi } from "vitest";
import type { SessionsPatchParams } from "../../packages/gateway-protocol/src/index.js";
import type { SessionEntry } from "../config/sessions.js";
import {
  MAIN_SESSION_KEY,
  runPatch,
  expectPatchOk,
  expectPatchError,
} from "./sessions-patch.test-support.js";

const key = "agent:main:dashboard:work";
const now = 1_800_000_000_000;
const wakeAt = now + 3_600_000;
const snoozed = { pinnedAt: 10, snoozedUntil: wakeAt, snoozedAt: now - 1 };
const archivedError = "cannot snooze an archived session; restore it first";
const childError = "cannot snooze a child session; snooze its parent session instead";

describe("snooze", () => {
  beforeEach(() => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    return () => clock.mockRestore();
  });

  test("preserves the pin and original stamp until a different wake time is chosen", async () => {
    const store = {
      [key]: { sessionId: "work", updatedAt: 1, pinnedAt: 10, parentSessionKey: MAIN_SESSION_KEY },
    };
    const patch = (snoozedUntil: number) =>
      runPatch({ store, storeKey: key, patch: { key, snoozedUntil, expectedSessionId: "work" } });
    expect(expectPatchOk(await patch(wakeAt))).toMatchObject({
      snoozedUntil: wakeAt,
      snoozedAt: now,
      pinnedAt: 10,
    });
    expect(store[key]).not.toHaveProperty("archivedAt");
    vi.mocked(Date.now).mockReturnValue(now + 100);
    expect(expectPatchOk(await patch(wakeAt)).snoozedAt).toBe(now);
    expect(expectPatchOk(await patch(wakeAt + 100))).toMatchObject({
      snoozedUntil: wakeAt + 100,
      snoozedAt: now + 100,
      pinnedAt: 10,
    });
  });

  test.each([
    { patch: { snoozedUntil: now }, error: "snooze wake time must be in the future" },
    { entry: { archivedAt: 10 }, error: archivedError },
    { patch: { archived: true }, error: archivedError },
    { entry: { spawnedBy: MAIN_SESSION_KEY }, error: childError },
    { storeKey: "unknown", error: "Cannot snooze the unknown session sentinel." },
    { storeKey: "global", error: "Cannot snooze an agent's main session." },
    { storeKey: MAIN_SESSION_KEY, error: "Cannot snooze an agent's main session." },
    { entry: { sessionId: "" }, error: `session not found: ${key}` },
    { entry: { sessionId: "" }, patch: { snoozedUntil: null }, error: `session not found: ${key}` },
    {
      patch: { expectedSessionId: undefined },
      error: "expectedSessionId required for session lifecycle patch",
    },
    {
      patch: { snoozedUntil: null, expectedSessionId: undefined },
      error: "expectedSessionId required for session lifecycle patch",
    },
  ] satisfies {
    storeKey?: string;
    entry?: Partial<SessionEntry>;
    patch?: Partial<SessionsPatchParams>;
    error: string;
  }[])(
    "rejects invalid lifecycle patch %j without mutating the entry",
    async ({ storeKey = key, entry, patch, error }) => {
      const original = { sessionId: "work", updatedAt: 1, ...entry };
      const store = { [storeKey]: original };
      expectPatchError(
        await runPatch({
          store,
          storeKey,
          patch: { key: storeKey, snoozedUntil: wakeAt, expectedSessionId: "work", ...patch },
        }),
        error,
      );
      expect(store[storeKey]).toBe(original);
    },
  );

  test.each([
    { patch: { snoozedUntil: null }, entry: snoozed, expected: { pinnedAt: 10 }, repeats: 2 },
    { patch: { archived: true }, entry: snoozed, expected: { archivedAt: now } },
    { patch: { pinned: true }, entry: snoozed, expected: { pinnedAt: 10 } },
    {
      patch: { archived: false, snoozedUntil: wakeAt },
      entry: { archivedAt: 10 },
      expected: { snoozedUntil: wakeAt, snoozedAt: now },
    },
    { patch: { pinned: true, snoozedUntil: wakeAt }, entry: {}, expected: { pinnedAt: now } },
  ] satisfies {
    patch: Partial<SessionsPatchParams>;
    entry: Partial<SessionEntry>;
    expected: Partial<SessionEntry>;
    repeats?: number;
  }[])(
    "applies visibility patch $patch consistently",
    async ({ patch, entry, expected, repeats = 1 }) => {
      const store = { [key]: { sessionId: "work", updatedAt: 1, ...entry } };
      for (let attempt = 0; attempt < repeats; attempt++) {
        const next = expectPatchOk(
          await runPatch({
            store,
            storeKey: key,
            patch: { key, ...patch, expectedSessionId: "work" },
          }),
        );
        for (const field of ["snoozedUntil", "snoozedAt", "pinnedAt", "archivedAt"] as const) {
          expect(next[field], field).toBe(expected[field]);
        }
      }
    },
  );
});
