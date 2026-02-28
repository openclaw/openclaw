import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

// @mariozechner/pi-coding-agent uses 'strip-ansi' which is a missing transitive
// dep in the published package. Mock the module so the test worker can load the
// source files under test without triggering the broken import chain:
// audit-extra.sync → agents/sandbox → sandbox/context → agents/skills →
// agents/skills/workspace → @mariozechner/pi-coding-agent → bash-executor → strip-ansi
vi.mock("@mariozechner/pi-coding-agent", () => ({
  CURRENT_SESSION_VERSION: 1,
  SessionManager: vi.fn(),
  codingTools: [],
  createReadTool: vi.fn(),
  createEditTool: vi.fn(),
  createWriteTool: vi.fn(),
  readTool: {},
  formatSkillsForPrompt: vi.fn(() => ""),
  loadSkillsFromDir: vi.fn(async () => []),
  estimateTokens: vi.fn(() => 0),
  generateSummary: vi.fn(async () => ""),
}));
import {
  collectAttackSurfaceSummaryFindings,
  collectExposureMatrixFindings,
} from "./audit-extra.sync.js";
import { safeEqualSecret } from "./secret-equal.js";

describe("collectAttackSurfaceSummaryFindings", () => {
  it("distinguishes external webhooks from internal hooks when only internal hooks are enabled", () => {
    const cfg: OpenClawConfig = {
      hooks: { internal: { enabled: true } },
    };

    const [finding] = collectAttackSurfaceSummaryFindings(cfg);
    expect(finding.checkId).toBe("summary.attack_surface");
    expect(finding.detail).toContain("hooks.webhooks: disabled");
    expect(finding.detail).toContain("hooks.internal: enabled");
  });

  it("reports both hook systems as enabled when both are configured", () => {
    const cfg: OpenClawConfig = {
      hooks: { enabled: true, internal: { enabled: true } },
    };

    const [finding] = collectAttackSurfaceSummaryFindings(cfg);
    expect(finding.detail).toContain("hooks.webhooks: enabled");
    expect(finding.detail).toContain("hooks.internal: enabled");
  });

  it("reports both hook systems as disabled when neither is configured", () => {
    const cfg: OpenClawConfig = {};

    const [finding] = collectAttackSurfaceSummaryFindings(cfg);
    expect(finding.detail).toContain("hooks.webhooks: disabled");
    expect(finding.detail).toContain("hooks.internal: disabled");
  });
});

describe('summarizeGroupPolicy via collectAttackSurfaceSummaryFindings: Telegram "members"', () => {
  // Telegram "members" is a stricter membership-verification mode and must be
  // counted in the allowlist bucket, not the open bucket.
  // Non-Telegram "members" normalizes to "open" so it counts as open.

  it('counts channels.telegram.groupPolicy="members" in the allowlist bucket (not open)', () => {
    const cfg: OpenClawConfig = {
      channels: {
        telegram: { groupPolicy: "members" },
      },
    };

    const [finding] = collectAttackSurfaceSummaryFindings(cfg);
    // Telegram "members" => allowlist (restricted), not open
    expect(finding.detail).toContain("groups: open=0, allowlist=1");
  });

  it('counts channels.discord.groupPolicy="members" in the open bucket (non-Telegram normalizes to open)', () => {
    const cfg: OpenClawConfig = {
      channels: {
        discord: { groupPolicy: "members" },
      },
    };

    const [finding] = collectAttackSurfaceSummaryFindings(cfg);
    // Non-Telegram "members" normalizes to "open"
    expect(finding.detail).toContain("groups: open=1, allowlist=0");
  });
});

describe('listGroupPolicyOpen via collectExposureMatrixFindings: Telegram "members"', () => {
  // collectExposureMatrixFindings surfaces open groupPolicy paths; Telegram
  // "members" must NOT appear there (it is allowlist-equivalent).

  it('does NOT flag channels.telegram with groupPolicy="members" as open', () => {
    const cfg: OpenClawConfig = {
      channels: {
        telegram: { groupPolicy: "members" },
      },
      // Ensure elevated tools are on so a finding would be emitted if groupPolicy were open.
      tools: { elevated: { enabled: true } },
    };

    const findings = collectExposureMatrixFindings(cfg);
    // Telegram "members" is allowlist-equivalent → no "open" paths → no exposure finding
    expect(findings).toHaveLength(0);
  });

  it('DOES flag channels.discord with groupPolicy="members" as open (non-Telegram = open)', () => {
    const cfg: OpenClawConfig = {
      channels: {
        discord: { groupPolicy: "members" },
      },
      tools: { elevated: { enabled: true } },
    };

    const findings = collectExposureMatrixFindings(cfg);
    // discord "members" normalizes to "open" → exposure finding should appear
    expect(findings.length).toBeGreaterThan(0);
    const detail = findings.map((f) => f.detail).join("\n");
    expect(detail).toContain("channels.discord.groupPolicy");
  });
});

describe("safeEqualSecret", () => {
  it("matches identical secrets", () => {
    expect(safeEqualSecret("secret-token", "secret-token")).toBe(true);
  });

  it("rejects mismatched secrets", () => {
    expect(safeEqualSecret("secret-token", "secret-tokEn")).toBe(false);
  });

  it("rejects different-length secrets", () => {
    expect(safeEqualSecret("short", "much-longer")).toBe(false);
  });

  it("rejects missing values", () => {
    expect(safeEqualSecret(undefined, "secret")).toBe(false);
    expect(safeEqualSecret("secret", undefined)).toBe(false);
    expect(safeEqualSecret(null, "secret")).toBe(false);
  });
});
