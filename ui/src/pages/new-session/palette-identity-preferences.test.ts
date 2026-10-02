import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { acquirePaletteIdentityPreferences } from "./palette-identity-preferences.ts";

function fixture(isCurrent = () => true) {
  const firstWrite = createDeferred();
  const entries: Record<string, unknown> = { "new-session.v1:main": { folder: "/normal" } };
  const writes: Record<string, unknown>[] = [];
  const request = vi.fn(async (method: string, params?: { entries?: Record<string, unknown> }) => {
    if (method === "users.prefs.get") {
      return { status: "ok", entries: structuredClone(entries) };
    }
    if (method === "users.prefs.set") {
      const patch = params?.entries ?? {};
      writes.push(patch);
      if (writes.length === 1) {
        await firstWrite.promise;
      }
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) {
          delete entries[key];
        } else {
          entries[key] = value;
        }
      }
      return { status: "ok" };
    }
    throw new Error(method);
  });
  const owner = {
    client: { request } as unknown as GatewayBrowserClient,
    hello: {},
    gatewayUrl: "ws://gateway.example",
    profileId: "alice",
  };
  const state = acquirePaletteIdentityPreferences(owner);
  const stop = state.subscribe(() => {}, isCurrent);
  return { owner, state, entries, writes, release: firstWrite.resolve, stop };
}

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("palette identity preferences", () => {
  it("reads only its key and never migrates or writes ordinary defaults", async () => {
    const { state, entries, writes, release, stop } = fixture();
    try {
      await vi.waitFor(() => expect(state.mode).toBe("remote"));
      expect(state.palettePreference).toBeNull();
      expect(writes).toEqual([]);
      expect(entries).toEqual({ "new-session.v1:main": { folder: "/normal" } });
    } finally {
      release();
      stop();
    }
  });

  it("drops a queued write when its authenticated surface loses every current binding", async () => {
    let current = true;
    const { state, writes, release, stop } = fixture(() => current);
    try {
      await vi.waitFor(() => expect(state.mode).toBe("remote"));
      const first = state.setPalettePreference({ agentId: "first", selection: {} }, () => true);
      const second = state.setPalettePreference(
        { agentId: "retired", selection: {} },
        () => current,
      );
      await vi.waitFor(() => expect(writes).toHaveLength(1));
      current = false;
      release();
      expect(await first).toBe(true);
      expect(await second).toBe(false);
      expect(writes).toHaveLength(1);
    } finally {
      release();
      stop();
    }
  });

  it("rejects new intent from a stale initiator even when another binding remains current", async () => {
    const { state, writes, release, stop } = fixture();
    try {
      await vi.waitFor(() => expect(state.mode).toBe("remote"));
      expect(
        await state.setPalettePreference({ agentId: "stale", selection: {} }, () => false),
      ).toBe(false);
      expect(writes).toEqual([]);
    } finally {
      release();
      stop();
    }
  });

  it("shares a live handshake but never shares state with another profile or handshake", async () => {
    const { owner, state, release, stop } = fixture();
    try {
      expect(acquirePaletteIdentityPreferences(owner)).toBe(state);
      expect(acquirePaletteIdentityPreferences({ ...owner, hello: {} })).not.toBe(state);
      expect(acquirePaletteIdentityPreferences({ ...owner, profileId: "bob" })).not.toBe(state);
    } finally {
      release();
      stop();
    }
  });

  it("publishes a confirmed write to surviving current subscribers, not a retired initiator", async () => {
    const { state, writes, release, stop } = fixture();
    let current = true;
    const retired = vi.fn();
    const surviving = vi.fn();
    const stopRetired = state.subscribe(retired, () => current);
    const stopSurviving = state.subscribe(surviving, () => true);
    try {
      await vi.waitFor(() => expect(state.mode).toBe("remote"));
      retired.mockClear();
      surviving.mockClear();
      const saved = state.setPalettePreference(
        { agentId: "main", selection: { worktree: true } },
        () => current,
      );
      await vi.waitFor(() => expect(writes).toHaveLength(1));
      current = false;
      release();
      expect(await saved).toBe(true);
      expect(surviving).toHaveBeenCalledWith("changed");
      expect(retired).not.toHaveBeenCalled();
    } finally {
      release();
      stopRetired();
      stopSurviving();
      stop();
    }
  });
});
