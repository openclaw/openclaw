import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSession,
  deleteSessionsAndRefresh,
  loadSessions,
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

function createState(request?: RequestFn, overrides: Partial<SessionsState> = {}): SessionsState {
  return {
    client: request ? ({ request } as unknown as SessionsState["client"]) : null,
    connected: true,
    sessionsLoading: false,
    sessionsResult: null,
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
      includeDerivedTitles: true,
      includeLastMessage: true,
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
});

describe("createSession", () => {
  it("creates a dashboard chat session and refreshes sessions", async () => {
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "sessions.create") {
        expect(params).toEqual({
          agentId: "main",
          parentSessionKey: "main",
        });
        return { key: "agent:main:dashboard:session-1" };
      }
      if (method === "sessions.list") {
        return {
          ts: 0,
          path: "",
          count: 1,
          defaults: { modelProvider: null, model: null, contextTokens: null },
          sessions: [{ key: "agent:main:dashboard:session-1", kind: "direct", updatedAt: null }],
        };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const state = createState(request);

    const key = await createSession(state, {
      agentId: "main",
      parentSessionKey: "main",
    });

    expect(key).toBe("agent:main:dashboard:session-1");
    expect(request).toHaveBeenNthCalledWith(1, "sessions.create", {
      agentId: "main",
      parentSessionKey: "main",
    });
    expect(request).toHaveBeenNthCalledWith(2, "sessions.list", {
      includeGlobal: true,
      includeUnknown: true,
      includeDerivedTitles: true,
      includeLastMessage: true,
    });
  });

  it("stores the error and returns null when create fails", async () => {
    const state = createState();
    state.client = {
      request: vi.fn(async (method: string) => {
        if (method === "sessions.create") {
          throw new Error("nope");
        }
        return {};
      }),
    } as unknown as NonNullable<SessionsState["client"]>;

    const key = await createSession(state);

    expect(key).toBeNull();
    expect(state.sessionsError).toContain("nope");
  });
});

describe("loadSessions", () => {
  it("requests derived titles and last-message previews by default", async () => {
    const request = vi.fn(async () => ({
      ts: 0,
      path: "",
      count: 0,
      defaults: { modelProvider: null, model: null, contextTokens: null },
      sessions: [],
    }));
    const state = createState(request);

    await loadSessions(state);

    expect(request).toHaveBeenCalledWith("sessions.list", {
      includeGlobal: true,
      includeUnknown: true,
      includeDerivedTitles: true,
      includeLastMessage: true,
    });
  });
});
