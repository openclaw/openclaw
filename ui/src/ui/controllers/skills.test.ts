import { describe, expect, it, vi } from "vitest";
import { updateSkillType } from "./skills.ts";
import type { SkillsState } from "./skills.ts";

function createState(): { state: SkillsState; request: ReturnType<typeof vi.fn> } {
  const request = vi.fn();
  const state: SkillsState = {
    client: {
      request,
    } as unknown as SkillsState["client"],
    connected: true,
    skillsLoading: false,
    skillsReport: {
      workspaceDir: "/tmp/workspace",
      managedSkillsDir: "/tmp/skills",
      defaultSkills: ["playwright"],
      skills: [
        {
          name: "playwright",
          description: "Browser automation",
          source: "openclaw-bundled",
          filePath: "skills/playwright/SKILL.md",
          baseDir: "skills/playwright",
          skillKey: "playwright",
          always: false,
          disabled: false,
          blockedByAllowlist: false,
          eligible: true,
          type: "default",
          selectedByAgents: [],
          requirements: { bins: [], anyBins: [], env: [], config: [], os: [] },
          missing: { bins: [], anyBins: [], env: [], config: [], os: [] },
          configChecks: [],
          install: [],
        },
        {
          name: "proactive-agent",
          description: "Proactive support",
          source: "workspace",
          filePath: "skills/proactive-agent/SKILL.md",
          baseDir: "skills/proactive-agent",
          skillKey: "proactive-agent",
          always: false,
          disabled: false,
          blockedByAllowlist: false,
          eligible: true,
          type: "optional",
          selectedByAgents: [],
          requirements: { bins: [], anyBins: [], env: [], config: [], os: [] },
          missing: { bins: [], anyBins: [], env: [], config: [], os: [] },
          configChecks: [],
          install: [],
        },
      ],
    },
    skillsError: null,
    skillsBusyKey: null,
    skillEdits: {},
    skillMessages: {},
  };
  return { state, request };
}

describe("updateSkillType", () => {
  it("applies server defaultSkills to local report immediately", async () => {
    const { state, request } = createState();
    request.mockResolvedValue({
      defaultSkills: ["playwright", "proactive-agent"],
      type: "default",
    });

    await updateSkillType(state, {
      skillKey: "proactive-agent",
      skillName: "proactive-agent",
      type: "default",
    });

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("skills.update", {
      skillKey: "proactive-agent",
      skillName: "proactive-agent",
      type: "default",
    });
    expect(state.skillsReport?.defaultSkills).toEqual(["playwright", "proactive-agent"]);
    expect(
      state.skillsReport?.skills.find((entry) => entry.skillKey === "proactive-agent")?.type,
    ).toBe("default");
    expect(state.skillsReport?.skills.find((entry) => entry.skillKey === "playwright")?.type).toBe(
      "default",
    );
    expect(state.skillMessages["proactive-agent"]).toEqual({
      kind: "success",
      message: "Added to default skills",
    });
  });

  it("falls back to requested type when response omits defaultSkills", async () => {
    const { state, request } = createState();
    request.mockResolvedValue({ type: "optional" });

    await updateSkillType(state, {
      skillKey: "playwright",
      skillName: "playwright",
      type: "optional",
    });

    expect(state.skillsReport?.skills.find((entry) => entry.skillKey === "playwright")?.type).toBe(
      "optional",
    );
    expect(
      state.skillsReport?.skills.find((entry) => entry.skillKey === "proactive-agent")?.type,
    ).toBe("optional");
    expect(state.skillMessages["playwright"]).toEqual({
      kind: "success",
      message: "Marked as optional",
    });
  });
});
