import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiSettings } from "../storage.ts";
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

function createSettings(overrides: Partial<UiSettings> = {}): UiSettings {
  return {
    gatewayUrl: "",
    token: "",
    sessionKey: "main",
    lastActiveSessionKey: "main",
    theme: "claw",
    themeMode: "dark",
    chatFocusMode: false,
    chatShowThinking: true,
    chatShowToolCalls: true,
    splitRatio: 0.6,
    navCollapsed: false,
    navWidth: 280,
    navGroupsCollapsed: {},
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
  it("switches away from a missing direct session after refresh", async () => {
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
    const applySettings = vi.fn();
    const state = createState(request, {
      sessionKey: "agent:main:discord:channel:123",
      settings: createSettings({
        sessionKey: "agent:main:discord:channel:123",
        lastActiveSessionKey: "agent:main:discord:channel:123",
      }),
      applySettings,
    });

    await loadSessions(state);

    expect(state.sessionKey).toBe("main");
    expect(applySettings).toHaveBeenCalledWith({
      sessionKey: "main",
      lastActiveSessionKey: "main",
    });
  });

  it("preserves missing grouped sessions so ephemeral subagent selections stay visible", async () => {
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
    const applySettings = vi.fn();
    const state = createState(request, {
      sessionKey: "agent:main:subagent:child",
      settings: createSettings({
        sessionKey: "agent:main:subagent:child",
        lastActiveSessionKey: "agent:main:subagent:child",
      }),
      applySettings,
    });

    await loadSessions(state);

    expect(state.sessionKey).toBe("agent:main:subagent:child");
    expect(applySettings).not.toHaveBeenCalled();
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
