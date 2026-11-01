import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { AgentSelectionRequiredError } from "../agents/agent-scope-config.js";
import { ExpectedCliError } from "../cli/failure-output.js";
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

function createDatabase(pathname: string, table: string): void {
  const database = new DatabaseSync(pathname);
  if (table === "schema_meta") {
    database.exec(`
      CREATE TABLE schema_meta (
        meta_key TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        agent_id TEXT
      );
      INSERT INTO schema_meta (meta_key, role, schema_version, agent_id)
      VALUES ('primary', 'agent', 0, 'main');
    `);
  } else {
    database.exec(`CREATE TABLE ${table} (meta_key TEXT PRIMARY KEY)`);
  }
  database.close();
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
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
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

  it.each([undefined, "ghost"])("rejects an absent or unknown selection (%s)", async (agent) => {
    loadConfigMock.mockReturnValue({
      agents: { ownership: "explicit", entries: { main: {}, helper: {} } },
    });

    const result = sessionsCommand({ agent }, runtime);
    await expect(result).rejects.toBeInstanceOf(
      agent ? ExpectedCliError : AgentSelectionRequiredError,
    );
    if (!agent) {
      await expect(result).rejects.toMatchObject({
        agentIds: ["main", "helper"],
        message: expect.stringContaining(
          "session-store selection has no explicit owner. Pass --agent <id> to select one agent, or --all-agents",
        ),
      });
    }
    expect(runtime.log).not.toHaveBeenCalled();
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
    expect(listSessionEntriesMock).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", "does not exist"],
    ["suffixless", "does not exist"],
    ["directory", "not a regular file"],
    ["non-database", "not a session store"],
    ["foreign-database", "not a session store"],
  ])("rejects a %s explicit store before reading sessions", async (storeKind, reason) => {
    const store = path.join(
      tempDirs.make("session-target-"),
      storeKind === "suffixless" ? "requested-store" : `${storeKind}.sqlite`,
    );
    const resolvedPath = storeKind === "suffixless" ? `${store}.sqlite` : store;
    if (storeKind === "suffixless" || storeKind === "directory") {
      fs.mkdirSync(store);
    } else if (storeKind === "non-database") {
      fs.writeFileSync(store, "not a db");
    } else if (storeKind === "foreign-database") {
      createDatabase(store, "unrelated");
    }
    await expect(sessionsCommand({ store, agent: "main" }, runtime)).rejects.toMatchObject({
      name: "ExpectedCliError",
      message: expect.stringContaining(reason),
      humanOutput: expect.stringContaining(resolvedPath),
      machineOutput: expect.stringContaining(resolvedPath),
    });
    expect(listSessionEntriesMock).not.toHaveBeenCalled();
  });

  it.each([
    ["legacy JSON locator", "sessions.json", "openclaw-agent.main.sqlite"],
    ["suffixless locator", "offline-store", "offline-store.main.sqlite"],
  ])("lists the existing SQLite target of a %s", async (_name, locator, target) => {
    const dir = tempDirs.make("session-target-");
    const databasePath = path.join(dir, target);
    createDatabase(databasePath, "schema_meta");

    await sessionsCommand({ store: path.join(dir, locator), agent: "main", json: true }, runtime);

    expect(readJsonOutput()).toMatchObject({ path: databasePath, count: 0, sessions: [] });
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
  });
});
