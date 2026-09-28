import { afterEach, describe, expect, it, vi } from "vitest";
import type { SkillStatusEntry, SkillStatusReport } from "../skills/discovery/status.js";
import { createEmptyInstallChecks } from "./requirements-test-fixtures.js";
import { formatSkillInfo, formatSkillsCheck, formatSkillsList } from "./skills-cli.format.js";

// Unit tests: don't pay the runtime cost of loading/parsing the real skills loader.
vi.mock("openclaw/plugin-sdk/agent-sessions", () => ({
  loadSkillsFromDir: () => ({ skills: [] }),
  formatSkillsForPrompt: () => "",
}));

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
    platformIncompatible: false,
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

describe("skills-cli", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("ClawHub command hints", () => {
    it("preserves the named profile on every human skill surface", () => {
      vi.stubEnv("OPENCLAW_PROFILE", "work");
      vi.stubEnv("OPENCLAW_CONTAINER_HINT", "");
      const prefix = "openclaw --profile work";
      const report = createMockReport([]);
      const outputs = [
        formatSkillsList(report, {}),
        formatSkillInfo(report, "missing-skill", {}),
        formatSkillsCheck(report, {}),
      ];

      for (const output of outputs) {
        for (const action of ["search", "install", "update"]) {
          expect(output).toContain(`${prefix} skills ${action}`);
        }
      }
    });

    it("keeps profile and container guidance out of machine-readable skill output", () => {
      vi.stubEnv("OPENCLAW_PROFILE", "work");
      vi.stubEnv("OPENCLAW_CONTAINER_HINT", "demo");
      const report = createMockReport([]);
      const outputs = [
        formatSkillsList(report, { json: true }),
        formatSkillInfo(report, "missing-skill", { json: true }),
        formatSkillsCheck(report, { json: true }),
      ];

      for (const output of outputs) {
        expect(() => JSON.parse(output)).not.toThrow();
        expect(output).not.toContain("Tip:");
        expect(output).not.toContain("openclaw --profile");
        expect(output).not.toContain("openclaw --container");
      }
    });
  });

  describe("formatSkillsList", () => {
    it("formats skills list with disabled skill", () => {
      const report = createMockReport([
        createMockSkill({
          name: "disabled-skill",
          disabled: true,
          eligible: false,
          platformIncompatible: false,
        }),
      ]);
      const output = formatSkillsList(report, {});
      expect(output).toContain("disabled-skill");
      expect(output).toContain("disabled");
    });

    it("formats skills list with missing requirements", () => {
      const report = createMockReport([
        createMockSkill({
          name: "needs-stuff",
          eligible: false,
          platformIncompatible: false,
          missing: {
            bins: ["ffmpeg"],
            anyBins: ["rg", "grep"],
            env: ["API_KEY"],
            config: [],
            os: ["darwin"],
          },
        }),
      ]);
      const output = formatSkillsList(report, { verbose: true });
      expect(output).toContain("needs-stuff");
      expect(output).toContain("needs setup");
      expect(output).toContain("anyBins");
      expect(output).toContain("os:");
    });

    it("filters to eligible only with --eligible flag", () => {
      const report = createMockReport([
        createMockSkill({ name: "eligible-one", eligible: true }),
        createMockSkill({
          name: "not-eligible",
          eligible: false,
          platformIncompatible: false,
          disabled: true,
        }),
      ]);
      const output = formatSkillsList(report, { eligible: true });
      expect(output).toContain("eligible-one");
      expect(output).not.toContain("not-eligible");
    });

    it("does not label agent-excluded skills as ready", () => {
      const report = createMockReport([
        createMockSkill({ name: "ready-one", emoji: "📸", eligible: true }),
        createMockSkill({
          name: "agent-excluded",
          eligible: true,
          platformIncompatible: false,
          blockedByAgentFilter: true,
        }),
      ]);

      const output = formatSkillsList(report, {});
      expect(output).toContain("1/2 ready");
      expect(output).toContain("📸");
      expect(output).toContain("✓");
      expect(output).toContain("agent-excluded");
      expect(output).toContain("excluded");

      const eligibleOnly = formatSkillsList(report, { eligible: true });
      expect(eligibleOnly).toContain("ready-one");
      expect(eligibleOnly).not.toContain("agent-excluded");
    });
  });

  describe("formatSkillInfo", () => {
    it("shows detailed info for a skill", () => {
      const report = createMockReport([
        createMockSkill({
          name: "detailed-skill",
          description: "A detailed description",
          homepage: "https://example.com",
          requirements: {
            bins: ["node"],
            anyBins: ["rg", "grep"],
            env: ["API_KEY"],
            config: [],
            os: [],
          },
          missing: {
            bins: [],
            anyBins: [],
            env: ["API_KEY"],
            config: [],
            os: [],
          },
        }),
      ]);
      const output = formatSkillInfo(report, "detailed-skill", {});
      expect(output).toContain("detailed-skill");
      expect(output).toContain("A detailed description");
      expect(output).toContain("https://example.com");
      expect(output).toContain("node");
      expect(output).toContain("Any binaries");
      expect(output).toContain("API_KEY");
    });

    it("resolves skill info case-insensitively", () => {
      const report = createMockReport([
        createMockSkill({
          name: "Excel XLSX",
          skillKey: "Excel-XLSX",
          description: "Spreadsheet helpers",
        }),
      ]);

      const output = formatSkillInfo(report, "excel-xlsx", {});
      expect(output).toContain("Spreadsheet helpers");
    });

    it("resolves skill info across separator variants", () => {
      const report = createMockReport([
        createMockSkill({
          name: "Excel XLSX",
          skillKey: "excel_xlsx",
          description: "Spreadsheet helpers",
        }),
      ]);

      const output = formatSkillInfo(report, "excel-xlsx", {});
      expect(output).toContain("Spreadsheet helpers");
    });

    it("prefers the exact skill name over another skill's key in either discovery order", () => {
      const alias = createMockSkill({ name: "another-skill", skillKey: "requested-skill" });
      const target = createMockSkill({ name: "requested-skill", skillKey: "target-key" });

      for (const skills of [
        [alias, target],
        [target, alias],
      ]) {
        const output = formatSkillInfo(createMockReport(skills), "requested-skill", { json: true });
        expect(JSON.parse(output).name).toBe("requested-skill");
      }
    });

    it("rejects an ambiguous exact skill key instead of selecting the first discovered skill", () => {
      const first = createMockSkill({ name: "first-skill", skillKey: "shared-key" });
      const second = createMockSkill({ name: "second-skill", skillKey: "shared-key" });

      for (const skills of [
        [first, second],
        [second, first],
      ]) {
        const output = formatSkillInfo(createMockReport(skills), "shared-key", { json: true });
        expect(JSON.parse(output)).toMatchObject({ ok: false, skill: "shared-key" });
      }
    });

    it("returns not found for ambiguous case-insensitive matches", () => {
      const report = createMockReport([
        createMockSkill({ name: "First Skill", skillKey: "Excel-XLSX", description: "first" }),
        createMockSkill({ name: "Second Skill", skillKey: "excel-xlsx", description: "second" }),
      ]);

      const output = formatSkillInfo(report, "EXCEL-XLSX", {});
      expect(output).toContain("not found");
      expect(output).not.toContain("first");
      expect(output).not.toContain("second");
    });

    it("returns not found for ambiguous normalized matches", () => {
      const report = createMockReport([
        createMockSkill({ name: "Excel/XLSX", skillKey: "excel-slash", description: "first" }),
        createMockSkill({
          name: "Excel_XLSX",
          skillKey: "excel-underscore",
          description: "second",
        }),
      ]);

      const output = formatSkillInfo(report, "excel-xlsx", {});
      expect(output).toContain("not found");
      expect(output).not.toContain("first");
      expect(output).not.toContain("second");
    });

    it("sanitizes user-supplied skill name in not-found text output", () => {
      const report = createMockReport([]);
      const output = formatSkillInfo(report, "evil\u001b[31m\u009f", {});

      expect(output).toContain('Skill "evil" not found');
      expect(output).not.toContain("\u001b");
    });

    it("shows agent exclusion and visibility details in skill info", () => {
      const report = createMockReport([
        createMockSkill({
          name: "agent-excluded",
          eligible: true,
          platformIncompatible: false,
          blockedByAgentFilter: true,
        }),
      ]);

      const output = formatSkillInfo(report, "agent-excluded", {});
      expect(output).toContain("Excluded by agent allowlist");
      expect(output).toContain("Visible to model");
      expect(output).toContain("Available as command");
      expect(output).toContain("excludes this skill");
    });
  });

  describe("formatSkillsCheck", () => {
    it("normalizes text-presentation emoji selectors in check output", () => {
      const report = createMockReport([
        createMockSkill({ name: "ready-emoji", emoji: "🎛\uFE0E", eligible: true }),
        createMockSkill({
          name: "missing-emoji",
          emoji: "🎙\uFE0E",
          eligible: false,
          platformIncompatible: false,
          missing: { bins: ["ffmpeg"], anyBins: [], env: [], config: [], os: [] },
        }),
      ]);

      const output = formatSkillsCheck(report, {});
      expect(output).toContain("🎛️ ready-emoji");
      expect(output).toContain("🎙️ missing-emoji");
    });

    it("does not imply prompt-hidden non-command skills can be called explicitly", () => {
      const report = createMockReport([
        createMockSkill({
          name: "internal-hidden",
          eligible: true,
          platformIncompatible: false,
          modelVisible: false,
          commandVisible: false,
          userInvocable: false,
        }),
      ]);

      const output = formatSkillsCheck(report, {});
      expect(output).toContain("internal-hidden");
      expect(output).toContain("is not exposed as a command");
      expect(output).not.toContain("commands/cron may still use it");
    });

    it("accounts for readiness independently of agent exclusion in a mixed skill pack", () => {
      const report = {
        ...createMockReport([
          createMockSkill({ name: "ready", eligible: true }),
          createMockSkill({
            name: "prompt-hidden",
            eligible: true,
            platformIncompatible: false,
            modelVisible: false,
            commandVisible: true,
          }),
          createMockSkill({
            name: "slash-hidden",
            eligible: true,
            platformIncompatible: false,
            modelVisible: true,
            userInvocable: false,
            commandVisible: false,
          }),
          createMockSkill({
            name: "agent-filtered",
            eligible: true,
            platformIncompatible: false,
            blockedByAgentFilter: true,
          }),
          createMockSkill({
            name: "excluded-missing",
            eligible: false,
            blockedByAgentFilter: true,
            missing: { bins: ["missing-tool"], anyBins: [], env: [], config: [], os: [] },
          }),
          createMockSkill({
            name: "missing-bin",
            eligible: false,
            platformIncompatible: false,
            missing: { bins: ["missing-tool"], anyBins: [], env: [], config: [], os: [] },
          }),
          createMockSkill({
            name: "disabled",
            eligible: false,
            disabled: true,
            blockedByAllowlist: true,
            blockedByAgentFilter: true,
            missing: { bins: ["missing-tool"], anyBins: [], env: [], config: [], os: [] },
          }),
          createMockSkill({
            name: "blocked-bundled",
            eligible: false,
            platformIncompatible: false,
            blockedByAllowlist: true,
            blockedByAgentFilter: true,
            missing: { bins: ["missing-tool"], anyBins: [], env: [], config: [], os: [] },
          }),
        ]),
        agentId: "specialist",
        agentSkillFilter: ["ready", "prompt-hidden", "slash-hidden", "missing-bin"],
      };
      const output = formatSkillsCheck(report, { json: true });

      const parsed = JSON.parse(output) as {
        summary: Record<string, number>;
        eligible: string[];
        disabled: string[];
        blocked: string[];
        modelVisible: string[];
        commandVisible: string[];
        agentFiltered: string[];
        notInjected: Array<{ name: string; reason: string }>;
        missingRequirements: Array<{ name: string }>;
      };
      const readinessNames = [
        ...parsed.eligible,
        ...parsed.disabled,
        ...parsed.blocked,
        ...parsed.missingRequirements.map((entry) => entry.name),
      ];
      expect(readinessNames.toSorted()).toEqual(
        report.skills.map((skill) => skill.name).toSorted(),
      );
      expect(readinessNames.length).toBe(parsed.summary.total);
      expect(parsed.summary.total).toBe(8);
      expect(parsed.summary.eligible).toBe(4);
      expect(parsed.summary.modelVisible).toBe(2);
      expect(parsed.summary.commandVisible).toBe(2);
      expect(parsed.summary.disabled).toBe(1);
      expect(parsed.summary.blocked).toBe(1);
      expect(parsed.summary.agentFiltered).toBe(4);
      expect(parsed.summary.notInjected).toBe(1);
      expect(parsed.summary.missingRequirements).toBe(2);
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
      expect(parsed.missingRequirements.map((entry) => entry.name)).toEqual([
        "excluded-missing",
        "missing-bin",
      ]);
      const human = formatSkillsCheck(report, {});
      expect(human).toContain("specialist");
      expect(human).toContain("Ready but hidden from model prompt");
      expect(human).toContain("commands/cron may still use it");
      expect(human).toContain("excluded-missing (bins: missing-tool)");
      for (const name of parsed.agentFiltered) {
        expect(human).toContain(`${name} (loaded, but this agent is not allowed to see/use it)`);
      }
    });
  });

  describe("JSON output", () => {
    it("sanitizes ANSI and C1 controls in skills list JSON output", () => {
      const report = createMockReport([
        createMockSkill({
          name: "json-skill",
          emoji: "\u001b[31m📧\u001b[0m\u009f",
          description: "desc\u0093\u001b[2J\u001b[33m colored\u001b[0m",
        }),
      ]);

      const output = formatSkillsList(report, { json: true });
      const parsed = JSON.parse(output) as {
        skills: Array<{ emoji: string; description: string }>;
      };

      expect(parsed.skills[0]?.emoji).toBe("📧");
      expect(parsed.skills[0]?.description).toBe("desc colored");
      expect(output).not.toContain("\\u001b");
    });

    it("sanitizes skills info JSON output", () => {
      const report = createMockReport([
        createMockSkill({
          name: "info-json",
          emoji: "\u001b[31m🎙\u001b[0m\u009f",
          description: "hi\u0091",
          homepage: "https://example.com/\u0092docs",
        }),
      ]);

      const output = formatSkillInfo(report, "info-json", { json: true });
      const parsed = JSON.parse(output) as {
        emoji: string;
        description: string;
        homepage: string;
      };

      expect(parsed.emoji).toBe("🎙");
      expect(parsed.description).toBe("hi");
      expect(parsed.homepage).toBe("https://example.com/docs");
    });

    it("sanitizes user-supplied skill name in not-found JSON output", () => {
      const report = createMockReport([]);
      const output = formatSkillInfo(report, "evil\u001b[31m\u009f", { json: true });
      const parsed = JSON.parse(output) as {
        ok: boolean;
        error: { type: string; message: string };
        skill: string;
      };

      expect(parsed.ok).toBe(false);
      expect(parsed.error).toEqual({
        type: "cli_error",
        message: 'Skill "evil" not found.',
      });
      expect(parsed.skill).toBe("evil");
      expect(output).not.toContain("\u001b");
    });
  });
});
