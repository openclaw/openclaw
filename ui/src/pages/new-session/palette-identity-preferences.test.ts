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
  it("scopes its cache and reads without migrating or writing ordinary defaults", async () => {
    const { owner, state, entries, writes, release, stop } = fixture();
    try {
      await vi.waitFor(() => expect(state.mode).toBe("remote"));
      expect(acquirePaletteIdentityPreferences(owner)).toBe(state);
      expect(acquirePaletteIdentityPreferences({ ...owner, hello: {} })).not.toBe(state);
      expect(acquirePaletteIdentityPreferences({ ...owner, profileId: "bob" })).not.toBe(state);
      expect(state.palettePreference).toBeNull();
      expect(writes).toEqual([]);
      expect(entries).toEqual({ "new-session.v1:main": { folder: "/normal" } });
    } finally {
      release();
      stop();
    }
  });

  it.each(["queued", "new"] as const)(
    "rejects %s intent after its authority retires",
    async (phase) => {
      let current = true;
      const { state, writes, release, stop } = fixture(() => phase === "new" || current);
      try {
        await vi.waitFor(() => expect(state.mode).toBe("remote"));
        if (phase === "new") {
          current = false;
        }
        const first =
          phase === "queued"
            ? state.setPalettePreference({ agentId: "first", selection: {} }, () => true)
            : undefined;
        const rejected = state.setPalettePreference(
          { agentId: "retired", selection: {} },
          () => current,
        );
        if (first) {
          await vi.waitFor(() => expect(writes).toHaveLength(1));
          current = false;
          release();
          expect(await first).toBe(true);
        }
        expect(await rejected).toBe(false);
        expect(writes).toHaveLength(phase === "queued" ? 1 : 0);
      } finally {
        release();
        stop();
      }
    },
  );

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
