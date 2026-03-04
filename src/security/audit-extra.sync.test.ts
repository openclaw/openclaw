import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  collectAttackSurfaceSummaryFindings,
  collectSmallModelRiskFindings,
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

describe("collectSmallModelRiskFindings web search key detection", () => {
  const baseCfg: OpenClawConfig = {
    agents: {
      defaults: {
        model: "qwen2.5-3b-instruct",
      },
    },
  };

  it("treats GEMINI_API_KEY as enabling web_search exposure", () => {
    const findings = collectSmallModelRiskFindings({
      cfg: baseCfg,
      env: { GEMINI_API_KEY: "gemini-key" } as NodeJS.ProcessEnv,
    });
    expect(findings[0]?.detail).toContain("web_search");
  });

  it("treats XAI_API_KEY as enabling web_search exposure", () => {
    const findings = collectSmallModelRiskFindings({
      cfg: baseCfg,
      env: { XAI_API_KEY: "xai-key" } as NodeJS.ProcessEnv,
    });
    expect(findings[0]?.detail).toContain("web_search");
  });

  it("treats KIMI_API_KEY as enabling web_search exposure", () => {
    const findings = collectSmallModelRiskFindings({
      cfg: baseCfg,
      env: { KIMI_API_KEY: "kimi-key" } as NodeJS.ProcessEnv,
    });
    expect(findings[0]?.detail).toContain("web_search");
  });
});
