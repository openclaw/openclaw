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

describe("collectSmallModelRiskFindings", () => {
  it.each([
    ["GEMINI_API_KEY", "gemini-env-key"],
    ["XAI_API_KEY", "xai-env-key"],
    ["KIMI_API_KEY", "kimi-env-key"],
    ["MOONSHOT_API_KEY", "moonshot-env-key"],
  ])("detects web_search exposure via env var %s", (envVar, envValue) => {
    const findings = collectSmallModelRiskFindings({
      cfg: {
        agents: {
          defaults: {
            model: "qwen2.5-7b-instruct",
          },
        },
      } satisfies OpenClawConfig,
      env: { [envVar]: envValue } as unknown as NodeJS.ProcessEnv,
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.detail).toContain("web_search");
    expect(findings[0]?.detail).not.toContain("web=[off]");
  });

  it("treats gemini search credentials as enabling web_search exposure", () => {
    const findings = collectSmallModelRiskFindings({
      cfg: {
        agents: {
          defaults: {
            model: "qwen2.5-7b-instruct",
          },
        },
        tools: {
          web: {
            search: {
              gemini: {
                apiKey: "gemini-key",
              },
            },
          },
        },
      } satisfies OpenClawConfig,
      env: {},
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.detail).toContain("web_search");
    expect(findings[0]?.detail).not.toContain("web=[off]");
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
