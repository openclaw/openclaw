import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionsListResult } from "../types.ts";
import {
  deleteSession,
  deleteSessionAndRefresh,
  loadSessions,
  type SessionsState,
} from "./sessions.ts";

type RequestFn = (method: string, params?: unknown) => Promise<unknown>;

function createState(request: RequestFn, overrides: Partial<SessionsState> = {}): SessionsState {
  return {
    client: { request } as unknown as SessionsState["client"],
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

describe("deleteSessionAndRefresh", () => {
  it("refreshes sessions after a successful delete", async () => {
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

    const deleted = await deleteSessionAndRefresh(state, "agent:main:test");

    expect(deleted).toBe(true);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenNthCalledWith(1, "sessions.delete", {
      key: "agent:main:test",
      deleteTranscript: true,
    });
    expect(request).toHaveBeenNthCalledWith(2, "sessions.list", {
      includeGlobal: true,
      includeUnknown: true,
    });
    expect(state.sessionsError).toBeNull();
    expect(state.sessionsLoading).toBe(false);
  });

  it("does not refresh sessions when user cancels delete", async () => {
    const request = vi.fn(async () => undefined);
    const state = createState(request, { sessionsError: "existing error" });
    vi.spyOn(window, "confirm").mockReturnValue(false);

    const deleted = await deleteSessionAndRefresh(state, "agent:main:test");

    expect(deleted).toBe(false);
    expect(request).not.toHaveBeenCalled();
    expect(state.sessionsError).toBe("existing error");
    expect(state.sessionsLoading).toBe(false);
  });

  it("does not refresh sessions when delete fails and preserves the delete error", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.delete") {
        throw new Error("delete boom");
      }
      if (method === "sessions.list") {
        return undefined;
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const state = createState(request);
    vi.spyOn(window, "confirm").mockReturnValue(true);

    const deleted = await deleteSessionAndRefresh(state, "agent:main:test");

    expect(deleted).toBe(false);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("sessions.delete", {
      key: "agent:main:test",
      deleteTranscript: true,
    });
    expect(state.sessionsError).toContain("delete boom");
    expect(state.sessionsLoading).toBe(false);
  });
});

describe("loadSessions", () => {
  it("refreshes sessions without rewriting the active selection", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.list") {
        return {
          ts: 0,
          path: "",
          count: 1,
          defaults: { modelProvider: null, model: null, contextTokens: null },
          sessions: [{ key: "main", kind: "direct", updatedAt: null }],
        };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const state = createState(request) as SessionsState & { sessionKey?: string };
    state.sessionKey = "agent:main:discord:channel:123";

    await loadSessions(state);

    expect(state.sessionKey).toBe("agent:main:discord:channel:123");
  });

  it("does not overwrite the chat snapshot for filtered refreshes by default", async () => {
    const filtered: SessionsListResult = {
      ts: 0,
      path: "",
      count: 1,
      defaults: { modelProvider: null, model: null, contextTokens: null },
      sessions: [{ key: "main", kind: "direct", updatedAt: null }],
    };
    const existingChatSnapshot: SessionsListResult = {
      ts: 1,
      path: "",
      count: 2,
      defaults: { modelProvider: null, model: null, contextTokens: null },
      sessions: [
        { key: "main", kind: "direct", updatedAt: null },
        { key: "agent:main:discord:channel:123", kind: "direct", updatedAt: null },
      ],
    };
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.list") {
        return filtered;
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const state = createState(request, {
      chatSessionsResult: existingChatSnapshot,
    });

    await loadSessions(state, { activeMinutes: 120 });

    expect(state.sessionsResult).toEqual(filtered);
    expect(state.chatSessionsResult).toEqual(existingChatSnapshot);
  });

  it("updates the chat snapshot when a chat-driven refresh asks for it", async () => {
    const filtered: SessionsListResult = {
      ts: 0,
      path: "",
      count: 1,
      defaults: { modelProvider: null, model: null, contextTokens: null },
      sessions: [{ key: "main", kind: "direct", updatedAt: null }],
    };
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.list") {
        return filtered;
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const state = createState(request, {
      chatSessionsResult: {
        ts: 1,
        path: "",
        count: 2,
        defaults: { modelProvider: null, model: null, contextTokens: null },
        sessions: [
          { key: "main", kind: "direct", updatedAt: null },
          { key: "agent:main:discord:channel:123", kind: "direct", updatedAt: null },
        ],
      },
    });

    await loadSessions(state, { activeMinutes: 120, syncChatSnapshot: true });

    expect(state.sessionsResult).toEqual(filtered);
    expect(state.chatSessionsResult).toEqual(filtered);
  });
});

describe("deleteSession", () => {
  it("returns false when already loading", async () => {
    const request = vi.fn(async () => undefined);
    const state = createState(request, { sessionsLoading: true });

    const deleted = await deleteSession(state, "agent:main:test");

    expect(deleted).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });
});
