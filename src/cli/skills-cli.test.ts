import { afterEach, describe, expect, it, vi } from "vitest";
import type { SkillStatusEntry, SkillStatusReport } from "../skills/discovery/status.js";
import { createEmptyInstallChecks } from "./requirements-test-fixtures.js";
import { formatSkillInfo, formatSkillsCheck, formatSkillsList } from "./skills-cli.format.js";

vi.mock("openclaw/plugin-sdk/agent-sessions", () => ({
  loadSkillsFromDir: () => ({ skills: [] }),
  formatSkillsForPrompt: () => "",
}));
function skill(name: string, overrides: Partial<SkillStatusEntry> = {}): SkillStatusEntry {
  const entry: SkillStatusEntry = {
    name,
    skillKey: name,
    description: "A test skill",
    source: "bundled",
    bundled: false,
    filePath: "/path/to/SKILL.md",
    baseDir: "/path/to",
    emoji: "🧪",
    homepage: "https://example.com",
    always: false,
    disabled: false,
    blockedByAllowlist: false,
    blockedByAgentFilter: false,
    eligible: true,
    platformIncompatible: false,
    modelVisible: true,
    userInvocable: true,
    commandVisible: true,
    ...createEmptyInstallChecks(),
    ...overrides,
  };
  entry.modelVisible = overrides.modelVisible ?? (entry.eligible && !entry.blockedByAgentFilter);
  entry.commandVisible =
    overrides.commandVisible ??
    (entry.eligible && !entry.blockedByAgentFilter && entry.userInvocable);
  return entry;
}
function report(skills: SkillStatusEntry[]): SkillStatusReport {
  return { workspaceDir: "/workspace", managedSkillsDir: "/managed", skills };
}
const missing = { bins: ["missing-tool"], anyBins: [], env: [], config: [], os: [] };

describe("skills formatting", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("preserves the named profile on every human ClawHub hint", () => {
    vi.stubEnv("OPENCLAW_PROFILE", "work");
    vi.stubEnv("OPENCLAW_CONTAINER_HINT", "");
    const empty = report([]);
    for (const output of [
      formatSkillsList(empty, {}),
      formatSkillInfo(empty, "missing", {}),
      formatSkillsCheck(empty, {}),
    ]) {
      for (const action of ["search", "install", "update"]) {
        expect(output).toContain(`openclaw --profile work skills ${action}`);
      }
    }
  });

  it("renders readiness and filters agent-excluded skills out of the eligible list", () => {
    const mixed = report([
      skill("ready", { emoji: "📸" }),
      skill("agent-excluded", {
        blockedByAgentFilter: true,
        homepage: undefined,
        emoji: undefined,
      }),
      skill("disabled-skill", { disabled: true, eligible: false }),
      skill("needs-stuff", {
        eligible: false,
        missing: { ...missing, anyBins: ["rg", "grep"], env: ["API_KEY"], os: ["darwin"] },
      }),
    ]);
    const output = formatSkillsList(mixed, { verbose: true });
    for (const text of [
      "1/4 ready",
      "📸",
      "✓",
      "excluded",
      "disabled",
      "needs setup",
      "anyBins",
      "os:",
    ]) {
      expect(output).toContain(text);
    }
    const info = formatSkillInfo(mixed, "agent-excluded", {});
    expect(info).toContain("Excluded by agent allowlist");
    expect(info).toContain("excludes this skill");
    const eligible = formatSkillsList(mixed, { eligible: true });
    expect(eligible).toContain("ready");
    for (const name of ["agent-excluded", "disabled-skill", "needs-stuff"]) {
      expect(eligible).not.toContain(name);
    }
  });

  it("resolves an unambiguous skill key", () => {
    expect(
      formatSkillInfo(
        report([
          skill("Excel XLSX", { skillKey: "Excel-XLSX", description: "Spreadsheet helpers" }),
        ]),
        "excel-xlsx",
        {},
      ),
    ).toContain("Spreadsheet helpers");
  });

  it("prefers an exact skill name over another skill's key in either discovery order", () => {
    const alias = skill("another-skill", { skillKey: "requested-skill" });
    const target = skill("requested-skill", { skillKey: "target-key" });
    for (const entries of [
      [alias, target],
      [target, alias],
    ]) {
      expect(
        JSON.parse(formatSkillInfo(report(entries), "requested-skill", { json: true })).name,
      ).toBe("requested-skill");
    }
  });

  it("rejects ambiguous exact key selectors regardless of discovery order", () => {
    const query = "shared-key";
    const skills = [skill("first", { skillKey: query }), skill("second", { skillKey: query })];
    for (const entries of [skills, skills.toReversed()]) {
      expect(JSON.parse(formatSkillInfo(report(entries), query, { json: true }))).toMatchObject({
        ok: false,
        skill: query,
      });
    }
  });

  it("reports readiness, model visibility and command access independently", () => {
    const mixed = {
      ...report([
        skill("ready", { emoji: "🎛\uFE0E" }),
        skill("prompt-hidden", { modelVisible: false }),
        skill("slash-hidden", { userInvocable: false }),
        skill("agent-filtered", { blockedByAgentFilter: true }),
        skill("excluded-missing", { eligible: false, blockedByAgentFilter: true, missing }),
        skill("missing-bin", { eligible: false, missing, emoji: "🎙\uFE0E" }),
        skill("disabled", {
          eligible: false,
          disabled: true,
          blockedByAllowlist: true,
          blockedByAgentFilter: true,
          missing,
        }),
        skill("blocked-bundled", {
          eligible: false,
          blockedByAllowlist: true,
          blockedByAgentFilter: true,
          missing,
        }),
      ]),
      agentId: "specialist",
      agentSkillFilter: ["ready", "prompt-hidden", "slash-hidden", "missing-bin"],
    };
    const parsed = JSON.parse(formatSkillsCheck(mixed, { json: true }));
    expect(parsed.summary).toEqual({
      total: 8,
      eligible: 4,
      modelVisible: 2,
      commandVisible: 2,
      disabled: 1,
      blocked: 1,
      agentFiltered: 4,
      notInjected: 1,
      missingRequirements: 2,
    });
    expect(parsed.modelVisible).toEqual(["ready", "slash-hidden"]);
    expect(parsed.commandVisible).toEqual(["ready", "prompt-hidden"]);
    expect(parsed.agentFiltered).toEqual([
      "agent-filtered",
      "excluded-missing",
      "disabled",
      "blocked-bundled",
    ]);
    expect(parsed.disabled).toEqual(["disabled"]);
    expect(parsed.blocked).toEqual(["blocked-bundled"]);
    expect(parsed.notInjected).toEqual([
      { name: "prompt-hidden", reason: "disable-model-invocation" },
    ]);
    expect(parsed.missingRequirements.map((entry: { name: string }) => entry.name)).toEqual([
      "excluded-missing",
      "missing-bin",
    ]);
    const human = formatSkillsCheck(mixed, {});
    for (const text of [
      "specialist",
      "🎛️ ready",
      "🎙️ missing-bin",
      "excluded-missing (bins: missing-tool)",
      "prompt-hidden (skill hides its instructions from the model; commands/cron may still use it)",
    ]) {
      expect(human).toContain(text);
    }
    for (const name of parsed.agentFiltered) {
      expect(human).toContain(`${name} (loaded, but this agent is not allowed to see/use it)`);
    }
  });

  it("explains standalone skills hidden from the model and commands", () => {
    vi.stubEnv("TERM", "dumb");
    const output = formatSkillsCheck(
      report([
        skill("standalone", {
          modelVisible: false,
          userInvocable: false,
          emoji: undefined,
        }),
      ]),
      {},
    );
    expect(output).toContain("\n  standalone");
    expect(output).toContain("is not exposed as a command");
    expect(output).not.toContain("commands/cron may still use it");
  });

  it("sanitizes ANSI and C1 controls in JSON fields", () => {
    const output = formatSkillsList(
      report([
        skill("json-skill", {
          emoji: "\u001b[31m📧\u001b[0m\u009f",
          description: "desc\u0093\u001b[2J\u001b[33m colored\u001b[0m",
        }),
      ]),
      { json: true },
    );
    expect(JSON.parse(output).skills[0]).toMatchObject({
      emoji: "📧",
      description: "desc colored",
    });
    expect(output).not.toContain("\\u001b");
  });

  it.each([false, true])("sanitizes the user-supplied not-found name (json: %s)", (json) => {
    const output = formatSkillInfo(report([]), "evil\u001b[31m\u009f", { json });
    if (json) {
      expect(JSON.parse(output)).toEqual({
        ok: false,
        error: { type: "cli_error", message: 'Skill "evil" not found.' },
        skill: "evil",
      });
    } else {
      expect(output).toContain('Skill "evil" not found');
    }
    expect(output).not.toContain("\u001b");
  });
});
