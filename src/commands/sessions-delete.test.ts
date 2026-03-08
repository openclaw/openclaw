import fs from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import type { RuntimeEnv } from "../runtime.js";

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  resolveSessionStoreTargetsOrExit: vi.fn(),
  loadSessionStore: vi.fn(),
  updateSessionStore: vi.fn(),
  resolveSessionFilePath: vi.fn(),
  resolveSessionFilePathOptions: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  loadConfig: mocks.loadConfig,
}));

vi.mock("./session-store-targets.js", () => ({
  resolveSessionStoreTargetsOrExit: mocks.resolveSessionStoreTargetsOrExit,
}));

vi.mock("../config/sessions.js", () => ({
  loadSessionStore: mocks.loadSessionStore,
  updateSessionStore: mocks.updateSessionStore,
  resolveSessionFilePath: mocks.resolveSessionFilePath,
  resolveSessionFilePathOptions: mocks.resolveSessionFilePathOptions,
}));

import { sessionsClearCommand, sessionsRemoveCommand } from "./sessions-delete.js";

function makeRuntime(): { runtime: RuntimeEnv; logs: string[] } {
  const logs: string[] = [];
  return {
    runtime: {
      log: (msg: unknown) => logs.push(String(msg)),
      error: (msg: unknown) => logs.push(`ERROR:${String(msg)}`),
      exit: (code?: number) => {
        throw new Error(`exit ${code ?? 0}`);
      },
    },
    logs,
  };
}

describe("sessions delete commands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadConfig.mockReturnValue({});
    mocks.resolveSessionStoreTargetsOrExit.mockReturnValue([
      {
        agentId: "main",
        storePath: "/tmp/sessions.json",
      },
    ]);
    mocks.resolveSessionFilePathOptions.mockReturnValue({});
    mocks.resolveSessionFilePath.mockImplementation(
      (sessionId: string) => `/tmp/${sessionId}.jsonl`,
    );
    vi.spyOn(fs.promises, "rm").mockResolvedValue(undefined);
  });

  it("removes a matching session key and transcript", async () => {
    mocks.updateSessionStore.mockImplementation(
      async (_storePath: string, mutator: (store: Record<string, SessionEntry>) => unknown) => {
        const store: Record<string, SessionEntry> = {
          "agent:main:main": { sessionId: "sess-1", updatedAt: 1 },
          "agent:main:other": { sessionId: "sess-2", updatedAt: 2 },
        };
        return await mutator(store);
      },
    );

    const { runtime, logs } = makeRuntime();
    await sessionsRemoveCommand({ key: "agent:main:main" }, runtime);

    expect(mocks.updateSessionStore).toHaveBeenCalledTimes(1);
    expect(fs.promises.rm).toHaveBeenCalledWith("/tmp/sess-1.jsonl", { force: true });
    expect(logs.some((line) => line.includes("removed 1 session"))).toBe(true);
  });

  it("fails when removing a key that does not exist", async () => {
    mocks.updateSessionStore.mockImplementation(
      async (_storePath: string, mutator: (store: Record<string, SessionEntry>) => unknown) =>
        await mutator({ "agent:main:other": { sessionId: "sess-2", updatedAt: 2 } }),
    );

    const { runtime } = makeRuntime();
    await expect(sessionsRemoveCommand({ key: "agent:main:main" }, runtime)).rejects.toThrow(
      "exit 1",
    );
  });

  it("clears sessions older than a threshold", async () => {
    const now = Date.now();
    mocks.updateSessionStore.mockImplementation(
      async (_storePath: string, mutator: (store: Record<string, SessionEntry>) => unknown) => {
        const store: Record<string, SessionEntry> = {
          old: { sessionId: "sess-old", updatedAt: now - 120 * 60_000 },
          recent: { sessionId: "sess-recent", updatedAt: now - 5 * 60_000 },
        };
        return await mutator(store);
      },
    );

    const { runtime, logs } = makeRuntime();
    await sessionsClearCommand({ olderThan: "60" }, runtime);

    expect(fs.promises.rm).toHaveBeenCalledWith("/tmp/sess-old.jsonl", { force: true });
    expect(logs.some((line) => line.includes("removed 1 session"))).toBe(true);
  });

  it("supports dry-run clear without mutating the store", async () => {
    mocks.loadSessionStore.mockReturnValue({
      old: { sessionId: "sess-old", updatedAt: Date.now() - 120 * 60_000 },
      recent: { sessionId: "sess-recent", updatedAt: Date.now() - 5 * 60_000 },
    });

    const { runtime, logs } = makeRuntime();
    await sessionsClearCommand({ dryRun: true, olderThan: "60" }, runtime);

    expect(mocks.updateSessionStore).not.toHaveBeenCalled();
    expect(fs.promises.rm).not.toHaveBeenCalled();
    expect(logs.some((line) => line.includes("Dry-run session clear"))).toBe(true);
  });
});
