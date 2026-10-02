import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { acquirePaletteIdentityPreferences } from "./palette-identity-preferences.ts";
import { PALETTE_PREFERENCE_KEY } from "./preferences.ts";

function fixture(isCurrent = () => true) {
  let release!: () => void;
  const firstWrite = new Promise<void>((resolve) => {
    release = resolve;
  });
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
        await firstWrite;
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
  return { owner, state, entries, request, writes, release, stop };
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

  it("serializes palette set/delete without overwriting a concurrent ordinary preference update", async () => {
    const { state, entries, writes, release, stop } = fixture();
    try {
      await vi.waitFor(() => expect(state.mode).toBe("remote"));
      const remembered = state.setPalettePreference(
        { agentId: "other", selection: { worktree: true } },
        () => true,
      );
      const cleared = state.setPalettePreference(null, () => true);
      await vi.waitFor(() => expect(writes).toHaveLength(1));
      entries["new-session.v1:main"] = { folder: "/new-normal", model: "example/model" };
      release();
      expect(await remembered).toBe(true);
      expect(await cleared).toBe(true);
      expect(writes).toEqual([
        { [PALETTE_PREFERENCE_KEY]: { agentId: "other", selection: { worktree: true } } },
        { [PALETTE_PREFERENCE_KEY]: null },
      ]);
      expect(entries).toEqual({
        "new-session.v1:main": { folder: "/new-normal", model: "example/model" },
      });
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

  it("keeps the dispatched write queue through disposal and a same-owner remount", async () => {
    let current = true;
    const { owner, state, writes, release, stop } = fixture(() => current);
    let stopReplacement = () => {};
    try {
      await vi.waitFor(() => expect(state.mode).toBe("remote"));
      const first = state.setPalettePreference({ agentId: "first", selection: {} }, () => current);
      const queued = state.setPalettePreference(
        { agentId: "queued", selection: {} },
        () => current,
      );
      await vi.waitFor(() => expect(writes).toHaveLength(1));
      current = false;
      stop();
      const replacement = acquirePaletteIdentityPreferences(owner);
      expect(replacement).toBe(state);
      stopReplacement = replacement.subscribe(
        () => {},
        () => true,
      );
      const second = replacement.setPalettePreference(
        { agentId: "second", selection: {} },
        () => true,
      );
      await Promise.resolve();
      expect(writes).toHaveLength(1);
      release();
      expect(await first).toBe(true);
      expect(await queued).toBe(true);
      expect(await second).toBe(true);
      expect(writes).toHaveLength(3);
      expect(replacement.palettePreference?.agentId).toBe("second");
    } finally {
      release();
      stopReplacement();
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
