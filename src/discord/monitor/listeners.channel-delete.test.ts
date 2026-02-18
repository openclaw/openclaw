import path from "node:path";
import type { Client } from "@buape/carbon";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { DiscordChannelDeleteListener } from "./listeners.js";

const listAgentIdsMock = vi.hoisted(() => vi.fn());
const resolveStorePathMock = vi.hoisted(() => vi.fn());
const updateSessionStoreMock = vi.hoisted(() => vi.fn());
const resolveMaintenanceConfigMock = vi.hoisted(() => vi.fn());
const archiveSessionTranscriptsMock = vi.hoisted(() => vi.fn());
const cleanupArchivedSessionTranscriptsMock = vi.hoisted(() => vi.fn());

vi.mock("../../agents/agent-scope.js", () => ({
  listAgentIds: (...args: unknown[]) => listAgentIdsMock(...args),
}));

vi.mock("../../config/sessions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/sessions.js")>();
  return {
    ...actual,
    resolveStorePath: (...args: unknown[]) => resolveStorePathMock(...args),
    updateSessionStore: (...args: unknown[]) => updateSessionStoreMock(...args),
    resolveMaintenanceConfig: (...args: unknown[]) => resolveMaintenanceConfigMock(...args),
  };
});

vi.mock("../../gateway/session-utils.fs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../gateway/session-utils.fs.js")>();
  return {
    ...actual,
    archiveSessionTranscripts: (...args: unknown[]) => archiveSessionTranscriptsMock(...args),
    cleanupArchivedSessionTranscripts: (...args: unknown[]) =>
      cleanupArchivedSessionTranscriptsMock(...args),
  };
});

type Logger = ReturnType<typeof import("../../logging/subsystem.js").createSubsystemLogger>;

type SessionEntryStub = {
  sessionId?: string;
  sessionFile?: string;
};

type SessionStoreStub = Record<string, SessionEntryStub>;

const storeByPath = new Map<string, SessionStoreStub>();

function createLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
}

function seedStore(storePath: string, store: SessionStoreStub) {
  storeByPath.set(storePath, structuredClone(store));
}

function getStore(storePath: string): SessionStoreStub {
  return storeByPath.get(storePath) ?? {};
}

describe("DiscordChannelDeleteListener", () => {
  beforeEach(() => {
    storeByPath.clear();
    listAgentIdsMock.mockReset();
    resolveStorePathMock.mockReset();
    updateSessionStoreMock.mockReset();
    resolveMaintenanceConfigMock.mockReset();
    archiveSessionTranscriptsMock.mockReset();
    cleanupArchivedSessionTranscriptsMock.mockReset();

    resolveMaintenanceConfigMock.mockReturnValue({
      mode: "warn",
      pruneAfterMs: 123_000,
      maxEntries: 500,
      rotateBytes: 1024,
    });

    updateSessionStoreMock.mockImplementation(async (storePath: string, mutator: unknown) => {
      const store = getStore(storePath);
      const result = await (mutator as (store: SessionStoreStub) => unknown)(store);
      storeByPath.set(storePath, store);
      return result;
    });

    archiveSessionTranscriptsMock.mockImplementation(
      (params: { sessionId: string; storePath: string }) => [
        path.join(path.dirname(params.storePath), `${params.sessionId}.deleted.1`),
      ],
    );
  });

  it("removes channel sessions across agents and archives transcripts", async () => {
    listAgentIdsMock.mockReturnValue(["main", "ops"]);

    const mainStorePath = "/tmp/main/sessions.json";
    const opsStorePath = "/tmp/ops/sessions.json";

    resolveStorePathMock.mockImplementation(
      (_store: string | undefined, opts?: { agentId?: string }) =>
        opts?.agentId === "ops" ? opsStorePath : mainStorePath,
    );

    seedStore(mainStorePath, {
      "agent:main:discord:channel:123": { sessionId: "s1", sessionFile: "s1.jsonl" },
      "agent:main:discord:channel:999": { sessionId: "s2" },
    });

    seedStore(opsStorePath, {
      "agent:ops:discord:channel:123": { sessionId: "s3" },
      "agent:ops:discord:channel:456": { sessionId: "s4" },
    });

    const logger = createLogger();

    const listener = new DiscordChannelDeleteListener({
      cfg: {} as OpenClawConfig,
      logger,
    });

    await listener.handle(
      { id: "123" } as unknown as Parameters<typeof listener.handle>[0],
      {
        listeners: [],
      } as Client,
    );

    expect(getStore(mainStorePath)).toEqual({
      "agent:main:discord:channel:999": { sessionId: "s2" },
    });
    expect(getStore(opsStorePath)).toEqual({
      "agent:ops:discord:channel:456": { sessionId: "s4" },
    });

    expect(updateSessionStoreMock).toHaveBeenCalledTimes(2);
    expect(archiveSessionTranscriptsMock).toHaveBeenCalledTimes(2);
    expect(archiveSessionTranscriptsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "s1",
        storePath: mainStorePath,
        agentId: "main",
        reason: "deleted",
      }),
    );
    expect(archiveSessionTranscriptsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "s3",
        storePath: opsStorePath,
        agentId: "ops",
        reason: "deleted",
      }),
    );

    expect(cleanupArchivedSessionTranscriptsMock).toHaveBeenCalledTimes(2);
    expect(cleanupArchivedSessionTranscriptsMock).toHaveBeenCalledWith({
      directories: [path.dirname(mainStorePath)],
      olderThanMs: 123_000,
      reason: "deleted",
    });
    expect(cleanupArchivedSessionTranscriptsMock).toHaveBeenCalledWith({
      directories: [path.dirname(opsStorePath)],
      olderThanMs: 123_000,
      reason: "deleted",
    });

    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      "discord channel-delete: cleaned up 2 session(s) for deleted channel 123",
    );
  });

  it("uses nested channel id when top-level id is missing", async () => {
    listAgentIdsMock.mockReturnValue(["main"]);

    const storePath = "/tmp/main/sessions.json";
    resolveStorePathMock.mockReturnValue(storePath);

    seedStore(storePath, {
      "agent:main:discord:channel:456": { sessionId: "s5" },
    });

    const logger = createLogger();

    const listener = new DiscordChannelDeleteListener({
      cfg: {} as OpenClawConfig,
      logger,
    });

    await listener.handle(
      { channel: { id: 456 } } as unknown as Parameters<typeof listener.handle>[0],
      { listeners: [] } as Client,
    );

    expect(getStore(storePath)).toEqual({});
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("warns and skips cleanup when channel id is missing", async () => {
    listAgentIdsMock.mockReturnValue(["main"]);

    const logger = createLogger();

    const listener = new DiscordChannelDeleteListener({
      cfg: {} as OpenClawConfig,
      logger,
    });

    await listener.handle(
      {} as unknown as Parameters<typeof listener.handle>[0],
      {
        listeners: [],
      } as Client,
    );

    expect(logger.warn).toHaveBeenCalledWith(
      "discord channel-delete: could not resolve channel ID from event data",
    );
    expect(updateSessionStoreMock).not.toHaveBeenCalled();
    expect(archiveSessionTranscriptsMock).not.toHaveBeenCalled();
  });
});
