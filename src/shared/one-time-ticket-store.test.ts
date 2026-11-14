import { getEventListeners } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createOneTimeTicketStore } from "./one-time-ticket-store.js";

function ticket<T>(
  payload: T,
  options: { ttlMs?: number; now?: () => number } = {},
  aborted = false,
) {
  const requester = new AbortController();
  const onExpire = vi.fn();
  const store = createOneTimeTicketStore<T>({ ttlMs: 100, ...options, onExpire });
  if (aborted) {
    requester.abort();
  }
  const minted = store.mint(payload, { revokeSignal: requester.signal });
  const listeners = () => getEventListeners(requester.signal, "abort").length;
  const empty = (now?: number) => {
    expect(store.size).toBe(0);
    expect(store.consume(minted.token, now)).toBeUndefined();
    expect(listeners()).toBe(0);
  };
  return { store, ...minted, onExpire, listeners, empty, abort: () => requester.abort() };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it.each(["pre-abort", "abort", "delete", "timer", "late-consume"])("releases via %s", (end) => {
  const { store, token, onExpire, listeners, empty, abort } = ticket(
    "observer",
    { now: () => 1_000 },
    end === "pre-abort",
  );
  expect(token).toMatch(/^[a-f0-9]{48}$/u);
  expect(listeners()).toBe(end === "pre-abort" ? 0 : 1);
  if (end === "pre-abort" || end === "abort") {
    abort();
  } else if (end === "delete") {
    expect([store.delete(token), store.delete(token)]).toEqual([true, false]);
  } else if (end === "timer") {
    vi.advanceTimersByTime(100);
  } else {
    expect(store.consume(token, 1_100)).toBeUndefined();
  }
  empty(1_000);
  const expires = end === "timer" || end === "late-consume";
  if (expires) {
    expect(onExpire).toHaveBeenCalledExactlyOnceWith("observer", token);
  }
  store.clear();
  abort();
  expect(store.consume(token)).toBeUndefined();
  vi.advanceTimersByTime(100);
  expect(onExpire).toHaveBeenCalledTimes(expires ? 1 : 0);
});

it.each(["mismatched", "revoked"])("rejects a %s owner at redemption", (owner) => {
  const { store, token, abort, empty, listeners } = ticket("original");
  expect(
    store.consume(token, Date.now(), (payload) => {
      if (owner === "revoked") {
        abort();
        return true;
      }
      return payload === "other";
    }),
  ).toBeUndefined();
  if (owner === "mismatched") {
    expect(listeners()).toBe(1);
    expect(store.consume(token, Date.now(), (p) => p === "original")).toBe("original");
  }
  empty();
});

it("rejects malformed tokens without consuming another ticket", () => {
  const { store, token: valid } = ticket("observer", { ttlMs: 60_000 });
  for (const token of ["", "a".repeat(47), "a".repeat(49), "A".repeat(48), "g".repeat(48)]) {
    expect(store.consume(token), token).toBeUndefined();
    expect(store.size).toBe(1);
  }
  expect(store.consume(valid)).toBe("observer");
});

it("honors clock/TTL overrides and consumes trimmed tickets only once", () => {
  let nowMs = 1_000;
  const payload = { session: "observer" };
  const { store, token, expiresAtMs, listeners, abort, empty } = ticket(payload, {
    ttlMs: 60_000,
    now: () => nowMs,
  });
  const late = store.mint(payload);
  const override = store.mint(payload, { ttlMs: 100, nowMs: 2_000 });
  expect([expiresAtMs, override.expiresAtMs]).toEqual([61_000, 2_100]);
  nowMs = 2_099;
  expect(store.consume(override.token)).toBe(payload);
  expect(store.consume(` \t${token}\n`, 60_999)).toBe(payload);
  expect(listeners()).toBe(0);
  abort();
  expect(store.consume(token)).toBeUndefined();
  expect(store.consume(late.token, 61_000)).toBeUndefined();
  expect(store.consume(late.token, 1_000)).toBeUndefined();
  empty(1_000);
});

it("clears pending tickets, detaching revocation and canceling expiry callbacks", () => {
  const { store, token, abort, empty, listeners, onExpire } = ticket("first");
  const consumed = store.mint("consumed");
  const second = store.mint("second");
  expect(store.consume(consumed.token)).toBe("consumed");
  expect(listeners()).toBe(1);
  store.clear();
  empty();
  expect(onExpire.mock.calls).toEqual([
    ["first", token],
    ["second", second.token],
  ]);
  expect(store.consume(second.token)).toBeUndefined();
  abort();
  expect(store.consume(token)).toBeUndefined();
  vi.advanceTimersByTime(100);
  expect(onExpire).toHaveBeenCalledTimes(2);
});
