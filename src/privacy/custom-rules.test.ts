import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadCustomRules,
  processCustomRulesConfig,
  validateUserRule,
  validateRegexSafety,
  registerNamedValidator,
  getNamedValidators,
} from "./custom-rules.js";
import { PrivacyDetector } from "./detector.js";
import { PrivacyReplacer } from "./replacer.js";
import type { CustomRulesConfig, UserDefinedRule } from "./types.js";

describe("custom-rules", () => {
  describe("loadCustomRules", () => {
    it("parses real JSON5 syntax", () => {
      const dir = mkdtempSync(join(tmpdir(), "privacy-custom-rules-"));
      const filePath = join(dir, "rules.json5");

      try {
        writeFileSync(
          filePath,
          `
          {
            extends: 'none',
            rules: [
              {
                type: 'employee_id',
                description: 'Employee ID',
                riskLevel: 'medium',
                pattern: '\\\\bEMP-[0-9]{6}\\\\b',
              },
            ],
          }
          `,
        );

        const loaded = loadCustomRules(filePath);
        expect(loaded.errors).toHaveLength(0);
        expect(loaded.rules.some((r) => r.type === "employee_id")).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("resolves relative rules path from config directory instead of cwd", () => {
      const root = mkdtempSync(join(tmpdir(), "privacy-custom-rules-rel-"));
      const configDir = join(root, "config");
      const workspaceDir = join(root, "workspace");
      const configPath = join(configDir, "openclaw.json");
      const rulesPath = join(configDir, "my-rules.json5");
      const prevCwd = process.cwd();
      const prevConfigPath = process.env.OPENCLAW_CONFIG_PATH;

      try {
        mkdirSync(configDir, { recursive: true });
        mkdirSync(workspaceDir, { recursive: true });
        writeFileSync(configPath, "{}\n");
        writeFileSync(
          rulesPath,
          `
          {
            extends: 'none',
            rules: [
              {
                type: 'workspace_secret',
                description: 'workspace secret',
                riskLevel: 'high',
                pattern: 'WORKSPACE_SECRET_[A-Z]+',
              },
            ],
          }
          `,
        );
        process.env.OPENCLAW_CONFIG_PATH = configPath;
        process.chdir(workspaceDir);

        const loaded = loadCustomRules("./my-rules.json5");
        expect(loaded.errors).toHaveLength(0);
        expect(loaded.rules.some((r) => r.type === "workspace_secret")).toBe(true);
      } finally {
        process.chdir(prevCwd);
        if (prevConfigPath === undefined) {
          delete process.env.OPENCLAW_CONFIG_PATH;
        } else {
          process.env.OPENCLAW_CONFIG_PATH = prevConfigPath;
        }
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("falls back safely when parsed root is not an object", () => {
      const dir = mkdtempSync(join(tmpdir(), "privacy-custom-rules-badroot-"));
      const filePath = join(dir, "rules.json5");
      try {
        writeFileSync(filePath, "null\n");
        const loaded = loadCustomRules(filePath);
        expect(loaded.rules.some((r) => r.type === "email")).toBe(true);
        expect(loaded.warnings.some((w) => w.includes("must parse to an object"))).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("validateUserRule", () => {
    it("accepts a valid rule with pattern", () => {
      const rule: UserDefinedRule = {
        type: "employee_id",
        description: "Employee ID",
        riskLevel: "medium",
        pattern: "\\bEMP-[0-9]{6}\\b",
      };
      expect(validateUserRule(rule, 0)).toHaveLength(0);
    });

    it("accepts a valid rule with keywords", () => {
      const rule: UserDefinedRule = {
        type: "project_codename",
        description: "Internal codename",
        riskLevel: "high",
        keywords: ["Phoenix", "Titan"],
        caseSensitive: true,
      };
      expect(validateUserRule(rule, 0)).toHaveLength(0);
    });

    it("rejects non-array keywords", () => {
      const rule = {
        type: "project_codename",
        description: "Internal codename",
        riskLevel: "high",
        keywords: { bad: true },
      } as unknown as UserDefinedRule;
      const errors = validateUserRule(rule, 0);
      expect(errors.some((e) => e.field === "keywords")).toBe(true);
    });

    it("rejects empty keywords", () => {
      const rule: UserDefinedRule = {
        type: "project_codename",
        description: "Internal codename",
        riskLevel: "high",
        keywords: [""],
      };
      const errors = validateUserRule(rule, 0);
      expect(
        errors.some((e) => e.field === "keywords" && e.message.includes("must not be empty")),
      ).toBe(true);
    });

    it("rejects non-array context.mustContain", () => {
      const rule = {
        type: "context_rule",
        description: "Context rule",
        riskLevel: "medium",
        pattern: "password",
        context: { mustContain: "password" },
      } as unknown as UserDefinedRule;
      const errors = validateUserRule(rule, 0);
      expect(errors.some((e) => e.field === "context.mustContain")).toBe(true);
    });

    it("rejects non-array context.mustNotContain", () => {
      const rule = {
        type: "context_rule",
        description: "Context rule",
        riskLevel: "medium",
        pattern: "password",
        context: { mustNotContain: "ignore" },
      } as unknown as UserDefinedRule;
      const errors = validateUserRule(rule, 0);
      expect(errors.some((e) => e.field === "context.mustNotContain")).toBe(true);
    });

    it("rejects missing type", () => {
      const rule = {
        description: "test",
        riskLevel: "low",
        pattern: "abc",
      } as UserDefinedRule;
      const errors = validateUserRule(rule, 0);
      expect(errors.some((e) => e.field === "type")).toBe(true);
    });

    it("rejects invalid type format (uppercase)", () => {
      const rule: UserDefinedRule = {
        type: "MyRule",
        description: "test",
        riskLevel: "low",
        pattern: "abc",
      };
      const errors = validateUserRule(rule, 0);
      expect(errors.some((e) => e.field === "type")).toBe(true);
    });

    it("rejects missing description", () => {
      const rule = {
        type: "test_rule",
        riskLevel: "low",
        pattern: "abc",
      } as unknown as UserDefinedRule;
      const errors = validateUserRule(rule, 0);
      expect(errors.some((e) => e.field === "description")).toBe(true);
    });

    it("rejects invalid riskLevel", () => {
      const rule: UserDefinedRule = {
        type: "test_rule",
        description: "test",
        riskLevel: "extreme" as "critical",
        pattern: "abc",
      };
      const errors = validateUserRule(rule, 0);
      expect(errors.some((e) => e.field === "riskLevel")).toBe(true);
    });

    it("rejects rule with neither pattern nor keywords", () => {
      const rule: UserDefinedRule = {
        type: "test_rule",
        description: "test",
        riskLevel: "low",
      };
      const errors = validateUserRule(rule, 0);
      expect(errors.some((e) => e.field === "pattern")).toBe(true);
    });

    it("rejects invalid regex pattern", () => {
      const rule: UserDefinedRule = {
        type: "test_rule",
        description: "test",
        riskLevel: "low",
        pattern: "[invalid(",
      };
      const errors = validateUserRule(rule, 0);
      expect(errors.some((e) => e.field === "pattern")).toBe(true);
    });

    it("rejects unknown validateFn", () => {
      const rule: UserDefinedRule = {
        type: "test_rule",
        description: "test",
        riskLevel: "low",
        pattern: "abc",
        validateFn: "nonexistent",
      };
      const errors = validateUserRule(rule, 0);
      expect(errors.some((e) => e.field === "validateFn")).toBe(true);
    });

    it("accepts known validateFn", () => {
      const rule: UserDefinedRule = {
        type: "test_rule",
        description: "test",
        riskLevel: "low",
        pattern: "\\S{8,64}",
        validateFn: "bare_password",
      };
      expect(validateUserRule(rule, 0)).toHaveLength(0);
    });
  });

  describe("validateRegexSafety", () => {
    it("accepts valid regex", () => {
      expect(validateRegexSafety("\\b[A-Z]{3}\\d{4}\\b")).toBeNull();
    });

    it("rejects invalid regex", () => {
      expect(validateRegexSafety("[unclosed")).not.toBeNull();
    });

    it("rejects overly long patterns", () => {
      const longPattern = "a".repeat(2001);
      expect(validateRegexSafety(longPattern)).toContain("maximum length");
    });

    it("rejects nested quantifiers", () => {
      expect(validateRegexSafety("(a+)+")).toContain("safe-regex validation");
    });

    it("rejects ambiguous alternation backtracking patterns", () => {
      expect(validateRegexSafety("(a|aa)+$")).toContain("safe-regex validation");
    });

    it("accepts (?i) prefix", () => {
      expect(validateRegexSafety("(?i)hello")).toBeNull();
    });
  });

  describe("processCustomRulesConfig", () => {
    it("extends from extended preset by default", () => {
      const config: CustomRulesConfig = { rules: [] };
      const result = processCustomRulesConfig(config);
      expect(result.rules.length).toBeGreaterThan(0);
      expect(result.errors).toHaveLength(0);
      // Should include an email rule from extended preset.
      expect(result.rules.some((r) => r.type === "email")).toBe(true);
    });

    it("extends from basic preset", () => {
      const config: CustomRulesConfig = { extends: "basic", rules: [] };
      const result = processCustomRulesConfig(config);
      expect(result.rules.some((r) => r.type === "email")).toBe(true);
      // Basic doesn't have phone_hk.
      expect(result.rules.some((r) => r.type === "phone_hk")).toBe(false);
    });

    it("extends from none preset", () => {
      const config: CustomRulesConfig = {
        extends: "none",
        rules: [
          {
            type: "custom_only",
            description: "Custom rule",
            riskLevel: "low",
            pattern: "CUSTOM_\\d+",
          },
        ],
      };
      const result = processCustomRulesConfig(config);
      expect(result.rules).toHaveLength(1);
      expect(result.rules[0].type).toBe("custom_only");
    });

    it("disables specified built-in rules", () => {
      const config: CustomRulesConfig = {
        extends: "basic",
        disable: ["email", "phone_cn"],
        rules: [],
      };
      const result = processCustomRulesConfig(config);
      const emailRule = result.rules.find((r) => r.type === "email");
      const phoneRule = result.rules.find((r) => r.type === "phone_cn");
      expect(emailRule?.enabled).toBe(false);
      expect(phoneRule?.enabled).toBe(false);
    });

    it("ignores malformed disable field without throwing", () => {
      const config = {
        extends: "basic",
        disable: { email: true },
        rules: [],
      } as unknown as CustomRulesConfig;
      const result = processCustomRulesConfig(config);
      const emailRule = result.rules.find((r) => r.type === "email");
      expect(emailRule?.enabled).toBe(true);
      expect(result.warnings.some((w) => w.includes("disable must be an array"))).toBe(true);
    });

    it("user rules override built-in rules with same type", () => {
      const config: CustomRulesConfig = {
        extends: "basic",
        rules: [
          {
            type: "email",
            description: "Custom email (low risk)",
            riskLevel: "low",
            pattern: "\\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}\\b",
          },
        ],
      };
      const result = processCustomRulesConfig(config);
      const emailRule = result.rules.find((r) => r.type === "email");
      expect(emailRule?.riskLevel).toBe("low");
      expect(emailRule?.description).toBe("Custom email (low risk)");
    });

    it("appends new user rules after base rules", () => {
      const config: CustomRulesConfig = {
        extends: "none",
        rules: [
          {
            type: "custom_id",
            description: "Custom ID",
            riskLevel: "medium",
            pattern: "CID-\\d{8}",
          },
        ],
      };
      const result = processCustomRulesConfig(config);
      expect(result.rules).toHaveLength(1);
      expect(result.rules[0].type).toBe("custom_id");
    });

    it("skips invalid rules and reports errors", () => {
      const config: CustomRulesConfig = {
        extends: "none",
        rules: [
          {
            type: "valid_rule",
            description: "Valid",
            riskLevel: "low",
            pattern: "abc",
          },
          {
            type: "InvalidType",
            description: "Bad type format",
            riskLevel: "low",
            pattern: "def",
          },
        ],
      };
      const result = processCustomRulesConfig(config);
      expect(result.rules).toHaveLength(1);
      expect(result.rules[0].type).toBe("valid_rule");
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].ruleIndex).toBe(1);
    });

    it("reports non-object entries in rules array instead of throwing", () => {
      const config = {
        extends: "none",
        rules: [null, { type: "ok", description: "ok", riskLevel: "low", pattern: "ok" }],
      } as unknown as CustomRulesConfig;
      const result = processCustomRulesConfig(config);
      expect(result.rules).toHaveLength(1);
      expect(result.rules[0].type).toBe("ok");
      expect(result.errors.some((e) => e.field === "rules")).toBe(true);
    });

    it("resolves validateFn to actual functions", () => {
      const config: CustomRulesConfig = {
        extends: "none",
        rules: [
          {
            type: "custom_password",
            description: "Custom password detector",
            riskLevel: "high",
            pattern: "\\S{8,64}",
            validateFn: "bare_password",
          },
        ],
      };
      const result = processCustomRulesConfig(config);
      expect(result.rules[0].validate).toBeDefined();
      expect(typeof result.rules[0].validate).toBe("function");
    });

    it("propagates replacementTemplate", () => {
      const config: CustomRulesConfig = {
        extends: "none",
        rules: [
          {
            type: "employee_id",
            description: "Employee ID",
            riskLevel: "medium",
            pattern: "\\bEMP-[0-9]{6}\\b",
            replacementTemplate: "EMP-{seq}00000",
          },
        ],
      };
      const result = processCustomRulesConfig(config);
      expect(result.rules[0].replacementTemplate).toBe("EMP-{seq}00000");
    });
  });

  describe("custom rules end-to-end", () => {
    it("detector uses custom rules for detection", () => {
      const config: CustomRulesConfig = {
        extends: "none",
        rules: [
          {
            type: "employee_id",
            description: "Employee ID",
            riskLevel: "medium",
            pattern: "\\bEMP-[0-9]{6}\\b",
          },
        ],
      };
      const { rules } = processCustomRulesConfig(config);
      const detector = new PrivacyDetector(rules);

      const result = detector.detect("Contact EMP-123456 for details");
      expect(result.hasPrivacyRisk).toBe(true);
      expect(result.matches).toHaveLength(1);
      expect(result.matches[0].type).toBe("employee_id");
      expect(result.matches[0].content).toBe("EMP-123456");
    });

    it("detector uses keyword-based custom rules", () => {
      const config: CustomRulesConfig = {
        extends: "none",
        rules: [
          {
            type: "project_codename",
            description: "Internal codename",
            riskLevel: "high",
            keywords: ["Project-Phoenix", "Project-Titan"],
            caseSensitive: true,
          },
        ],
      };
      const { rules } = processCustomRulesConfig(config);
      const detector = new PrivacyDetector(rules);

      const result = detector.detect("We are working on Project-Phoenix");
      expect(result.hasPrivacyRisk).toBe(true);
      expect(result.matches[0].content).toBe("Project-Phoenix");
    });

    it("replacer uses custom replacementTemplate", () => {
      const config: CustomRulesConfig = {
        extends: "none",
        rules: [
          {
            type: "employee_id",
            description: "Employee ID",
            riskLevel: "medium",
            pattern: "\\bEMP-[0-9]{6}\\b",
            replacementTemplate: "EMP-REDACTED-{seq}",
          },
        ],
      };
      const { rules } = processCustomRulesConfig(config);
      const detector = new PrivacyDetector(rules);
      const replacer = new PrivacyReplacer("test-session");

      const detected = detector.detect("Employee EMP-123456 is active");
      const { replaced } = replacer.replaceAll(detected.matches[0].content, detected.matches);
      // The replacement should use the template, not the default switch-case.
      expect(replaced).toContain("EMP-REDACTED-");
    });

    it("replacer uses custom template with {original_prefix:N}", () => {
      const config: CustomRulesConfig = {
        extends: "none",
        rules: [
          {
            type: "internal_code",
            description: "Internal code",
            riskLevel: "low",
            pattern: "\\bINT-[A-Z]{4}-\\d{4}\\b",
            replacementTemplate: "{original_prefix:4}XXXX-0000",
          },
        ],
      };
      const { rules } = processCustomRulesConfig(config);
      const detector = new PrivacyDetector(rules);
      const replacer = new PrivacyReplacer("test-session");

      const text = "Code: INT-ABCD-1234";
      const detected = detector.detect(text);
      const { replaced } = replacer.replaceAll(text, detected.matches);
      expect(replaced).toContain("INT-XXXX-0000");
    });

    it("disabled built-in rules are not detected", () => {
      const config: CustomRulesConfig = {
        extends: "basic",
        disable: ["email"],
        rules: [],
      };
      const { rules } = processCustomRulesConfig(config);
      const detector = new PrivacyDetector(rules);

      const result = detector.detect("Contact user@example.com");
      const emailMatches = result.matches.filter((m) => m.type === "email");
      expect(emailMatches).toHaveLength(0);
    });

    it("custom context constraints work", () => {
      const config: CustomRulesConfig = {
        extends: "none",
        rules: [
          {
            type: "internal_ip",
            description: "Internal IP with context",
            riskLevel: "low",
            pattern: "\\b\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\b",
            context: { mustContain: ["server", "host"] },
          },
        ],
      };
      const { rules } = processCustomRulesConfig(config);
      const detector = new PrivacyDetector(rules);

      // Without context keyword — should not match.
      const r1 = detector.detect("Address: 192.168.1.1");
      expect(r1.matches.filter((m) => m.type === "internal_ip")).toHaveLength(0);

      // With context keyword — should match.
      const r2 = detector.detect("Server IP: 192.168.1.1");
      expect(r2.matches.filter((m) => m.type === "internal_ip")).toHaveLength(1);
    });
  });

  describe("registerNamedValidator", () => {
    it("registers and makes available a custom validator", () => {
      const customValidator = (s: string) => s.length > 10;
      registerNamedValidator("custom_length", customValidator);
      expect(getNamedValidators()).toContain("custom_length");

      const rule: UserDefinedRule = {
        type: "test_rule",
        description: "test",
        riskLevel: "low",
        pattern: "\\S+",
        validateFn: "custom_length",
      };
      expect(validateUserRule(rule, 0)).toHaveLength(0);
    });
  });
});
