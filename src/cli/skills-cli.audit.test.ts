import { describe, it, expect } from "vitest";
import type { SkillEntryWithPermissions } from "../agents/skills/types.js";
import {
  formatSkillsAudit,
  formatSkillAuditDetail,
  generateManifestTemplate,
} from "./skills-cli.js";

// Create a mock skill entry with permissions
function createMockSkillEntry(
  overrides: Partial<{
    name: string;
    source: string;
    hasManifest: boolean;
    riskLevel: "minimal" | "low" | "moderate" | "high" | "critical";
    riskFactors: string[];
    warnings: string[];
  }> = {},
): SkillEntryWithPermissions {
  const name = overrides.name ?? "test-skill";
  const hasManifest = overrides.hasManifest ?? true;
  const riskLevel = overrides.riskLevel ?? "minimal";
  const riskFactors = overrides.riskFactors ?? [];
  const warnings = overrides.warnings ?? [];

  return {
    skill: {
      name,
      description: `Description for ${name}`,
      source: overrides.source ?? "test-source",
      filePath: `/path/to/${name}/SKILL.md`,
      baseDir: `/path/to/${name}`,
      prompt: "Test prompt",
    },
    metadata: {
      skillKey: name,
    },
    frontmatter: {},
    permissions: hasManifest
      ? {
          version: 1,
          declared_purpose: "Test purpose",
        }
      : undefined,
    permissionValidation: {
      valid: true,
      warnings,
      errors: [],
      risk_level: riskLevel,
      risk_factors: riskFactors,
    },
  };
}

describe("formatSkillsAudit", () => {
  it("should show summary for all skills", () => {
    const skills = [
      createMockSkillEntry({ name: "skill-a", riskLevel: "minimal" }),
      createMockSkillEntry({ name: "skill-b", riskLevel: "high", hasManifest: false }),
      createMockSkillEntry({ name: "skill-c", riskLevel: "critical" }),
    ];

    const output = formatSkillsAudit(skills, {});

    expect(output).toContain("Skills Permission Audit");
    expect(output).toContain("Total skills: 3");
    expect(output).toContain("With permission manifest: 2");
    expect(output).toContain("Without manifest: 1");
    expect(output).toContain("Critical: 1");
    expect(output).toContain("High: 1");
    expect(output).toContain("Minimal: 1");
  });

  it("should filter by risk level", () => {
    const skills = [
      createMockSkillEntry({ name: "skill-a", riskLevel: "minimal" }),
      createMockSkillEntry({ name: "skill-b", riskLevel: "high" }),
      createMockSkillEntry({ name: "skill-c", riskLevel: "critical" }),
    ];

    const output = formatSkillsAudit(skills, { riskLevel: "high" });

    expect(output).toContain("skill-b");
    expect(output).toContain("skill-c");
    // The minimal risk skill is still in the summary but not in the filtered table
    expect(output).toContain("Total skills: 3");
  });

  it("should show risk factors in verbose mode", () => {
    const skills = [
      createMockSkillEntry({
        name: "risky-skill",
        riskLevel: "high",
        riskFactors: ["Accesses credentials", "Shell exec"],
      }),
    ];

    const output = formatSkillsAudit(skills, { verbose: true });

    expect(output).toContain("Risk Factors");
    expect(output).toContain("credentials");
  });

  it("should output JSON format", () => {
    const skills = [createMockSkillEntry({ name: "skill-a", riskLevel: "low" })];

    const output = formatSkillsAudit(skills, { json: true });
    const parsed = JSON.parse(output);

    expect(parsed.total).toBe(1);
    expect(parsed.skills[0].name).toBe("skill-a");
    expect(parsed.skills[0].riskLevel).toBe("low");
    expect(parsed.skills[0].hasManifest).toBe(true);
  });

  it("should show recommendations for missing manifests", () => {
    const skills = [createMockSkillEntry({ name: "skill-a", hasManifest: false })];

    const output = formatSkillsAudit(skills, {});

    expect(output).toContain("Recommendations");
    expect(output).toContain("lack permission manifests");
    expect(output).toContain("init-manifest");
  });

  it("should show recommendations for high-risk skills", () => {
    const skills = [createMockSkillEntry({ name: "skill-a", riskLevel: "critical" })];

    const output = formatSkillsAudit(skills, {});

    expect(output).toContain("high/critical risk");
    expect(output).toContain("Review their permissions");
  });
});

describe("formatSkillAuditDetail", () => {
  it("should show detailed permission info", () => {
    const skill = createMockSkillEntry({
      name: "detailed-skill",
      riskLevel: "moderate",
      riskFactors: ["Accesses network"],
    });
    skill.permissions = {
      version: 1,
      declared_purpose: "API client for weather",
      network: ["api.weather.com"],
    };

    const output = formatSkillAuditDetail(skill, {});

    expect(output).toContain("detailed-skill");
    expect(output).toContain("API client for weather");
    expect(output).toContain("api.weather.com");
    expect(output).toContain("MODERATE");
  });

  it("should output JSON format", () => {
    const skill = createMockSkillEntry({ name: "json-skill" });

    const output = formatSkillAuditDetail(skill, { json: true });
    const parsed = JSON.parse(output);

    expect(parsed.name).toBe("json-skill");
    expect(parsed.hasManifest).toBe(true);
    expect(parsed.validation).toBeDefined();
  });

  it("should show warning for missing manifest", () => {
    const skill = createMockSkillEntry({
      name: "no-manifest-skill",
      hasManifest: false,
    });

    const output = formatSkillAuditDetail(skill, {});

    expect(output).toContain("NO permission manifest");
    expect(output).toContain("unknown");
  });
});

describe("generateManifestTemplate", () => {
  it("should generate valid YAML template", () => {
    const output = generateManifestTemplate("my-skill");

    expect(output).toContain("Permission Manifest for my-skill");
    expect(output).toContain("metadata:");
    expect(output).toContain("openclaw:");
    expect(output).toContain("permissions:");
    expect(output).toContain("version: 1");
    expect(output).toContain("declared_purpose:");
  });

  it("should include all permission types", () => {
    const output = generateManifestTemplate("full-skill");

    expect(output).toContain("filesystem:");
    expect(output).toContain("network:");
    expect(output).toContain("env:");
    expect(output).toContain("exec:");
  });

  it("should include optional flags documentation", () => {
    const output = generateManifestTemplate("advanced-skill");

    expect(output).toContain("elevated:");
    expect(output).toContain("system_config:");
    expect(output).toContain("sensitive_data:");
    expect(output).toContain("security_notes:");
  });

  it("should include JSON template at bottom", () => {
    const output = generateManifestTemplate("json-skill");

    // Should have valid JSON at the end
    expect(output).toContain('"version": 1');
    expect(output).toContain('"declared_purpose"');
  });
});
