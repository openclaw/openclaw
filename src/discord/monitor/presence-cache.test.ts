import { type GatewayPresenceUpdate, PresenceUpdateStatus } from "discord-api-types/v10";
import { afterEach, describe, expect, it } from "vitest";
import { clearPresences, getPresence, presenceCacheSize, setPresence } from "./presence-cache.js";

function makePresence(
  userId: string,
  status: PresenceUpdateStatus = PresenceUpdateStatus.Online,
): GatewayPresenceUpdate {
  return {
    user: { id: userId },
    status,
    activities: [],
    client_status: {},
  } as unknown as GatewayPresenceUpdate;
}

describe("presence-cache", () => {
  afterEach(() => {
    clearPresences();
  });

  it("stores and retrieves presence by account and user", () => {
    const presence = makePresence("u1");
    setPresence("acc1", "u1", presence);
    expect(getPresence("acc1", "u1")).toBe(presence);
  });

  it("returns undefined for unknown user", () => {
    expect(getPresence("acc1", "u1")).toBeUndefined();
  });

  it("returns undefined for unknown account", () => {
    setPresence("acc1", "u1", makePresence("u1"));
    expect(getPresence("acc2", "u1")).toBeUndefined();
  });

  it("uses 'default' key when accountId is undefined", () => {
    const presence = makePresence("u1");
    setPresence(undefined, "u1", presence);
    expect(getPresence(undefined, "u1")).toBe(presence);
  });

  it("overwrites existing presence for the same user", () => {
    setPresence("acc1", "u1", makePresence("u1", PresenceUpdateStatus.Online));
    const updated = makePresence("u1", PresenceUpdateStatus.Idle);
    setPresence("acc1", "u1", updated);
    expect(getPresence("acc1", "u1")).toBe(updated);
    expect(presenceCacheSize()).toBe(1);
  });

  it("tracks total cache size across accounts", () => {
    setPresence("acc1", "u1", makePresence("u1"));
    setPresence("acc1", "u2", makePresence("u2"));
    setPresence("acc2", "u3", makePresence("u3"));
    expect(presenceCacheSize()).toBe(3);
  });

  it("clears all presences when no accountId given", () => {
    setPresence("acc1", "u1", makePresence("u1"));
    setPresence("acc2", "u2", makePresence("u2"));
    clearPresences();
    expect(presenceCacheSize()).toBe(0);
  });

  it("clears only the specified account", () => {
    setPresence("acc1", "u1", makePresence("u1"));
    setPresence("acc2", "u2", makePresence("u2"));
    clearPresences("acc1");
    expect(getPresence("acc1", "u1")).toBeUndefined();
    expect(getPresence("acc2", "u2")).toBeDefined();
    expect(presenceCacheSize()).toBe(1);
  });

  it("evicts oldest entry when exceeding max cache size", () => {
    const limit = 5000;
    for (let i = 0; i < limit + 1; i++) {
      setPresence("acc1", `u${i}`, makePresence(`u${i}`));
    }
    // First entry should have been evicted
    expect(getPresence("acc1", "u0")).toBeUndefined();
    // Last entry should exist
    expect(getPresence("acc1", `u${limit}`)).toBeDefined();
    expect(presenceCacheSize()).toBe(limit);
  });
});
