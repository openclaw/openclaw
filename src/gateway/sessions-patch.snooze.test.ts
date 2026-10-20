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
const requiredId = "expectedSessionId required for session lifecycle patch";
type Patch = Partial<SessionsPatchParams>;
type Entry = Partial<SessionEntry>;
const visibility = (entry: Entry) => [
  entry.snoozedUntil,
  entry.snoozedAt,
  entry.pinnedAt,
  entry.archivedAt,
];

function fixture(entry: Entry = {}, storeKey = key) {
  const original = { sessionId: "work", updatedAt: 1, ...entry };
  const store = { [storeKey]: original };
  const patch = (changes: Patch) =>
    runPatch({
      store,
      storeKey,
      patch: { key: storeKey, expectedSessionId: "work", ...changes },
    });
  return { original, store, patch };
}

describe("snooze", () => {
  beforeEach(() => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    return () => clock.mockRestore();
  });

  test("preserves the pin and original stamp until a different wake time is chosen", async () => {
    const value = fixture({ pinnedAt: 10, parentSessionKey: MAIN_SESSION_KEY });
    const patch = (snoozedUntil: number) => value.patch({ snoozedUntil });
    expect(expectPatchOk(await patch(wakeAt))).toMatchObject({
      snoozedUntil: wakeAt,
      snoozedAt: now,
      pinnedAt: 10,
    });
    expect(value.store[key]).not.toHaveProperty("archivedAt");
    vi.mocked(Date.now).mockReturnValue(now + 100);
    expect(expectPatchOk(await patch(wakeAt)).snoozedAt).toBe(now);
    expect(expectPatchOk(await patch(wakeAt + 100))).toMatchObject({
      snoozedUntil: wakeAt + 100,
      snoozedAt: now + 100,
      pinnedAt: 10,
    });
  });

  test.each<[string, Entry, Patch, string]>([
    [key, {}, { snoozedUntil: now }, "snooze wake time must be in the future"],
    [key, { archivedAt: 10 }, {}, archivedError],
    [key, {}, { archived: true }, archivedError],
    [key, { spawnedBy: MAIN_SESSION_KEY }, {}, childError],
    ["unknown", {}, {}, "Cannot snooze the unknown session sentinel."],
    ["global", {}, {}, "Cannot snooze an agent's main session."],
    [MAIN_SESSION_KEY, {}, {}, "Cannot snooze an agent's main session."],
    [key, { sessionId: "" }, {}, `session not found: ${key}`],
    [key, { sessionId: "" }, { snoozedUntil: null }, `session not found: ${key}`],
    [key, {}, { expectedSessionId: undefined }, requiredId],
    [key, {}, { snoozedUntil: null, expectedSessionId: undefined }, requiredId],
  ])("rejects lifecycle patch for %s: %j / %j (%s)", async (storeKey, entry, patch, error) => {
    const value = fixture(entry, storeKey);
    expectPatchError(await value.patch({ snoozedUntil: wakeAt, ...patch }), error);
    expect(value.store[storeKey]).toBe(value.original);
  });

  test.each<[Patch, Entry, Entry, number?]>([
    [{ snoozedUntil: null }, snoozed, { pinnedAt: 10 }, 2],
    [{ archived: true }, snoozed, { archivedAt: now }],
    [{ pinned: true }, snoozed, { pinnedAt: 10 }],
    [
      { archived: false, snoozedUntil: wakeAt },
      { archivedAt: 10 },
      { snoozedUntil: wakeAt, snoozedAt: now },
    ],
    [{ pinned: true, snoozedUntil: wakeAt }, {}, { pinnedAt: now }],
  ])("applies visibility patch %j consistently", async (patch, entry, expected, repeats = 1) => {
    const value = fixture(entry);
    for (let attempt = 0; attempt < repeats; attempt++) {
      expect(visibility(expectPatchOk(await value.patch(patch)))).toEqual(visibility(expected));
    }
  });
});
