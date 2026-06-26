// Agent local status tests cover local session and bootstrap summary aggregation.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";

const mocks = vi.hoisted(() => ({
  listGatewayAgentsBasic: vi.fn(),
  listSessionEntries: vi.fn(),
  pathExists: vi.fn(),
  resolveAgentWorkspaceDir: vi.fn(),
  resolveStorePath: vi.fn(),
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: mocks.resolveAgentWorkspaceDir,
}));

vi.mock("../config/sessions/paths.js", () => ({
  resolveStorePath: mocks.resolveStorePath,
}));

vi.mock("../config/sessions/session-accessor.js", () => ({
  listSessionEntries: mocks.listSessionEntries,
}));

vi.mock("../gateway/agent-list.js", () => ({
  listGatewayAgentsBasic: mocks.listGatewayAgentsBasic,
}));

vi.mock("../infra/fs-safe.js", () => ({
  pathExists: mocks.pathExists,
}));

describe("getAgentLocalStatuses", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("summarizes local sessions and bootstrap pending agents", async () => {
    vi.spyOn(Date, "now").mockReturnValue(4000);
    mocks.listGatewayAgentsBasic.mockReturnValue({
      defaultId: "alpha",
      mainKey: "alpha",
      scope: "per-sender",
      agents: [
        { id: "alpha", name: "Alpha" },
        { id: "beta", name: "Beta" },
      ],
    });
    mocks.resolveAgentWorkspaceDir.mockImplementation(
      (_cfg: OpenClawConfig, agentId: string) => `/workspace/${agentId}`,
    );
    mocks.pathExists.mockImplementation((filePath: string) =>
      Promise.resolve(filePath === "/workspace/alpha/BOOTSTRAP.md"),
    );
    mocks.resolveStorePath.mockImplementation(
      (_store: unknown, params: { agentId: string }) => `/sessions/${params.agentId}.json`,
    );
    mocks.listSessionEntries.mockImplementation((params: { agentId: string }) => {
      if (params.agentId === "alpha") {
        return [
          { sessionKey: "global", entry: { updatedAt: 500 } },
          { sessionKey: "alpha-1", entry: { updatedAt: 1000 } },
          { sessionKey: "alpha-2", entry: { updatedAt: 2500 } },
        ];
      }
      return [
        { sessionKey: "unknown", entry: { updatedAt: 3000 } },
        { sessionKey: "beta-1", entry: { updatedAt: 1500 } },
      ];
    });

    const { getAgentLocalStatuses } = await import("./status.agent-local.js");

    await expect(getAgentLocalStatuses({ session: {} })).resolves.toEqual({
      defaultId: "alpha",
      totalSessions: 3,
      bootstrapPendingCount: 1,
      agents: [
        {
          id: "alpha",
          name: "Alpha",
          workspaceDir: "/workspace/alpha",
          bootstrapPending: true,
          sessionsPath: "/sessions/alpha.json",
          sessionsCount: 2,
          lastUpdatedAt: 2500,
          lastActiveAgeMs: 1500,
        },
        {
          id: "beta",
          name: "Beta",
          workspaceDir: "/workspace/beta",
          bootstrapPending: false,
          sessionsPath: "/sessions/beta.json",
          sessionsCount: 1,
          lastUpdatedAt: 1500,
          lastActiveAgeMs: 2500,
        },
      ],
    });
  });
});
