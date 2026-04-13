import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  collectAttackSurfaceSummaryFindings,
  collectSmallModelRiskFindings,
} from "./audit-extra.summary.js";
import { collectExposureMatrixFindings } from "./audit-extra.sync.js";
import { safeEqualSecret } from "./secret-equal.js";

describe("collectAttackSurfaceSummaryFindings", () => {
  it.each([
    {
      name: "distinguishes external webhooks from internal hooks when only internal hooks are enabled",
      cfg: {
        hooks: { internal: { enabled: true } },
      } satisfies OpenClawConfig,
      expectedDetail: ["hooks.webhooks: disabled", "hooks.internal: enabled"],
    },
    {
      name: "reports both hook systems as enabled when both are configured",
      cfg: {
        hooks: { enabled: true, internal: { enabled: true } },
      } satisfies OpenClawConfig,
      expectedDetail: ["hooks.webhooks: enabled", "hooks.internal: enabled"],
    },
    {
      name: "reports internal hooks as enabled by default and webhooks as disabled when neither is configured",
      cfg: {} satisfies OpenClawConfig,
      expectedDetail: ["hooks.webhooks: disabled", "hooks.internal: enabled"],
    },
    {
      name: "reports internal hooks as disabled when explicitly set to false",
      cfg: {
        hooks: { internal: { enabled: false } },
      } satisfies OpenClawConfig,
      expectedDetail: ["hooks.internal: disabled"],
    },
  ])("$name", ({ cfg, expectedDetail }) => {
    const [finding] = collectAttackSurfaceSummaryFindings(cfg);
    expect(finding.checkId).toBe("summary.attack_surface");
    for (const snippet of expectedDetail) {
      expect(finding.detail).toContain(snippet);
    }
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
  it.each([
    ["secret-token", "secret-token", true],
    ["secret-token", "secret-tokEn", false],
    ["short", "much-longer", false],
    [undefined, "secret", false],
    ["secret", undefined, false],
    [null, "secret", false],
  ] as const)("compares %o and %o", (left, right, expected) => {
    expect(safeEqualSecret(left, right)).toBe(expected);
  });
});

describe("collectSmallModelRiskFindings", () => {
  const browserOffCfg = {
    agents: { defaults: { model: { primary: "ollama/mistral-8b" } } },
    browser: { enabled: false },
    tools: { web: { fetch: { enabled: false } } },
  } satisfies OpenClawConfig;
  const browserDefaultCfg = {
    agents: { defaults: { model: { primary: "ollama/mistral-8b" } } },
    tools: { web: { fetch: { enabled: false } } },
  } satisfies OpenClawConfig;

  it.each([
    {
      name: "small model without sandbox all stays critical even when browser/web tools are off",
      cfg: browserOffCfg,
      env: {},
      detailIncludes: ["web=[off]", "No web/browser tools detected"],
      detailExcludes: ["web=[browser]"],
    },
    {
      name: "treats browser as enabled by default when browser config is omitted",
      cfg: browserDefaultCfg,
      env: {},
      detailIncludes: ["web=[browser]"],
      detailExcludes: ["No web/browser tools detected"],
    },
  ])("$name", ({ cfg, env, detailIncludes, detailExcludes }) => {
    const [finding] = collectSmallModelRiskFindings({
      cfg,
      env,
    });

    expect(finding?.checkId).toBe("models.small_params");
    expect(finding?.severity).toBe("critical");
    expect(finding?.detail).toContain("ollama/mistral-8b");
    for (const snippet of detailIncludes) {
      expect(finding?.detail).toContain(snippet);
    }
    for (const snippet of detailExcludes) {
      expect(finding?.detail).not.toContain(snippet);
    }
  });
});
