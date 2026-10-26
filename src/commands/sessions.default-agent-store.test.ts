import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSelectionRequiredError } from "../agents/agent-scope-config.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const loadConfigMock = vi.hoisted(() => vi.fn());

const listSessionEntriesMock = vi.hoisted(() =>
  vi.fn<() => Array<{ sessionKey: string; entry: Record<string, unknown> }>>(() => []),
);

vi.mock("../config/config.js", async (importOriginal) => {
  return {
    ...(await importOriginal<typeof import("../config/config.js")>()),
    getRuntimeConfig: loadConfigMock,
    loadConfig: loadConfigMock,
    captureRuntimeConfigAsyncReader:
      (...args: Parameters<typeof loadConfigMock>) =>
      async () =>
        loadConfigMock(...args),
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

function mockStores(...stores: ReturnType<typeof sessionRows>[]) {
  for (const rows of stores) {
    listSessionEntriesMock.mockReturnValueOnce(rows);
  }
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
    listSessionEntriesMock.mockImplementation(() => []);
  });

  it("lists each SQLite owner in JSON and human output for a shared store path", async () => {
    loadConfigMock.mockImplementation(() => createSessionsConfig("/tmp/shared-sessions.json"));
    const stores = [
      sessionRows([["agent:main:room", "s1", Date.now() - 60_000]], "test:opus"),
      sessionRows([["agent:voice:room", "s2", Date.now() - 30_000]], "test:opus"),
    ];
    listSessionEntriesMock.mockReset();
    mockStores(...stores);

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
    runtime.log.mockClear();
    listSessionEntriesMock.mockReset();
    mockStores(...stores);
    await sessionsCommand({ allAgents: true }, runtime);
    expect(runtime.log.mock.calls[0]?.[0]).toContain("Session stores: 2 (main, voice)");
    expect(runtime.log.mock.calls[2]?.[0]).toContain("Agent");
  });

  it("applies a global active limit while preserving store order for tied timestamps", async () => {
    const now = Date.now();
    mockStores(
      sessionRows([
        ["agent:main:tie", "main-tie", now - 60_000],
        ["agent:main:old", "main-old", now - 180_000],
      ]),
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
    loadConfigMock.mockReturnValue({
      agents: { ownership: "explicit", entries: { main: {}, helper: {} } },
    });

    const result = sessionsCommand({}, runtime);
    await expect(result).rejects.toBeInstanceOf(AgentSelectionRequiredError);
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
    expect(listSessionEntriesMock).not.toHaveBeenCalled();
  });
});
