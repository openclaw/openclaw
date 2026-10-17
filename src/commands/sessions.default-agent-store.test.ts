// Sessions default-agent store tests cover default session-store selection and runtime config loading.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSelectionRequiredError } from "../agents/agent-scope-config.js";
import { retainLegacyDefaultAgentId } from "../config/legacy.default-agent-owner.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const loadConfigMock = vi.hoisted(() => vi.fn());

const resolveStorePathMock = vi.hoisted(() =>
  vi.fn((_store: string | undefined, opts?: { agentId?: string }) => {
    return `/tmp/sessions-${opts?.agentId ?? "missing"}.json`;
  }),
);
const listSessionEntriesMock = vi.hoisted(() =>
  vi.fn<() => Array<{ sessionKey: string; entry: Record<string, unknown> }>>(() => []),
);

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    getRuntimeConfig: loadConfigMock,
    loadConfig: loadConfigMock,
    captureRuntimeConfigAsyncReader:
      (...args: Parameters<typeof loadConfigMock>) =>
      async () =>
        loadConfigMock(...args),
  };
});

vi.mock("../config/sessions.js", async () => {
  const actual =
    await vi.importActual<typeof import("../config/sessions.js")>("../config/sessions.js");
  return {
    ...actual,
    resolveSessionStorePathCore: resolveStorePathMock,
  };
});

vi.mock("../config/sessions/session-accessor.js", () => ({
  listSessionEntriesCore: listSessionEntriesMock,
  listSessionEntriesReadOnly: listSessionEntriesMock,
}));

import { sessionsCommand } from "./sessions.js";

function sessionRows(rows: Array<[string, string, number]>, model?: string) {
  return rows.map(([sessionKey, sessionId, updatedAt]) => ({
    sessionKey,
    entry: { sessionId, updatedAt, ...(model ? { model } : {}) },
  }));
}

function createSessionsConfig(store = "/tmp/sessions-{agentId}.json") {
  return {
    agents: {
      ownership: "explicit" as const,
      defaults: {
        systemAgent: { agentId: "voice" },
        model: { primary: "test:opus" },
        models: { "test:opus": {} },
      },
      entries: { main: {}, voice: {} },
    },
    session: { store },
  };
}

describe("sessionsCommand default store agent selection", () => {
  let runtime: ReturnType<typeof createTestRuntime>;
  function readJsonOutput() {
    const output = runtime.log.mock.calls[0]?.[0];
    if (typeof output !== "string") {
      throw new Error("Expected session JSON output to be a string");
    }
    return JSON.parse(output);
  }
  beforeEach(() => {
    vi.clearAllMocks();
    runtime = createTestRuntime();
    loadConfigMock.mockImplementation(() => createSessionsConfig());
    resolveStorePathMock.mockImplementation(
      (_store: string | undefined, opts?: { agentId?: string }) =>
        `/tmp/sessions-${opts?.agentId ?? "missing"}.json`,
    );
    listSessionEntriesMock.mockImplementation(() => []);
  });

  it("lists each SQLite owner when --all-agents resolves to a shared store path", async () => {
    loadConfigMock.mockImplementation(() => createSessionsConfig("/tmp/shared-sessions.json"));
    listSessionEntriesMock.mockReset();
    listSessionEntriesMock
      .mockReturnValueOnce(
        sessionRows([["agent:main:room", "s1", Date.now() - 60_000]], "test:opus"),
      )
      .mockReturnValueOnce(
        sessionRows([["agent:voice:room", "s2", Date.now() - 30_000]], "test:opus"),
      );

    await sessionsCommand({ allAgents: true, json: true }, runtime);

    const payload = readJsonOutput();
    expect(payload).toMatchObject({ count: 2, allAgents: true });
    expect(payload.stores).toEqual([
      { agentId: "main", path: "/tmp/shared-sessions.sqlite" },
      { agentId: "voice", path: "/tmp/shared-sessions.voice.sqlite" },
    ]);
    expect(
      payload.sessions.map((session: { agentId: string }) => session.agentId).toSorted(),
    ).toEqual(["main", "voice"]);
    expect(listSessionEntriesMock).toHaveBeenCalledTimes(2);
  });

  it("applies a global active limit while preserving store order for tied timestamps", async () => {
    const now = Date.now();
    listSessionEntriesMock
      .mockReturnValueOnce(
        sessionRows([
          ["agent:main:tie", "main-tie", now - 60_000],
          ["agent:main:old", "main-old", now - 180_000],
        ]),
      )
      .mockReturnValueOnce(
        sessionRows([
          ["agent:voice:tie", "voice-tie", now - 60_000],
          ["agent:voice:newest", "voice-newest", now - 30_000],
        ]),
      );

    await sessionsCommand({ allAgents: true, json: true, active: "2", limit: 2 }, runtime);

    expect(readJsonOutput()).toMatchObject({
      count: 2,
      totalCount: 3,
      hasMore: true,
      limitApplied: 2,
      activeMinutes: 2,
      sessions: [
        { key: "agent:voice:newest", agentId: "voice" },
        { key: "agent:main:tie", agentId: "main" },
      ],
    });
  });

  it("requires session-list selection without a designation", async () => {
    loadConfigMock.mockReturnValue(
      retainLegacyDefaultAgentId(
        {
          agents: {
            ownership: "explicit",
            entries: { main: {}, helper: {}, third: {} },
          },
        },
        undefined,
      ),
    );

    const result = sessionsCommand({}, runtime);
    await expect(result).rejects.toBeInstanceOf(AgentSelectionRequiredError);
    await expect(result).rejects.toMatchObject({
      message:
        "Multiple agents are configured, but session-store selection has no explicit owner. Pass --agent <id> to select one agent, or --all-agents to include every configured agent.",
    });
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
    expect(listSessionEntriesMock).not.toHaveBeenCalled();
  });

  it("uses all configured agent stores with --all-agents", async () => {
    listSessionEntriesMock.mockReset();
    listSessionEntriesMock
      .mockReturnValueOnce(sessionRows([["main_row", "s1", Date.now() - 60_000]], "test:opus"))
      .mockReturnValueOnce([]);

    await sessionsCommand({ allAgents: true }, runtime);

    expect(listSessionEntriesMock).toHaveBeenNthCalledWith(1, {
      agentId: "main",
      storePath: "/tmp/sessions-main.json",
      projection: "list",
    });
    expect(listSessionEntriesMock).toHaveBeenNthCalledWith(2, {
      agentId: "voice",
      storePath: "/tmp/sessions-voice.json",
      projection: "list",
    });
    expect(runtime.log.mock.calls[0]?.[0]).toContain("Session stores: 2 (main, voice)");
    expect(runtime.log.mock.calls[2]?.[0]).toContain("Agent");
  });
});
