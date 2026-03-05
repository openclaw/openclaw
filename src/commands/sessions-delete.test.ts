import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import { makeRuntime } from "./sessions.test-helpers.js";
import { sessionsClearCommand, sessionsRmCommand } from "./sessions-delete.js";

const mocks = vi.hoisted(() => ({
  archiveSessionTranscripts: vi.fn(),
  loadConfig: vi.fn(),
  resolveSessionStoreTargets: vi.fn(),
  resolveSessionStoreTargetsOrExit: vi.fn(),
  loadSessionStore: vi.fn(),
  updateSessionStore: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  loadConfig: mocks.loadConfig,
}));

vi.mock("./session-store-targets.js", () => ({
  resolveSessionStoreTargets: mocks.resolveSessionStoreTargets,
  resolveSessionStoreTargetsOrExit: mocks.resolveSessionStoreTargetsOrExit,
}));

vi.mock("../config/sessions.js", () => ({
  loadSessionStore: mocks.loadSessionStore,
  updateSessionStore: mocks.updateSessionStore,
}));

vi.mock("../gateway/session-utils.fs.js", () => ({
  archiveSessionTranscripts: mocks.archiveSessionTranscripts,
}));

function mockTargets() {
  return [{ agentId: "main", storePath: "/tmp/sessions-main.json" }];
}

describe("sessions delete commands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadConfig.mockReturnValue({
      session: { store: "/cfg/sessions.json" },
      agents: {
        defaults: {
          model: "gpt-5",
        },
      },
    });
    mocks.resolveSessionStoreTargets.mockReturnValue(mockTargets());
    mocks.resolveSessionStoreTargetsOrExit.mockImplementation(
      (params: {
        cfg: unknown;
        opts: { store?: string; agent?: string; allAgents?: boolean };
        runtime: { error: (msg: unknown) => void; exit: (code: number) => never };
      }) => {
        try {
          return mocks.resolveSessionStoreTargets(params.cfg, params.opts);
        } catch (error) {
          params.runtime.error(error instanceof Error ? error.message : String(error));
          params.runtime.exit(1);
          return null;
        }
      },
    );
    mocks.updateSessionStore.mockImplementation(
      async (_storePath, mutator: (store: Record<string, SessionEntry>) => Promise<unknown> | unknown) => {
        const next = structuredClone(mocks.loadSessionStore());
        return mutator(next);
      },
    );
  });

  it("deletes a matched session and aliases by session ID in JSON mode", async () => {
    const store = {
      "agent:main:main": {
        sessionId: "sid-1",
        updatedAt: 1,
        sessionFile: "sid-1-main.jsonl",
      },
      "agent:main:main:alias": {
        sessionId: "sid-1",
        updatedAt: 2,
        sessionFile: "sid-1-alias.jsonl",
      },
      "agent:main:other": {
        sessionId: "sid-2",
        updatedAt: 3,
        sessionFile: "sid-2.jsonl",
      },
    };
    mocks.loadSessionStore.mockReturnValue(structuredClone(store));

    const { runtime, logs } = makeRuntime();
    await sessionsRmCommand(
      {
        key: "agent:main:main",
        store: "/tmp/sessions-main.json",
        json: true,
      },
      runtime,
    );

    const payload = JSON.parse(logs[0] ?? "{}") as Record<string, unknown>;
    expect(payload.deletedCount).toBe(2);
    expect(payload.deletedKeys).toEqual(["agent:main:main", "agent:main:main:alias"]);
    expect(mocks.archiveSessionTranscripts).toHaveBeenCalledTimes(1);
    expect(mocks.archiveSessionTranscripts).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "sid-1",
        storePath: "/tmp/sessions-main.json",
        reason: "deleted",
        restrictToStoreDir: true,
      }),
    );
  });

  it("errors when rm target key cannot be resolved", async () => {
    mocks.loadSessionStore.mockReturnValue({
      "agent:main:other": {
        sessionId: "sid-2",
        updatedAt: 1,
      },
    });
    const { runtime, errors } = makeRuntime({ throwOnError: true });

    await expect(
      sessionsRmCommand(
        {
          key: "agent:main:main",
          store: "/tmp/sessions-main.json",
          json: true,
        },
        runtime,
      ),
    ).rejects.toThrow("exit 1");
    expect(errors[0]).toContain("Session key not found");
    expect(mocks.updateSessionStore).not.toHaveBeenCalled();
  });

  it("clears all entries and archives each unique session once", async () => {
    const store = {
      "agent:main:main": {
        sessionId: "sid-1",
        updatedAt: 10,
        sessionFile: "sid-1-main.jsonl",
      },
      "agent:main:main:alias": {
        sessionId: "sid-1",
        updatedAt: 20,
        sessionFile: "sid-1-main.jsonl",
      },
      "agent:main:other": {
        sessionId: "sid-2",
        updatedAt: 30,
        sessionFile: "sid-2.jsonl",
      },
    };
    mocks.loadSessionStore.mockReturnValue(structuredClone(store));

    const { runtime, logs } = makeRuntime();
    await sessionsClearCommand(
      {
        all: true,
        store: "/tmp/sessions-main.json",
        json: true,
      },
      runtime,
    );

    const payload = JSON.parse(logs[0] ?? "{}") as Record<string, unknown> & {
      deletedSessionIds?: string[];
      deletedKeys?: string[];
    };
    expect(payload.deletedCount).toBe(3);
    expect(payload.deletedSessionIds).toEqual(expect.arrayContaining(["sid-1", "sid-2"]));
    expect(mocks.archiveSessionTranscripts).toHaveBeenCalledTimes(2);
    expect(mocks.archiveSessionTranscripts).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "sid-1",
        storePath: "/tmp/sessions-main.json",
        reason: "deleted",
      }),
    );
    expect(mocks.archiveSessionTranscripts).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "sid-2",
        storePath: "/tmp/sessions-main.json",
        reason: "deleted",
      }),
    );
    expect(payload.deletedKeys?.length).toBe(3);
  });

  it("dry-runs clear-older-than without updating the store", async () => {
    const now = Date.now();
    const store = {
      recent: { sessionId: "sid-recent", updatedAt: now - 1000, sessionFile: "recent.jsonl" },
      stale: { sessionId: "sid-stale", updatedAt: now - 20 * 60 * 1000, sessionFile: "stale.jsonl" },
    };
    mocks.loadSessionStore.mockReturnValue(structuredClone(store));

    const { runtime, logs } = makeRuntime();
    await sessionsClearCommand(
      {
        olderThan: "5m",
        store: "/tmp/sessions-main.json",
        dryRun: true,
        json: true,
      },
      runtime,
    );

    const payload = JSON.parse(logs[0] ?? "{}") as Record<string, unknown> & {
      deletedKeys?: string[];
    };
    expect(payload.dryRun).toBe(true);
    expect(payload.deletedKeys).toEqual(["stale"]);
    expect(mocks.updateSessionStore).not.toHaveBeenCalled();
    expect(mocks.archiveSessionTranscripts).not.toHaveBeenCalled();
  });

  it("validates clear options and exits on invalid combinations", async () => {
    const { runtime, errors } = makeRuntime({ throwOnError: true });

    await expect(
      sessionsClearCommand(
        {
          all: true,
          olderThan: "7d",
          store: "/tmp/sessions-main.json",
        },
        runtime,
      ),
    ).rejects.toThrow("exit 1");
    expect(errors[0]).toContain("Use either --all or --older-than");
  });
});
