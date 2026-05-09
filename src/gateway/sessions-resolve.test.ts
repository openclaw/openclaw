import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions/types.js";
import { ErrorCodes } from "./protocol/index.js";

const hoisted = vi.hoisted(() => ({
  sessionRowsMock: vi.fn(),
  listSessionEntriesMock: vi.fn(),
  listSessionsFromStoreMock: vi.fn(),
  resolveGatewaySessionDatabaseTargetMock: vi.fn(),
  loadCombinedSessionEntriesForGatewayMock: vi.fn(),
  listAgentIdsMock: vi.fn(),
}));

vi.mock("../agents/agent-scope.js", async () => {
  const actual = await vi.importActual<typeof import("../agents/agent-scope.js")>(
    "../agents/agent-scope.js",
  );
  return {
    ...actual,
    listAgentIds: hoisted.listAgentIdsMock,
  };
});

vi.mock("../config/sessions.js", async () => {
  const actual =
    await vi.importActual<typeof import("../config/sessions.js")>("../config/sessions.js");
  return {
    ...actual,
    listSessionEntries: hoisted.listSessionEntriesMock,
  };
});

vi.mock("./session-utils.js", async () => {
  const actual = await vi.importActual<typeof import("./session-utils.js")>("./session-utils.js");
  return {
    ...actual,
    listSessionsFromStore: hoisted.listSessionsFromStoreMock,
    resolveGatewaySessionDatabaseTarget: hoisted.resolveGatewaySessionDatabaseTargetMock,
    loadCombinedSessionEntriesForGateway: hoisted.loadCombinedSessionEntriesForGatewayMock,
  };
});

const { resolveSessionKeyFromResolveParams } = await import("./sessions-resolve.js");

describe("resolveSessionKeyFromResolveParams", () => {
  const canonicalKey = "agent:main:canon";
  const legacyKey = "agent:main:legacy";
  const databasePath = "/tmp/openclaw-agent.sqlite";

  beforeEach(() => {
    hoisted.sessionRowsMock.mockReset();
    hoisted.listSessionEntriesMock.mockReset();
    hoisted.listSessionsFromStoreMock.mockReset();
    hoisted.resolveGatewaySessionDatabaseTargetMock.mockReset();
    hoisted.loadCombinedSessionEntriesForGatewayMock.mockReset();
    hoisted.listAgentIdsMock.mockReset();
    // Default: all agents are known (main is always present).
    hoisted.listAgentIdsMock.mockReturnValue(["main"]);
    hoisted.resolveGatewaySessionDatabaseTargetMock.mockReturnValue({
      agentId: "main",
      canonicalKey,
      databasePath,
    });
    hoisted.listSessionEntriesMock.mockImplementation(() =>
      Object.entries(hoisted.sessionRowsMock() ?? {}).map(([sessionKey, entry]) => ({
        sessionKey,
        entry,
      })),
    );
  });

  it("hides canonical keys that fail the spawnedBy visibility filter", async () => {
    hoisted.sessionRowsMock.mockReturnValue({
      [canonicalKey]: { sessionId: "sess-1", updatedAt: 1 },
    });
    hoisted.listSessionsFromStoreMock.mockReturnValue({ sessions: [] });

    await expect(
      resolveSessionKeyFromResolveParams({
        cfg: {},
        p: { key: canonicalKey, spawnedBy: "controller-1" },
      }),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: ErrorCodes.INVALID_REQUEST,
        message: `No session found: ${canonicalKey}`,
      },
    });
  });

  it("does not migrate legacy keys during key-based lookup", async () => {
    const store = {
      [legacyKey]: { sessionId: "sess-legacy", updatedAt: 1 },
    } satisfies Record<string, SessionEntry>;
    hoisted.sessionRowsMock.mockImplementation(() => store);
    hoisted.listSessionsFromStoreMock.mockReturnValue({
      sessions: [{ key: canonicalKey }],
    });

    await expect(
      resolveSessionKeyFromResolveParams({
        cfg: {},
        p: { key: canonicalKey, spawnedBy: "controller-1" },
      }),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: ErrorCodes.INVALID_REQUEST,
        message: `No session found: ${canonicalKey}`,
      },
    });

    expect(hoisted.listSessionsFromStoreMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ store }),
    );
  });

  it("rejects sessions belonging to a deleted agent (key-based lookup)", async () => {
    const deletedAgentKey = "agent:deleted-agent:main";
    hoisted.resolveGatewaySessionDatabaseTargetMock.mockReturnValue({
      canonicalKey: deletedAgentKey,
      databasePath,
    });
    hoisted.sessionRowsMock.mockReturnValue({
      [deletedAgentKey]: { sessionId: "sess-orphan", updatedAt: 1 },
    });
    // "deleted-agent" is not in the known agents list.
    hoisted.listAgentIdsMock.mockReturnValue(["main"]);

    const result = await resolveSessionKeyFromResolveParams({
      cfg: {},
      p: { key: deletedAgentKey },
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: ErrorCodes.INVALID_REQUEST,
        message: 'Agent "deleted-agent" no longer exists in configuration',
      },
    });
  });

  it("rejects non-alias agent:main sessions when main is no longer configured", async () => {
    const staleMainKey = "agent:main:guildchat:direct:u1";
    hoisted.resolveGatewaySessionDatabaseTargetMock.mockReturnValue({
      canonicalKey: staleMainKey,
      databasePath,
    });
    hoisted.sessionRowsMock.mockReturnValue({
      [staleMainKey]: { sessionId: "sess-stale-main", updatedAt: 1 },
    });
    hoisted.listAgentIdsMock.mockReturnValue(["ops"]);

    const result = await resolveSessionKeyFromResolveParams({
      cfg: { agents: { list: [{ id: "ops", default: true }] } },
      p: { key: staleMainKey },
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: ErrorCodes.INVALID_REQUEST,
        message: 'Agent "main" no longer exists in configuration',
      },
    });
  });

  it("rejects sessions belonging to a deleted agent (sessionId-based lookup)", async () => {
    const deletedAgentKey = "agent:deleted-agent:main";
    hoisted.loadCombinedSessionEntriesForGatewayMock.mockReturnValue({
      databasePath,
      entries: { [deletedAgentKey]: { sessionId: "sess-orphan", updatedAt: 1 } },
    });
    hoisted.listAgentIdsMock.mockReturnValue(["main"]);

    const result = await resolveSessionKeyFromResolveParams({
      cfg: {},
      p: { sessionId: "sess-orphan" },
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: ErrorCodes.INVALID_REQUEST,
        message: 'Agent "deleted-agent" no longer exists in configuration',
      },
    });
  });

  it("resolves sessionId matches from raw store metadata without hydrating session rows", async () => {
    hoisted.loadCombinedSessionEntriesForGatewayMock.mockReturnValue({
      databasePath,
      entries: {
        "agent:main:noisy": { sessionId: "sess-noisy", updatedAt: 2 },
        "agent:main:target": { sessionId: "sess-target", updatedAt: 1 },
      },
    });
    hoisted.listSessionsFromStoreMock.mockImplementation(() => {
      throw new Error("session rows should not be materialized for exact sessionId lookup");
    });

    const result = await resolveSessionKeyFromResolveParams({
      cfg: {},
      p: { sessionId: "sess-target" },
    });

    expect(result).toEqual({ ok: true, key: "agent:main:target" });
    expect(hoisted.listSessionsFromStoreMock).not.toHaveBeenCalled();
  });

  it("rejects sessions belonging to a deleted agent (label-based lookup)", async () => {
    const deletedAgentKey = "agent:deleted-agent:main";
    hoisted.loadCombinedSessionEntriesForGatewayMock.mockReturnValue({
      databasePath,
      entries: {
        [deletedAgentKey]: { sessionId: "sess-orphan", updatedAt: 1, label: "my-label" },
      },
    });
    hoisted.listSessionsFromStoreMock.mockReturnValue({
      sessions: [{ key: deletedAgentKey, sessionId: "sess-orphan", label: "my-label" }],
    });
    hoisted.listAgentIdsMock.mockReturnValue(["main"]);

    const result = await resolveSessionKeyFromResolveParams({
      cfg: {},
      p: { label: "my-label" },
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: ErrorCodes.INVALID_REQUEST,
        message: 'Agent "deleted-agent" no longer exists in configuration',
      },
    });
  });
});
