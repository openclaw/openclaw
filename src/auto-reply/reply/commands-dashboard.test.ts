import { describe, expect, it } from "vitest";
import type { SkillCommandSpec } from "../../skills/types.js";
import { normalizeCommandBody } from "../commands-registry-normalize.js";
import { handleDashboardCommand } from "./commands-dashboard.js";
import type { HandleCommandsParams } from "./commands-types.js";

const controlUiSkill: SkillCommandSpec = {
  name: "control-ui",
  skillName: "control-ui",
  description: "Operate the Control UI and build session dashboards.",
  skillFile: "/bundled/skills/control-ui/SKILL.md",
  skillSource: "bundled",
};
const workspaceControlUiSkill: SkillCommandSpec = {
  ...controlUiSkill,
  skillFile: "/workspace/skills/control-ui/SKILL.md",
  skillSource: "workspace",
};
const releaseNotesSkill: SkillCommandSpec = {
  name: "release_notes",
  skillName: "release-notes",
  description: "Summarize release notes.",
  skillFile: "/workspace/skills/release-notes/SKILL.md",
};
const controlUiSelections = [{ name: "control-ui", path: controlUiSkill.skillFile }];

function buildParams(body: string, skills: SkillCommandSpec[] = [controlUiSkill]) {
  return {
    ctx: { BodyForAgent: body },
    command: {
      commandBodyNormalized: body,
      isAuthorizedSender: true,
    },
    skillCommands: skills,
  } as unknown as HandleCommandsParams;
}

describe("dashboard command", () => {
  it("expands the Control UI skill for a bare dashboard request", async () => {
    const params = buildParams("/dashboard");
    const result = await handleDashboardCommand(params, true);
    const prompt = params.ctx.BodyForAgent ?? "";
    expect(result).toEqual({
      shouldContinue: true,
      explicitSkillSelections: controlUiSelections,
    });
    expect(prompt).toContain("Use the following explicitly referenced skills");
    expect(prompt).toContain("- control-ui");
    expect(prompt).toContain("Create a dashboard for this session.");
    expect(params.command.commandBodyNormalized).toBe(prompt);
  });

  it.each([" ", "\n"])(
    "preserves multiline requirements through normalization and skill expansion after %j",
    async (separator) => {
      const requirements = "Show these panels:\n- CPU\n  - per agent\n\n- open approvals";
      const params = buildParams(normalizeCommandBody(`/dashboard${separator}${requirements}`));

      const result = await handleDashboardCommand(params, true);

      expect(result?.explicitSkillSelections).toEqual(controlUiSelections);
      expect(params.ctx.BodyForAgent).toContain(`Dashboard requirements:\n${requirements}`);
    },
  );

  it("preserves additional explicit skills used by dashboard requirements", async () => {
    const params = buildParams("/dashboard include $release_notes", [
      controlUiSkill,
      releaseNotesSkill,
    ]);
    const result = await handleDashboardCommand(params, true);
    expect(result?.explicitSkillSelections).toEqual([
      ...controlUiSelections,
      { name: "release_notes", path: "/workspace/skills/release-notes/SKILL.md" },
    ]);
    expect(params.ctx.BodyForAgent).toContain("- release-notes");
  });

  it.each([false, true])("loads Control UI through bundled=%s discovery", async (bundled) => {
    const params = buildParams(
      bundled ? "/dashboard release health" : "/dashboard",
      bundled ? [workspaceControlUiSkill] : [],
    );
    if (bundled) {
      params.loadBundledSkillCommand = async () => controlUiSkill;
    } else {
      params.loadSkillCommands = async () => [controlUiSkill];
    }
    const result = await handleDashboardCommand(params, true);
    expect(result?.explicitSkillSelections).toEqual(controlUiSelections);
    expect(params.ctx.BodyForAgent).toContain(bundled ? "release health" : "- control-ui");
  });

  it("returns a deterministic reply when the Control UI skill is unavailable", async () => {
    const params = buildParams("/dashboard", []);

    const result = await handleDashboardCommand(params, true);

    expect(result).toMatchObject({
      shouldContinue: false,
      reply: { text: expect.stringContaining("control-ui skill is unavailable") },
    });
    expect(params.ctx.BodyForAgent).toBe("/dashboard");
  });
});
