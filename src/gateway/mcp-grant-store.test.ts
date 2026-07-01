import { beforeEach, describe, expect, it } from "vitest";
import {
  resetAttachGrantsForTest,
  attachGrantStoreSize,
  mintAttachGrant,
  resolveAttachGrant,
  revokeAttachGrant,
  revokeAttachGrantsForSession,
  sweepExpiredAttachGrants,
} from "./mcp-grant-store.js";

const T0 = 1_000_000_000_000;

describe("mcp-grant-store", () => {
  beforeEach(() => resetAttachGrantsForTest());

  it("mints a grant bound to the sessionKey with a token and a TTL window", () => {
    const g = mintAttachGrant({ sessionKey: "agent:main:main", ttlMs: 60_000, nowMs: T0 });
    expect(g.sessionKey).toBe("agent:main:main");
    expect(g.token).toMatch(/^[0-9a-f]{64}$/);
    expect(g.issuedAtMs).toBe(T0);
    expect(g.expiresAtMs).toBe(T0 + 60_000);
  });

  it("requires a non-empty sessionKey", () => {
    expect(() => mintAttachGrant({ sessionKey: "  ", nowMs: T0 })).toThrow();
  });

  it("resolves a live grant and drops it once expired (TTL)", () => {
    const g = mintAttachGrant({ sessionKey: "agent:main:x", ttlMs: 1_000, nowMs: T0 });
    expect(resolveAttachGrant(g.token, T0)?.sessionKey).toBe("agent:main:x");
    expect(resolveAttachGrant(g.token, T0 + 999)?.sessionKey).toBe("agent:main:x");
    expect(resolveAttachGrant(g.token, T0 + 1_000)).toBeUndefined();
    expect(resolveAttachGrant(g.token, T0 + 1_001)).toBeUndefined();
    expect(attachGrantStoreSize()).toBe(0);
  });

  it("returns undefined for an unknown token (no scope without a grant)", () => {
    expect(resolveAttachGrant("deadbeef", T0)).toBeUndefined();
  });

  it("binds the sessionKey to the grant (token carries scope identity, not the caller)", () => {
    const a = mintAttachGrant({ sessionKey: "agent:main:telegram:1", nowMs: T0 });
    const b = mintAttachGrant({ sessionKey: "agent:main:telegram:2", nowMs: T0 });
    expect(resolveAttachGrant(a.token, T0)?.sessionKey).toBe("agent:main:telegram:1");
    expect(resolveAttachGrant(b.token, T0)?.sessionKey).toBe("agent:main:telegram:2");
    expect(a.token).not.toBe(b.token);
  });

  it("revokes by token", () => {
    const g = mintAttachGrant({ sessionKey: "agent:main:x", nowMs: T0 });
    expect(revokeAttachGrant(g.token)).toBe(true);
    expect(resolveAttachGrant(g.token, T0)).toBeUndefined();
    expect(revokeAttachGrant(g.token)).toBe(false);
  });

  it("revokes all grants for a session", () => {
    mintAttachGrant({ sessionKey: "agent:main:x", nowMs: T0 });
    mintAttachGrant({ sessionKey: "agent:main:x", nowMs: T0 });
    mintAttachGrant({ sessionKey: "agent:main:y", nowMs: T0 });
    expect(revokeAttachGrantsForSession("agent:main:x")).toBe(2);
    expect(attachGrantStoreSize()).toBe(1);
  });

  it("clamps TTL: default for non-positive, ceiling at 12h", () => {
    const def = mintAttachGrant({ sessionKey: "s", nowMs: T0 });
    expect(def.expiresAtMs).toBe(T0 + 60 * 60 * 1000);
    const zero = mintAttachGrant({ sessionKey: "s", ttlMs: 0, nowMs: T0 });
    expect(zero.expiresAtMs).toBe(T0 + 60 * 60 * 1000);
    const huge = mintAttachGrant({ sessionKey: "s", ttlMs: 999 * 60 * 60 * 1000, nowMs: T0 });
    expect(huge.expiresAtMs).toBe(T0 + 12 * 60 * 60 * 1000);
  });

  it("sweeps expired grants", () => {
    mintAttachGrant({ sessionKey: "s", ttlMs: 1_000, nowMs: T0 });
    mintAttachGrant({ sessionKey: "s", ttlMs: 5_000, nowMs: T0 });
    expect(sweepExpiredAttachGrants(T0 + 2_000)).toBe(1);
    expect(attachGrantStoreSize()).toBe(1);
  });

  it("evicts expired grants on mint, bounding the store (no accumulation)", () => {
    mintAttachGrant({ sessionKey: "s", ttlMs: 1_000, nowMs: T0 });
    expect(attachGrantStoreSize()).toBe(1);
    mintAttachGrant({ sessionKey: "s", ttlMs: 1_000, nowMs: T0 + 5_000 });
    expect(attachGrantStoreSize()).toBe(1);
  });
});
