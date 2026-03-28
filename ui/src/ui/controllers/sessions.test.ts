import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildControlUiSessionKey,
  createControlUiSession,
  createDefaultControlUiSessionLabel,
  deleteSessionsAndRefresh,
  patchSession,
  resolveNewControlUiSessionLabel,
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

describe("buildControlUiSessionKey", () => {
  it("builds a deterministic agent-scoped UI session key from the title", () => {
    const now = new Date(2026, 2, 27, 18, 42);
    const key = buildControlUiSessionKey({
      agentId: "Ops Agent",
      label: "Planning / Roadmap",
      now,
      randomSuffix: "a1b2",
    });

    expect(key).toBe("agent:ops-agent:ui:20260327-1842-planning-roadmap-a1b2");
  });
});

describe("createDefaultControlUiSessionLabel", () => {
  it("formats a stable fallback chat label", () => {
    expect(createDefaultControlUiSessionLabel(new Date(2026, 2, 27, 18, 42))).toBe(
      "Chat 2026-03-27 18:42",
    );
  });
});

describe("resolveNewControlUiSessionLabel", () => {
  it("returns null when the prompt is canceled", () => {
    expect(resolveNewControlUiSessionLabel(null)).toBeNull();
  });

  it("falls back to the generated chat label when the prompt is blank", () => {
    expect(resolveNewControlUiSessionLabel("   ", new Date(2026, 2, 27, 18, 42))).toBe(
      "Chat 2026-03-27 18:42",
    );
  });
});

describe("patchSession", () => {
  it("returns the patch result and refreshes sessions", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.patch") {
        return {
          ok: true,
          path: "",
          key: "agent:main:ui:20260327-1842-planning-a1b2",
          entry: { sessionId: "session-1" },
        };
      }
      if (method === "sessions.list") {
        return undefined;
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const state = createState(request);

    const result = await patchSession(state, "agent:main:ui:20260327-1842-planning-a1b2", {
      label: "Planning",
    });

    expect(result?.key).toBe("agent:main:ui:20260327-1842-planning-a1b2");
    expect(request).toHaveBeenNthCalledWith(1, "sessions.patch", {
      key: "agent:main:ui:20260327-1842-planning-a1b2",
      label: "Planning",
    });
    expect(request).toHaveBeenNthCalledWith(2, "sessions.list", {
      includeGlobal: true,
      includeUnknown: true,
    });
  });
});

describe("createControlUiSession", () => {
  it("creates a labeled UI session and refreshes the session list", async () => {
    const now = new Date(2026, 2, 27, 18, 42);
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.patch") {
        return {
          ok: true,
          path: "",
          key: "agent:main:ui:20260327-1842-planning-roadmap-a1b2",
          entry: { sessionId: "session-1" },
        };
      }
      if (method === "sessions.list") {
        return undefined;
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const state = createState(request);

    const result = await createControlUiSession(state, {
      agentId: "main",
      label: "Planning Roadmap",
      now,
      randomSuffix: "a1b2",
    });

    expect(result?.key).toBe("agent:main:ui:20260327-1842-planning-roadmap-a1b2");
    expect(request).toHaveBeenNthCalledWith(1, "sessions.patch", {
      key: "agent:main:ui:20260327-1842-planning-roadmap-a1b2",
      label: "Planning Roadmap",
    });
    expect(request).toHaveBeenNthCalledWith(2, "sessions.list", {
      includeGlobal: true,
      includeUnknown: true,
    });
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
});
