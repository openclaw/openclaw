import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import type { RuntimeEnv } from "../runtime.js";

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  resolveSessionStoreTargets: vi.fn(),
  loadSessionStore: vi.fn(),
  updateSessionStore: vi.fn(),
  archiveSessionTranscripts: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  loadConfig: mocks.loadConfig,
}));

vi.mock("../config/sessions.js", async () => {
  const actual =
    await vi.importActual<typeof import("../config/sessions.js")>("../config/sessions.js");
  return {
    ...actual,
    resolveSessionStoreTargets: mocks.resolveSessionStoreTargets,
    loadSessionStore: mocks.loadSessionStore,
    updateSessionStore: mocks.updateSessionStore,
  };
});

vi.mock("../gateway/session-utils.js", async () => {
  const actual = await vi.importActual<typeof import("../gateway/session-utils.js")>(
    "../gateway/session-utils.js",
  );
  return {
    ...actual,
    archiveSessionTranscripts: mocks.archiveSessionTranscripts,
  };
});

import { sessionsArchiveCommand } from "./sessions-archive.js";

function makeRuntime(): { runtime: RuntimeEnv; logs: string[]; errors: string[]; exits: number[] } {
  const logs: string[] = [];
  const errors: string[] = [];
  const exits: number[] = [];
  return {
    runtime: {
      log: (msg: unknown) => logs.push(String(msg)),
      error: (msg: unknown) => errors.push(String(msg)),
      exit: (code?: number) => exits.push(code ?? 0),
    },
    logs,
    errors,
    exits,
  };
}

describe("sessionsArchiveCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadConfig.mockReturnValue({
      session: { mainKey: "main" },
      agents: { list: [{ id: "main", default: true }, { id: "lead" }] },
    });
    mocks.resolveSessionStoreTargets.mockReturnValue([
      { agentId: "main", storePath: "/resolved/sessions.json" },
    ]);
    mocks.loadSessionStore.mockReturnValue({});
    mocks.archiveSessionTranscripts.mockReturnValue([
      "/resolved/id-1.jsonl.deleted.2026-03-28T06:00:00.000Z",
    ]);
    mocks.updateSessionStore.mockImplementation(
      async (_storePath: string, mutator: (store: Record<string, SessionEntry>) => unknown) => {
        const store: Record<string, SessionEntry> = {
          "agent:main:task-1": {
            sessionId: "id-1",
            sessionFile: "id-1.jsonl",
            updatedAt: Date.now() - 9 * 24 * 60 * 60 * 1000,
            status: "done",
          },
        };
        return await mutator(store);
      },
    );
  });

  it("derives the target agent from a specific agent-scoped session key", async () => {
    mocks.loadSessionStore.mockReturnValue({
      "agent:lead:subagent:abc": {
        sessionId: "id-1",
        updatedAt: 1,
        status: "done",
      },
    });

    const { runtime, logs } = makeRuntime();
    await sessionsArchiveCommand(
      {
        sessionKey: "agent:lead:subagent:abc",
        dryRun: true,
        json: true,
      },
      runtime,
    );

    expect(mocks.resolveSessionStoreTargets).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ agent: "lead", allAgents: undefined }),
    );
    const payload = JSON.parse(logs[0] ?? "{}") as Record<string, unknown>;
    expect(payload.requestedKey).toBe("agent:lead:subagent:abc");
    expect(payload.matched).toBe(1);
    expect(payload.eligible).toBe(1);
    expect(payload.archived).toBe(1);
  });

  it("reports skipped main and cron sessions in dry-run batch mode", async () => {
    const now = Date.now();
    mocks.loadSessionStore.mockReturnValue({
      "agent:main:done-old": {
        sessionId: "done-old",
        updatedAt: now - 9 * 24 * 60 * 60 * 1000,
        status: "done",
      },
      "agent:main:main": {
        sessionId: "main-id",
        updatedAt: now - 9 * 24 * 60 * 60 * 1000,
        status: "done",
      },
      "agent:main:cron:job-1:run:old": {
        sessionId: "cron-old",
        updatedAt: now - 9 * 24 * 60 * 60 * 1000,
        status: "done",
      },
    });

    const { runtime, logs } = makeRuntime();
    await sessionsArchiveCommand(
      {
        status: "done",
        olderThan: "7d",
        dryRun: true,
        json: true,
      },
      runtime,
    );

    const payload = JSON.parse(logs[0] ?? "{}") as Record<string, unknown>;
    expect(payload.matched).toBe(3);
    expect(payload.eligible).toBe(1);
    expect(payload.skipped).toBe(2);
    expect(payload.archived).toBe(1);
  });

  it("archives only eligible sessions and skips maintenance on write", async () => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      "agent:main:done-old": {
        sessionId: "done-old",
        sessionFile: "done-old.jsonl",
        updatedAt: now - 9 * 24 * 60 * 60 * 1000,
        status: "done",
      },
      "agent:main:active-old": {
        sessionId: "active-old",
        sessionFile: "active-old.jsonl",
        updatedAt: now - 9 * 24 * 60 * 60 * 1000,
        status: "running",
      },
    };
    mocks.loadSessionStore.mockReturnValue(store);
    mocks.updateSessionStore.mockImplementation(
      async (
        _storePath: string,
        mutator: (store: Record<string, SessionEntry>) => unknown,
        opts?: { skipMaintenance?: boolean },
      ) => {
        expect(opts).toEqual(expect.objectContaining({ skipMaintenance: true }));
        return await mutator(store);
      },
    );

    const { runtime, logs } = makeRuntime();
    await sessionsArchiveCommand(
      {
        olderThan: "7d",
        json: true,
      },
      runtime,
    );

    const payload = JSON.parse(logs[0] ?? "{}") as Record<string, unknown>;
    expect(payload.archived).toBe(1);
    expect(payload.skipped).toBe(1);
    expect(store["agent:main:done-old"]).toBeUndefined();
    expect(store["agent:main:active-old"]).toBeDefined();
    expect(mocks.archiveSessionTranscripts).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "done-old",
        sessionFile: "done-old.jsonl",
        reason: "deleted",
        restrictToStoreDir: true,
      }),
    );
  });

  it("rejects non-dry-run attempts to archive the main session", async () => {
    mocks.loadSessionStore.mockReturnValue({
      "agent:main:main": {
        sessionId: "main-id",
        updatedAt: 1,
        status: "done",
      },
    });

    const { runtime, errors, exits } = makeRuntime();
    await sessionsArchiveCommand(
      {
        sessionKey: "agent:main:main",
      },
      runtime,
    );

    expect(errors[0]).toContain("Cannot archive agent:main:main: protected main session.");
    expect(exits).toEqual([1]);
    expect(mocks.updateSessionStore).not.toHaveBeenCalled();
  });
});
