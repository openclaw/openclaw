import { getEventListeners } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOneTimeTicketStore } from "./one-time-ticket-store.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("one-time ticket store", () => {
  it.each([true, false])("revokes without expiry (aborted before mint: %s)", (alreadyAborted) => {
    const requester = new AbortController();
    const onExpire = vi.fn();
    const store = createOneTimeTicketStore<string>({ ttlMs: 100, onExpire });
    if (alreadyAborted) {
      requester.abort();
    }
    const { token } = store.mint("observer", { revokeSignal: requester.signal });
    expect(token).toMatch(/^[a-f0-9]{48}$/u);
    requester.abort();
    expect(store.size).toBe(0);
    expect(store.consume(token)).toBeUndefined();
    expect(getEventListeners(requester.signal, "abort")).toHaveLength(0);
    vi.advanceTimersByTime(100);
    expect(onExpire).not.toHaveBeenCalled();
  });

  it("mints opaque tickets and consumes a trimmed token only once, detaching revocation", () => {
    const requester = new AbortController();
    const store = createOneTimeTicketStore<{ session: string }>({ ttlMs: 60_000 });
    const payload = { session: "observer" };
    const minted = store.mint(payload, { nowMs: 1_000, revokeSignal: requester.signal });
    expect(getEventListeners(requester.signal, "abort")).toHaveLength(1);
    expect(minted.token).toMatch(/^[a-f0-9]{48}$/u);
    expect(minted.expiresAtMs).toBe(61_000);
    expect(store.size).toBe(1);
    expect(store.consume(` \t${minted.token}\n`, 60_999)).toBe(payload);
    expect(store.size).toBe(0);
    expect(store.consume(minted.token, 60_999)).toBeUndefined();
    expect(getEventListeners(requester.signal, "abort")).toHaveLength(0);
    requester.abort();
    expect(store.consume(minted.token)).toBeUndefined();
  });

  it.each(["delete", "timer", "late-consume"] as const)(
    "releases tickets and revocation listeners through %s",
    (end) => {
      const requester = new AbortController();
      const onExpire = vi.fn();
      const store = createOneTimeTicketStore<string>({ ttlMs: 100, now: () => 1_000, onExpire });
      const { token } = store.mint("observer", { revokeSignal: requester.signal });
      expect(getEventListeners(requester.signal, "abort")).toHaveLength(1);
      if (end === "delete") {
        expect(store.delete(token)).toBe(true);
        expect(store.delete(token)).toBe(false);
      } else if (end === "timer") {
        vi.advanceTimersByTime(100);
      } else {
        expect(store.consume(token, 1_100)).toBeUndefined();
      }
      expect(store.size).toBe(0);
      expect(getEventListeners(requester.signal, "abort")).toHaveLength(0);
      expect(store.consume(token, 1_000)).toBeUndefined();
      if (end !== "delete") {
        expect(onExpire).toHaveBeenCalledExactlyOnceWith("observer", token);
      }
      store.clear();
      requester.abort();
      expect(store.consume(token)).toBeUndefined();
      vi.advanceTimersByTime(100);
      expect(onExpire).toHaveBeenCalledTimes(end === "delete" ? 0 : 1);
    },
  );

  it.each(["mismatched", "revoked"] as const)("rejects a %s owner at redemption", (owner) => {
    const requester = new AbortController();
    const store = createOneTimeTicketStore<string>({ ttlMs: 100 });
    const { token } = store.mint("original", { revokeSignal: requester.signal });
    expect(
      store.consume(token, Date.now(), (payload) => {
        if (owner === "revoked") {
          requester.abort();
          return true;
        }
        return payload === "other";
      }),
    ).toBeUndefined();
    if (owner === "mismatched") {
      expect(getEventListeners(requester.signal, "abort")).toHaveLength(1);
      expect(store.consume(token, Date.now(), (payload) => payload === "original")).toBe(
        "original",
      );
    }
    expect(store.size).toBe(0);
    expect(store.consume(token)).toBeUndefined();
    expect(getEventListeners(requester.signal, "abort")).toHaveLength(0);
  });

  it("rejects malformed tokens without consuming another ticket", () => {
    const store = createOneTimeTicketStore<string>({ ttlMs: 60_000 });
    const minted = store.mint("observer");
    for (const token of ["", "a".repeat(47), "a".repeat(49), "A".repeat(48), "g".repeat(48)]) {
      expect(store.consume(token), token).toBeUndefined();
      expect(store.size).toBe(1);
    }
    expect(store.consume(minted.token)).toBe("observer");
  });

  it("honors the injected clock and per-ticket TTL and clock overrides", () => {
    let nowMs = 1_000;
    const store = createOneTimeTicketStore<string>({ ttlMs: 60_000, now: () => nowMs });
    const defaultTicket = store.mint("default");
    const override = store.mint("override", { ttlMs: 100, nowMs: 2_000 });
    expect(defaultTicket.expiresAtMs).toBe(61_000);
    expect(override.expiresAtMs).toBe(2_100);
    nowMs = 2_099;
    expect(store.consume(override.token)).toBe("override");
    expect(store.consume(defaultTicket.token, 61_000)).toBeUndefined();
    expect(store.consume(defaultTicket.token, 1_000)).toBeUndefined();
  });

  it("clears pending tickets, detaching revocation and canceling expiry callbacks", () => {
    const requester = new AbortController();
    const onExpire = vi.fn();
    const store = createOneTimeTicketStore<string>({ ttlMs: 100, onExpire });
    const consumed = store.mint("consumed");
    const first = store.mint("first", { revokeSignal: requester.signal });
    const second = store.mint("second");
    expect(store.consume(consumed.token)).toBe("consumed");
    expect(getEventListeners(requester.signal, "abort")).toHaveLength(1);
    store.clear();
    expect(store.size).toBe(0);
    expect(onExpire.mock.calls).toEqual([
      ["first", first.token],
      ["second", second.token],
    ]);
    expect(store.consume(first.token)).toBeUndefined();
    expect(store.consume(second.token)).toBeUndefined();
    expect(getEventListeners(requester.signal, "abort")).toHaveLength(0);
    requester.abort();
    expect(store.consume(first.token)).toBeUndefined();
    vi.advanceTimersByTime(100);
    expect(onExpire).toHaveBeenCalledTimes(2);
  });
});
