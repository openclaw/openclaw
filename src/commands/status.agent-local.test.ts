import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAgentLocalStatuses } from "./status.agent-local.js";

const mocks = vi.hoisted(() => ({
  listGatewayAgentsBasic: vi.fn(),
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: vi.fn((_cfg: unknown, agentId: string) => `/tmp/${agentId}`),
}));
vi.mock("../config/sessions/paths.js", () => ({
  resolveStorePath: vi.fn(
    (_store: unknown, opts: { agentId: string }) => `/tmp/${opts.agentId}/sessions.json`,
  ),
}));
vi.mock("../config/sessions/session-accessor.js", () => ({
  listSessionEntriesReadOnly: vi.fn(() => []),
}));
vi.mock("../gateway/agent-list.js", () => ({
  listGatewayAgentsBasic: mocks.listGatewayAgentsBasic,
}));
vi.mock("../infra/fs-safe.js", () => ({
  pathExists: vi.fn(async () => false),
}));

describe("getAgentLocalStatuses", () => {
  beforeEach(() => {
    mocks.listGatewayAgentsBasic.mockReset();
  });

  it("omits the compatibility default for an ownerless explicit fleet", async () => {
    mocks.listGatewayAgentsBasic.mockReturnValue({
      defaultId: "ops",
      ownership: "explicit",
      selectionRequired: true,
      mainKey: "main",
      scope: "per-sender",
      agents: [
        { id: "ops", kind: "agent" },
        { id: "research", kind: "agent" },
      ],
    });

    const result = await getAgentLocalStatuses({
      agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
    });

    expect(result).not.toHaveProperty("defaultId");
    expect(result.agents.map((agent) => agent.id)).toEqual(["ops", "research"]);
  });
});
