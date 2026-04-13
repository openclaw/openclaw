import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayRequestContext, RespondFn } from "./types.js";

const hoisted = vi.hoisted(() => ({
  loadSessionEntryMock: vi.fn(),
  loadGatewaySessionRowMock: vi.fn(),
  resolveGatewaySessionStoreTargetMock: vi.fn(),
  migrateAndPruneGatewaySessionStoreKeyMock: vi.fn(),
  updateSessionStoreMock: vi.fn(),
  applySessionsPatchToStoreMock: vi.fn(),
  removeSessionWorktreeMock: vi.fn(),
  resolveTeamFlowMock: vi.fn(),
  syncTeamFlowMock: vi.fn(),
  closeTeamFlowMock: vi.fn(),
}));

vi.mock("../../config/config.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js");
  return {
    ...actual,
    loadConfig: () => ({}),
  };
});

vi.mock("../../config/sessions.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/sessions.js")>(
    "../../config/sessions.js",
  );
  return {
    ...actual,
    updateSessionStore: (...args: unknown[]) => hoisted.updateSessionStoreMock(...args),
  };
});

vi.mock("../../hooks/internal-hooks.js", () => ({
  hasInternalHookListeners: () => false,
  triggerInternalHook: vi.fn(),
}));

vi.mock("../session-utils.js", async () => {
  const actual = await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js");
  return {
    ...actual,
    loadSessionEntry: (...args: unknown[]) => hoisted.loadSessionEntryMock(...args),
    loadGatewaySessionRow: (...args: unknown[]) => hoisted.loadGatewaySessionRowMock(...args),
    resolveGatewaySessionStoreTarget: (...args: unknown[]) =>
      hoisted.resolveGatewaySessionStoreTargetMock(...args),
    migrateAndPruneGatewaySessionStoreKey: (...args: unknown[]) =>
      hoisted.migrateAndPruneGatewaySessionStoreKeyMock(...args),
    resolveSessionModelRef: () => ({ provider: "openai", model: "gpt-5.4" }),
  };
});

vi.mock("../sessions-patch.js", () => ({
  applySessionsPatchToStore: (...args: unknown[]) => hoisted.applySessionsPatchToStoreMock(...args),
}));

vi.mock("../../agents/worktree-runtime.js", () => ({
  removeSessionWorktree: (...args: unknown[]) => hoisted.removeSessionWorktreeMock(...args),
}));

vi.mock("../../agents/team-runtime.js", () => ({
  resolveTeamFlow: (...args: unknown[]) => hoisted.resolveTeamFlowMock(...args),
  syncTeamFlow: (...args: unknown[]) => hoisted.syncTeamFlowMock(...args),
  closeTeamFlow: (...args: unknown[]) => hoisted.closeTeamFlowMock(...args),
}));

vi.mock("./chat.js", () => ({
  chatHandlers: {
    "chat.send": vi.fn(),
    "chat.abort": vi.fn(),
  },
}));

import { sessionsHandlers } from "./sessions.js";

describe("sessions inspect/control handlers", () => {
  let currentEntry: Record<string, unknown>;

  beforeEach(() => {
    currentEntry = {
      sessionId: "sess-123",
      updatedAt: 1,
      planMode: "active",
      planArtifact: {
        status: "active",
        goal: "Ship phase 3",
      },
      worktreeMode: "active",
      worktreeArtifact: {
        repoRoot: "/repo",
        worktreeDir: "/repo/.openclaw-worktrees/phase-3",
        cleanupPolicy: "remove",
        status: "active",
        createdAt: 1,
      },
      sendPolicy: "deny",
      groupActivation: "always",
      execHost: "gateway",
      execSecurity: "allowlist",
      execAsk: "on-miss",
      execNode: "mac-mini",
      responseUsage: "full",
    };

    hoisted.loadSessionEntryMock.mockReset();
    hoisted.loadGatewaySessionRowMock.mockReset();
    hoisted.resolveGatewaySessionStoreTargetMock.mockReset();
    hoisted.migrateAndPruneGatewaySessionStoreKeyMock.mockReset();
    hoisted.updateSessionStoreMock.mockReset();
    hoisted.applySessionsPatchToStoreMock.mockReset();
    hoisted.removeSessionWorktreeMock.mockReset();
    hoisted.resolveTeamFlowMock.mockReset();
    hoisted.syncTeamFlowMock.mockReset();
    hoisted.closeTeamFlowMock.mockReset();

    hoisted.loadSessionEntryMock.mockImplementation(() => ({
      entry: currentEntry,
      canonicalKey: "agent:main:main",
      storePath: "/tmp/sessions.json",
    }));
    hoisted.loadGatewaySessionRowMock.mockReturnValue({
      key: "agent:main:main",
      kind: "direct",
      updatedAt: 1,
      status: "running",
      modelProvider: "openai",
      model: "gpt-5.4",
    });
    hoisted.resolveGatewaySessionStoreTargetMock.mockReturnValue({
      canonicalKey: "agent:main:main",
      storePath: "/tmp/sessions.json",
      storeKeys: ["agent:main:main"],
      agentId: "main",
    });
    hoisted.migrateAndPruneGatewaySessionStoreKeyMock.mockReturnValue({
      primaryKey: "agent:main:main",
    });
    hoisted.updateSessionStoreMock.mockImplementation(
      async (
        _storePath: string,
        mutator: (store: Record<string, Record<string, unknown>>) => unknown,
      ) => await mutator({ "agent:main:main": currentEntry }),
    );
    hoisted.applySessionsPatchToStoreMock.mockImplementation(
      async (_params: { patch: Record<string, unknown> }) => {
        const patch = _params.patch;
        currentEntry = {
          ...currentEntry,
          ...(patch.planMode !== undefined ? { planMode: patch.planMode } : {}),
          ...(patch.worktreeMode !== undefined ? { worktreeMode: patch.worktreeMode } : {}),
          ...(patch.planArtifact === null
            ? { planArtifact: undefined }
            : patch.planArtifact
              ? {
                  planArtifact: {
                    ...(currentEntry.planArtifact as Record<string, unknown> | undefined),
                    ...(patch.planArtifact as Record<string, unknown>),
                  },
                }
              : {}),
          ...(patch.worktreeArtifact === null
            ? { worktreeArtifact: undefined }
            : patch.worktreeArtifact
              ? {
                  worktreeArtifact: patch.worktreeArtifact,
                }
              : {}),
        };
        return {
          ok: true,
          entry: currentEntry,
        };
      },
    );
    hoisted.removeSessionWorktreeMock.mockResolvedValue({
      removed: true,
      dirty: false,
      error: undefined,
    });
    hoisted.resolveTeamFlowMock.mockReturnValue({
      flowId: "team-1",
      status: "running",
      currentStep: "workers active 1/2",
    });
    hoisted.syncTeamFlowMock.mockReturnValue({
      flow: {
        flowId: "team-1",
        status: "running",
        currentStep: "workers active 1/2",
      },
      state: {
        teamId: "team-1",
        summary: "still running",
        worktreeDir: "/repo/.openclaw-worktrees/phase-3",
        members: [],
      },
      counts: { running: 1 },
      activeCount: 1,
    });
    hoisted.closeTeamFlowMock.mockResolvedValue({
      flow: {
        flowId: "team-1",
        status: "cancelled",
        currentStep: "team closed after worker cancellation",
      },
      state: {
        teamId: "team-1",
        summary: "closed",
        worktreeDir: "/repo/.openclaw-worktrees/phase-3",
        members: [],
      },
      counts: { killed: 1 },
      activeCount: 0,
    });
  });

  function createContext(): GatewayRequestContext {
    return {
      loadGatewayModelCatalog: vi.fn(async () => []),
      broadcastToConnIds: vi.fn(),
      getSessionEventSubscriberConnIds: () => new Set<string>(),
    } as unknown as GatewayRequestContext;
  }

  it("returns plan, worktree, team, and policy data from sessions.inspect", async () => {
    const respond = vi.fn() as unknown as RespondFn;

    await sessionsHandlers["sessions.inspect"]({
      req: { id: "req-1" } as never,
      params: { key: "main" },
      respond,
      context: createContext(),
      client: null,
      isWebchatConnect: () => false,
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        ok: true,
        key: "agent:main:main",
        plan: expect.objectContaining({
          mode: "active",
        }),
        worktree: expect.objectContaining({
          mode: "active",
          preferredWorkspaceDir: "/repo/.openclaw-worktrees/phase-3",
        }),
        team: expect.objectContaining({
          teamId: "team-1",
          flowStatus: "running",
        }),
        policy: expect.objectContaining({
          sendPolicy: "deny",
          execHost: "gateway",
          responseUsage: "full",
        }),
      }),
      undefined,
    );
  });

  it("applies plan/worktree/team actions through sessions.control", async () => {
    const respond = vi.fn() as unknown as RespondFn;

    await sessionsHandlers["sessions.control"]({
      req: { id: "req-2" } as never,
      params: {
        key: "main",
        plan: { exit: true, status: "completed", summary: "done" },
        worktree: { exit: true, cleanup: "remove", force: true },
        team: { close: true, teamId: "team-1", summary: "closed", cancelActive: false },
      },
      respond,
      context: createContext(),
      client: null,
      isWebchatConnect: () => false,
    });

    expect(hoisted.removeSessionWorktreeMock).toHaveBeenCalledWith({
      repoRoot: "/repo",
      worktreeDir: "/repo/.openclaw-worktrees/phase-3",
      force: true,
    });
    expect(hoisted.closeTeamFlowMock).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerSessionKey: "agent:main:main",
        summary: "closed",
        cancelActive: false,
      }),
    );
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        ok: true,
        key: "agent:main:main",
        actions: expect.objectContaining({
          plan: expect.objectContaining({
            mode: "inactive",
          }),
          worktree: expect.objectContaining({
            cleanup: "remove",
            removed: true,
          }),
          team: expect.objectContaining({
            teamId: "team-1",
            flowStatus: "cancelled",
          }),
        }),
      }),
      undefined,
    );
  });
});
