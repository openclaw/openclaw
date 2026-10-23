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

it.each([true, false])("revokes without expiry (aborted before mint: %s)", (aborted) => {
  const { abort, empty, onExpire, token } = ticket("observer", {}, aborted);
  expect(token).toMatch(/^[a-f0-9]{48}$/u);
  abort();
  empty();
  vi.advanceTimersByTime(100);
  expect(onExpire).not.toHaveBeenCalled();
});

it("consumes a trimmed opaque ticket only once and detaches revocation", () => {
  const payload = { session: "observer" };
  const { store, token, expiresAtMs, abort, empty, listeners } = ticket(payload, {
    ttlMs: 60_000,
    now: () => 1_000,
  });
  expect(listeners()).toBe(1);
  expect(token).toMatch(/^[a-f0-9]{48}$/u);
  expect(expiresAtMs).toBe(61_000);
  expect(store.size).toBe(1);
  expect(store.consume(` \t${token}\n`, 60_999)).toBe(payload);
  empty(60_999);
  abort();
  expect(store.consume(token)).toBeUndefined();
});

it.each(["delete", "timer", "late-consume"])("releases via %s", (end) => {
  const { store, token, onExpire, listeners, empty, abort } = ticket("observer", {
    now: () => 1_000,
  });
  expect(listeners()).toBe(1);
  if (end === "delete") {
    expect([store.delete(token), store.delete(token)]).toEqual([true, false]);
  } else if (end === "timer") {
    vi.advanceTimersByTime(100);
  } else {
    expect(store.consume(token, 1_100)).toBeUndefined();
  }
  empty(1_000);
  if (end !== "delete") {
    expect(onExpire).toHaveBeenCalledExactlyOnceWith("observer", token);
  }
  store.clear();
  abort();
  expect(store.consume(token)).toBeUndefined();
  vi.advanceTimersByTime(100);
  expect(onExpire).toHaveBeenCalledTimes(end === "delete" ? 0 : 1);
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

it("honors injected clocks and per-ticket TTL and clock overrides", () => {
  let nowMs = 1_000;
  const store = createOneTimeTicketStore<string>({ ttlMs: 60_000, now: () => nowMs });
  const first = store.mint("default");
  const override = store.mint("override", { ttlMs: 100, nowMs: 2_000 });
  expect([first.expiresAtMs, override.expiresAtMs]).toEqual([61_000, 2_100]);
  nowMs = 2_099;
  expect(store.consume(override.token)).toBe("override");
  expect(store.consume(first.token, 61_000)).toBeUndefined();
  expect(store.consume(first.token, 1_000)).toBeUndefined();
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
