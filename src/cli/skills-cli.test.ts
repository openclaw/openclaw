import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { SkillStatusEntry, SkillStatusReport } from "../agents/skills-status.js";
import type { SkillEntry } from "../agents/skills.js";
import { captureEnv } from "../test-utils/env.js";
import { formatSkillInfo, formatSkillsCheck, formatSkillsList } from "./skills-cli.format.js";

// Unit tests: don't pay the runtime cost of loading/parsing the real skills loader.
vi.mock("@mariozechner/pi-coding-agent", () => ({
  loadSkillsFromDir: () => ({ skills: [] }),
  formatSkillsForPrompt: () => "",
}));

function createMockSkill(overrides: Partial<SkillStatusEntry> = {}): SkillStatusEntry {
  return {
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
    eligible: true,
    requirements: {
      bins: [],
      anyBins: [],
      env: [],
      config: [],
      os: [],
    },
    missing: {
      bins: [],
      anyBins: [],
      env: [],
      config: [],
      os: [],
    },
    configChecks: [],
    install: [],
    ...overrides,
  };
}

function createMockReport(skills: SkillStatusEntry[]): SkillStatusReport {
  return {
    workspaceDir: "/workspace",
    managedSkillsDir: "/managed",
    skills,
  };
}

describe("skills-cli", () => {
  describe("formatSkillsList", () => {
    it("formats empty skills list", () => {
      const report = createMockReport([]);
      const output = formatSkillsList(report, {});
      expect(output).toContain("No skills found");
      expect(output).toContain("npx clawhub");
    });

    it("formats skills list with eligible skill", () => {
      const report = createMockReport([
        createMockSkill({
          name: "peekaboo",
          description: "Capture UI screenshots",
          emoji: "📸",
          eligible: true,
        }),
      ]);
      const output = formatSkillsList(report, {});
      expect(output).toContain("peekaboo");
      expect(output).toContain("📸");
      expect(output).toContain("✓");
    });

    it("formats skills list with disabled skill", () => {
      const report = createMockReport([
        createMockSkill({
          name: "disabled-skill",
          disabled: true,
          eligible: false,
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
      expect(output).toContain("missing");
      expect(output).toContain("anyBins");
      expect(output).toContain("os:");
    });

    it("filters to eligible only with --eligible flag", () => {
      const report = createMockReport([
        createMockSkill({ name: "eligible-one", eligible: true }),
        createMockSkill({
          name: "not-eligible",
          eligible: false,
          disabled: true,
        }),
      ]);
      const output = formatSkillsList(report, { eligible: true });
      expect(output).toContain("eligible-one");
      expect(output).not.toContain("not-eligible");
    });

    it("outputs JSON with --json flag", () => {
      const report = createMockReport([createMockSkill({ name: "json-skill" })]);
      const output = formatSkillsList(report, { json: true });
      const parsed = JSON.parse(output);
      expect(parsed.skills).toHaveLength(1);
      expect(parsed.skills[0].name).toBe("json-skill");
    });
  });

  describe("formatSkillInfo", () => {
    it("returns not found message for unknown skill", () => {
      const report = createMockReport([]);
      const output = formatSkillInfo(report, "unknown-skill", {});
      expect(output).toContain("not found");
      expect(output).toContain("npx clawhub");
    });

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

    it("outputs JSON with --json flag", () => {
      const report = createMockReport([createMockSkill({ name: "info-skill" })]);
      const output = formatSkillInfo(report, "info-skill", { json: true });
      const parsed = JSON.parse(output);
      expect(parsed.name).toBe("info-skill");
    });
  });

  describe("formatSkillsCheck", () => {
    it("shows summary of skill status", () => {
      const report = createMockReport([
        createMockSkill({ name: "ready-1", eligible: true }),
        createMockSkill({ name: "ready-2", eligible: true }),
        createMockSkill({
          name: "not-ready",
          eligible: false,
          missing: { bins: ["go"], anyBins: [], env: [], config: [], os: [] },
        }),
        createMockSkill({ name: "disabled", eligible: false, disabled: true }),
      ]);
      const output = formatSkillsCheck(report, {});
      expect(output).toContain("2"); // eligible count
      expect(output).toContain("ready-1");
      expect(output).toContain("ready-2");
      expect(output).toContain("not-ready");
      expect(output).toContain("go"); // missing binary
      expect(output).toContain("npx clawhub");
    });

    it("outputs JSON with --json flag", () => {
      const report = createMockReport([
        createMockSkill({ name: "skill-1", eligible: true }),
        createMockSkill({ name: "skill-2", eligible: false }),
      ]);
      const output = formatSkillsCheck(report, { json: true });
      const parsed = JSON.parse(output);
      expect(parsed.summary.eligible).toBe(1);
      expect(parsed.summary.total).toBe(2);
    });
  });

  describe("integration: loads real skills from bundled directory", () => {
    let tempWorkspaceDir = "";
    let tempBundledDir = "";
    let envSnapshot: ReturnType<typeof captureEnv>;
    let buildWorkspaceSkillStatus: typeof import("../agents/skills-status.js").buildWorkspaceSkillStatus;

    beforeAll(async () => {
      envSnapshot = captureEnv(["OPENCLAW_BUNDLED_SKILLS_DIR"]);
      tempWorkspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-skills-test-"));
      tempBundledDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-bundled-skills-test-"));
      process.env.OPENCLAW_BUNDLED_SKILLS_DIR = tempBundledDir;
      ({ buildWorkspaceSkillStatus } = await import("../agents/skills-status.js"));
    });

    afterAll(() => {
      if (tempWorkspaceDir) {
        fs.rmSync(tempWorkspaceDir, { recursive: true, force: true });
      }
      if (tempBundledDir) {
        fs.rmSync(tempBundledDir, { recursive: true, force: true });
      }
      envSnapshot.restore();
    });

    const createEntries = (): SkillEntry[] => {
      const baseDir = path.join(tempWorkspaceDir, "peekaboo");
      return [
        {
          skill: {
            name: "peekaboo",
            description: "Capture UI screenshots",
            source: "openclaw-bundled",
            filePath: path.join(baseDir, "SKILL.md"),
            baseDir,
          } as SkillEntry["skill"],
          frontmatter: {},
          metadata: { emoji: "📸" },
        },
      ];
    };

    it("loads bundled skills and formats them", async () => {
      const entries = createEntries();
      const report = buildWorkspaceSkillStatus(tempWorkspaceDir, {
        managedSkillsDir: "/nonexistent",
        entries,
      });

      // Should have loaded some skills
      expect(report.skills.length).toBeGreaterThan(0);

      // Format should work without errors
      const listOutput = formatSkillsList(report, {});
      expect(listOutput).toContain("Skills");

      const checkOutput = formatSkillsCheck(report, {});
      expect(checkOutput).toContain("Total:");

      // JSON output should be valid
      const jsonOutput = formatSkillsList(report, { json: true });
      const parsed = JSON.parse(jsonOutput);
      expect(parsed.skills).toBeInstanceOf(Array);
    });

    it("formats info for a real bundled skill (peekaboo)", async () => {
      const entries = createEntries();
      const report = buildWorkspaceSkillStatus(tempWorkspaceDir, {
        managedSkillsDir: "/nonexistent",
        entries,
      });

      // peekaboo is a bundled skill that should always exist
      const peekaboo = report.skills.find((s) => s.name === "peekaboo");
      if (!peekaboo) {
        throw new Error("peekaboo fixture skill missing");
      }

      const output = formatSkillInfo(report, "peekaboo", {});
      expect(output).toContain("peekaboo");
      expect(output).toContain("Details:");
    });
  });
});
