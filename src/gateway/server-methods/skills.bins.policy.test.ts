import { describe, expect, it, vi } from "vitest";

const loadWorkspaceSkillEntriesMock = vi.fn();

vi.mock("../../config/config.js", () => ({
  loadConfig: () => ({}),
  writeConfigFile: vi.fn(),
}));

vi.mock("../../agents/agent-scope.js", () => ({
  listAgentIds: () => ["ops", "qa"],
  resolveAgentWorkspaceDir: (_cfg: unknown, agentId: string) => `/tmp/${agentId}`,
  resolveDefaultAgentId: () => "ops",
}));

vi.mock("../../agents/skills.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/skills.js")>();
  return {
    ...actual,
    loadWorkspaceSkillEntries: (
      workspaceDir: string,
      options?: { agentId?: string; applyEligibility?: boolean },
    ) => loadWorkspaceSkillEntriesMock(workspaceDir, options),
  };
});

const { skillsHandlers } = await import("./skills.js");

describe("skills.bins", () => {
  it("loads skill bins per agent with policy-scoped agentId", async () => {
    loadWorkspaceSkillEntriesMock.mockReset();
    loadWorkspaceSkillEntriesMock.mockImplementation(
      (_workspaceDir: string, options?: { agentId?: string }) => {
        if (options?.agentId === "ops") {
          return [
            {
              metadata: {
                requires: {
                  bins: ["git"],
                },
              },
            },
          ];
        }
        return [
          {
            metadata: {
              requires: {
                bins: ["jq"],
              },
            },
          },
        ];
      },
    );

    let ok: boolean | null = null;
    let payload: unknown;
    await skillsHandlers["skills.bins"]({
      params: {},
      req: {} as never,
      client: null as never,
      isWebchatConnect: () => false,
      context: {} as never,
      respond: (success, result) => {
        ok = success;
        payload = result;
      },
    });

    expect(ok).toBe(true);
    expect(loadWorkspaceSkillEntriesMock).toHaveBeenCalledWith("/tmp/ops", {
      config: {},
      agentId: "ops",
      applyEligibility: false,
    });
    expect(loadWorkspaceSkillEntriesMock).toHaveBeenCalledWith("/tmp/qa", {
      config: {},
      agentId: "qa",
      applyEligibility: false,
    });
    expect(payload).toEqual({ bins: ["git", "jq"] });
  });
});
