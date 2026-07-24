// Formatter tests for `openclaw skills check` remediation hints.
import { describe, expect, it } from "vitest";
import type { SkillStatusEntry, SkillStatusReport } from "../skills/discovery/status.js";
import { createEmptyInstallChecks } from "./requirements-test-fixtures.js";
import { formatSkillsCheck } from "./skills-cli.format.js";

function createMockSkill(overrides: Partial<SkillStatusEntry> = {}): SkillStatusEntry {
  const skill: SkillStatusEntry = {
    name: "test-skill",
    description: "A test skill",
    source: "bundled",
    bundled: false,
    filePath: "/path/to/SKILL.md",
    baseDir: "/path/to",
    skillKey: "test-skill",
    emoji: "🧪",
    homepage: "https://example.com",
    always: false,
    disabled: false,
    blockedByAllowlist: false,
    blockedByAgentFilter: false,
    eligible: true,
    modelVisible: true,
    userInvocable: true,
    commandVisible: true,
    ...createEmptyInstallChecks(),
    ...overrides,
  };
  if (overrides.modelVisible === undefined) {
    skill.modelVisible = skill.eligible && !skill.blockedByAgentFilter;
  }
  if (overrides.commandVisible === undefined) {
    skill.commandVisible = skill.eligible && !skill.blockedByAgentFilter && skill.userInvocable;
  }
  return skill;
}

function createMockReport(skills: SkillStatusEntry[]): SkillStatusReport {
  return {
    workspaceDir: "/workspace",
    managedSkillsDir: "/managed",
    skills,
  };
}

describe("formatSkillsCheck remediation hints", () => {
  it("tells authors how to fix each problem section", () => {
    const report = createMockReport([
      createMockSkill({
        name: "prompt-hidden",
        eligible: true,
        modelVisible: false,
        commandVisible: true,
      }),
      createMockSkill({
        name: "not-assigned",
        eligible: true,
        blockedByAgentFilter: true,
      }),
      createMockSkill({
        name: "missing-reqs",
        eligible: false,
        missing: { bins: ["ffmpeg"], anyBins: [], env: [], config: [], os: [] },
      }),
    ]);

    const output = formatSkillsCheck(report, {});

    // Hidden from model prompt remediation.
    expect(output).toContain("disable-model-invocation: false");
    // Agent allowlist remediation.
    expect(output).toContain("agents.list[].skills");
    // Missing requirements remediation.
    expect(output).toContain("openclaw skills info <name>");
  });
});
