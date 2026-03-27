import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionsListResult } from "../types.ts";
import {
  buildSessionsListLastHashParamsKey,
  deleteSessionsAndRefresh,
  loadSessions,
  patchSession,
  subscribeSessions,
  type SessionsState,
} from "./sessions.ts";

type RequestFn = (method: string, params?: unknown) => Promise<unknown>;

if (!("window" in globalThis)) {
  Object.assign(globalThis, {
    window: {
      confirm: () => false,
    },
  });
}

function createState(request: RequestFn, overrides: Partial<SessionsState> = {}): SessionsState {
  return {
    client: { request } as unknown as SessionsState["client"],
    connected: true,
    sessionsLoading: false,
    sessionsResult: null,
    sessionsListLastHash: null,
    sessionsListLastHashParamsKey: null,
    sessionsError: null,
    sessionsFilterActive: "0",
    sessionsFilterLimit: "0",
    sessionsIncludeGlobal: true,
    sessionsIncludeUnknown: true,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("loadSessions", () => {
  it("sends lastHash when params match sessionsListLastHashParamsKey", async () => {
    const request = vi.fn(async () => ({ unchanged: true, hash: "abc123", ts: 1, count: 0 }));
    const paramsKey = buildSessionsListLastHashParamsKey({
      includeGlobal: true,
      includeUnknown: true,
    });
    const state = createState(request, {
      sessionsListLastHash: "abc123",
      sessionsListLastHashParamsKey: paramsKey,
    });

    await loadSessions(state);

    expect(request).toHaveBeenCalledWith(
      "sessions.list",
      expect.objectContaining({
        includeGlobal: true,
        includeUnknown: true,
        lastHash: "abc123",
      }),
    );
    expect(state.sessionsListLastHash).toBe("abc123");
    expect(state.sessionsListLastHashParamsKey).toBe(paramsKey);
  });

  it("preserves sessionsResult rows and applies count when server returns unchanged", async () => {
    const existing: SessionsListResult = {
      ts: 1,
      path: "p",
      count: 1,
      defaults: { modelProvider: null, model: null, contextTokens: null },
      sessions: [{ key: "k", kind: "direct", updatedAt: 1 }],
    };
    const request = vi.fn(async () => ({ unchanged: true, hash: "next", ts: 2, count: 7 }));
    const paramsKey = buildSessionsListLastHashParamsKey({
      includeGlobal: true,
      includeUnknown: true,
    });
    const state = createState(request, {
      sessionsResult: existing,
      sessionsListLastHash: "old",
      sessionsListLastHashParamsKey: paramsKey,
    });

    await loadSessions(state);

    expect(state.sessionsResult).not.toBe(existing);
    expect(state.sessionsResult).toEqual({ ...existing, count: 7 });
    expect(state.sessionsResult?.count).toBe(7);
    expect(state.sessionsListLastHash).toBe("next");
  });

  it("includes activeMinutes in the unchanged-key path so stale hashes are not reused", async () => {
    const base = buildSessionsListLastHashParamsKey({
      includeGlobal: true,
      includeUnknown: true,
      activeMinutes: 15,
    });
    const next = buildSessionsListLastHashParamsKey({
      includeGlobal: true,
      includeUnknown: true,
      activeMinutes: 30,
    });
    expect(base).not.toBe(next);
  });

  it("replaces sessionsResult and hash on full list payload", async () => {
    const full: SessionsListResult & { hash?: string } = {
      ts: 1,
      path: "p",
      count: 1,
      defaults: { modelProvider: null, model: null, contextTokens: null },
      sessions: [{ key: "k", kind: "direct", updatedAt: 1 }],
      hash: "fullhash",
    };
    const request = vi.fn(async () => full);
    const state = createState(request);

    await loadSessions(state);

    expect(state.sessionsResult).toEqual(full);
    expect(state.sessionsListLastHash).toBe("fullhash");
    expect(state.sessionsListLastHashParamsKey).toBe(
      buildSessionsListLastHashParamsKey({ includeGlobal: true, includeUnknown: true }),
    );
  });

  it("clears lastHash tracking on error", async () => {
    const request = vi.fn(async () => {
      throw new Error("network");
    });
    const state = createState(request, {
      sessionsListLastHash: "x",
      sessionsListLastHashParamsKey: "y",
    });

    await loadSessions(state);

    expect(state.sessionsListLastHash).toBeNull();
    expect(state.sessionsListLastHashParamsKey).toBeNull();
    expect(state.sessionsError).toBe("Error: network");
  });
});

describe("subscribeSessions", () => {
  it("registers for session change events", async () => {
    const request = vi.fn(async () => ({ subscribed: true }));
    const state = createState(request);

    await subscribeSessions(state);

    expect(request).toHaveBeenCalledWith("sessions.subscribe", {});
    expect(state.sessionsError).toBeNull();
  });
});

describe("deleteSessionsAndRefresh", () => {
  it("deletes multiple sessions and refreshes", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.delete") {
        return { ok: true };
      }
      if (method === "sessions.list") {
        return undefined;
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const state = createState(request);
    vi.spyOn(window, "confirm").mockReturnValue(true);

    const deleted = await deleteSessionsAndRefresh(state, ["key-a", "key-b"]);

    expect(deleted).toEqual(["key-a", "key-b"]);
    expect(request).toHaveBeenCalledTimes(3);
    expect(request).toHaveBeenNthCalledWith(1, "sessions.delete", {
      key: "key-a",
      deleteTranscript: true,
    });
    expect(request).toHaveBeenNthCalledWith(2, "sessions.delete", {
      key: "key-b",
      deleteTranscript: true,
    });
    expect(request).toHaveBeenNthCalledWith(3, "sessions.list", {
      includeGlobal: true,
      includeUnknown: true,
    });
    expect(state.sessionsLoading).toBe(false);
  });

  it("returns empty array when user cancels", async () => {
    const request = vi.fn(async () => undefined);
    const state = createState(request);
    vi.spyOn(window, "confirm").mockReturnValue(false);

    const deleted = await deleteSessionsAndRefresh(state, ["key-a"]);

    expect(deleted).toEqual([]);
    expect(request).not.toHaveBeenCalled();
  });

  it("returns partial results when some deletes fail", async () => {
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "sessions.delete") {
        const p = params as { key: string };
        if (p.key === "key-b" || p.key === "key-c") {
          throw new Error(`delete failed: ${p.key}`);
        }
        return { ok: true };
      }
      if (method === "sessions.list") {
        return undefined;
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const state = createState(request);
    vi.spyOn(window, "confirm").mockReturnValue(true);

    const deleted = await deleteSessionsAndRefresh(state, ["key-a", "key-b", "key-c", "key-d"]);

    expect(deleted).toEqual(["key-a", "key-d"]);
    expect(state.sessionsError).toBe("Error: delete failed: key-b; Error: delete failed: key-c");
    expect(state.sessionsLoading).toBe(false);
  });

  it("returns empty array when already loading", async () => {
    const request = vi.fn(async () => undefined);
    const state = createState(request, { sessionsLoading: true });

    const deleted = await deleteSessionsAndRefresh(state, ["key-a"]);

    expect(deleted).toEqual([]);
    expect(request).not.toHaveBeenCalled();
  });

  it("clears lastHash before post-delete refresh", async () => {
    const request: RequestFn = vi.fn(async (method: string) => {
      if (method === "sessions.delete") {
        return { ok: true };
      }
      if (method === "sessions.list") {
        return {
          ts: 1,
          path: "p",
          count: 0,
          defaults: { modelProvider: null, model: null, contextTokens: null },
          sessions: [],
          hash: "fresh",
        };
      }
      throw new Error(`unexpected: ${method}`);
    });
    const paramsKey = buildSessionsListLastHashParamsKey({
      includeGlobal: true,
      includeUnknown: true,
    });
    const state = createState(request, {
      sessionsListLastHash: "stale",
      sessionsListLastHashParamsKey: paramsKey,
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);

    await deleteSessionsAndRefresh(state, ["key-a"]);

    // The sessions.list call after delete should NOT include the stale lastHash.
    const listCall = vi.mocked(request).mock.calls.find(([m]) => m === "sessions.list");
    expect(listCall).toBeDefined();
    expect((listCall![1] as Record<string, unknown>)?.lastHash).toBeUndefined();
  });
});

describe("patchSession", () => {
  it("clears lastHash before post-patch refresh", async () => {
    const request: RequestFn = vi.fn(async (method: string) => {
      if (method === "sessions.patch") {
        return { ok: true };
      }
      if (method === "sessions.list") {
        return {
          ts: 1,
          path: "p",
          count: 0,
          defaults: { modelProvider: null, model: null, contextTokens: null },
          sessions: [],
          hash: "fresh",
        };
      }
      throw new Error(`unexpected: ${method}`);
    });
    const paramsKey = buildSessionsListLastHashParamsKey({
      includeGlobal: true,
      includeUnknown: true,
    });
    const state = createState(request, {
      sessionsListLastHash: "stale",
      sessionsListLastHashParamsKey: paramsKey,
    });

    await patchSession(state, "key-a", { label: "renamed" });

    const listCall = vi.mocked(request).mock.calls.find(([m]) => m === "sessions.list");
    expect(listCall).toBeDefined();
    expect((listCall![1] as Record<string, unknown>)?.lastHash).toBeUndefined();
  });
});
