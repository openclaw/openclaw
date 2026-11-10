import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  customSnoozeStorageKey,
  localSnoozeInputValue,
  parseCustomSnooze,
  readCustomSnooze,
  rememberCustomSnooze,
} from "./custom-snooze.ts";

const now = new Date(2026, 9, 13, 12).getTime();
const future = now + 86_400_000;
let key: string;
let storage: Map<string, string>;
const scope = (account: string, url = "wss://gateway.example") =>
  customSnoozeStorageKey(url, account);
const denied = () => {
  throw new Error("denied");
};
beforeEach(() => {
  key = scope("account-" + Math.random())!;
  storage = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (storageKey: string) => storage.get(storageKey) ?? null,
    setItem: (storageKey: string, value: string) => storage.set(storageKey, value),
    removeItem: (storageKey: string) => storage.delete(storageKey),
  });
});
afterEach(() => vi.unstubAllGlobals());

it("keeps one reusable timestamp for an hour, replacing only on another custom selection", () => {
  rememberCustomSnooze(key, future, now);
  expect(readCustomSnooze(key, now + 3_599_999)).toBe(future);
  expect(storage.size).toBe(1);
  rememberCustomSnooze(key, future + 60_000, now + 1000);
  expect(readCustomSnooze(key, now + 2000)).toBe(future + 60_000);
  expect(storage.size).toBe(1);
  expect(readCustomSnooze(key, now + 3_601_000)).toBeNull();
  expect(storage.size).toBe(0);
});
it.each([
  "broken",
  "null",
  "[]",
  "{}",
  JSON.stringify({ snoozedUntil: future, selectedAt: now + 1 }),
  JSON.stringify({ snoozedUntil: now, selectedAt: now }),
  JSON.stringify({ snoozedUntil: 1e20, selectedAt: now }),
])("discards corrupt, past, and invalid stored choices: %s", (raw) => {
  storage.set(key, raw);
  expect(readCustomSnooze(key, now)).toBeNull();
  expect(storage.has(key)).toBe(false);
});
it.each([false, true])(
  "retains the latest choice after a failed write (readable=%s)",
  (readable) => {
    if (readable) {
      rememberCustomSnooze(key, future, now);
    }
    vi.stubGlobal("localStorage", {
      getItem: readable ? (storageKey: string) => storage.get(storageKey) ?? null : denied,
      setItem: denied,
      ...(readable ? {} : { removeItem: denied }),
    });
    const selected = readable ? future + 1000 : future;
    rememberCustomSnooze(key, selected, now);
    expect(readCustomSnooze(key, now)).toBe(selected);
    if (!readable) {
      expect(readCustomSnooze(key, now + 3_600_000)).toBeNull();
      vi.stubGlobal("localStorage", undefined);
      rememberCustomSnooze(key, future, now);
      expect(readCustomSnooze(key, now)).toBe(future);
    }
  },
);
it("isolates accounts and gateways without persisting unresolved identities", () => {
  rememberCustomSnooze(key, future, now);
  expect(readCustomSnooze(scope("other-account"), now)).toBeNull();
  expect(readCustomSnooze(scope("account", "wss://other.example"), now)).toBeNull();
  expect(scope("")).toBeNull();
  rememberCustomSnooze(null, future, now);
  expect(storage.size).toBe(1);
});

it("interprets local calendar input without accepting past, empty, or normalized dates", () => {
  const input = localSnoozeInputValue(new Date(future));
  expect(parseCustomSnooze(input, now)).toBe(future);
  for (const value of [
    "",
    "not a date",
    "2026-02-30T09:00",
    localSnoozeInputValue(new Date(now)),
    "2026-10-14T09:00Z",
  ]) {
    expect(parseCustomSnooze(value, now)).toBeNull();
  }
});
