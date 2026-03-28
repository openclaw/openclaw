import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  collectAttackSurfaceSummaryFindings,
  collectSmallModelRiskFindings,
} from "./audit-extra.sync.js";
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
      name: "reports both hook systems as disabled when neither is configured",
      cfg: {} satisfies OpenClawConfig,
      expectedDetail: ["hooks.webhooks: disabled", "hooks.internal: disabled"],
    },
  ])("$name", ({ cfg, expectedDetail }) => {
    const [finding] = collectAttackSurfaceSummaryFindings(cfg);
    expect(finding.checkId).toBe("summary.attack_surface");
    for (const snippet of expectedDetail) {
      expect(finding.detail).toContain(snippet);
    }
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
  const baseCfg = {
    agents: { defaults: { model: { primary: "ollama/mistral-8b" } } },
    browser: { enabled: false },
    tools: { web: { fetch: { enabled: false } } },
  } satisfies OpenClawConfig;

  it.each([
    {
      name: "gemini plugin config",
      cfg: {
        ...baseCfg,
        plugins: {
          entries: {
            google: { enabled: true, config: { webSearch: { apiKey: "AIza-test" } } },
          },
        },
      } satisfies OpenClawConfig,
      env: {},
    },
    {
      name: "gemini env key",
      cfg: baseCfg,
      env: { GEMINI_API_KEY: "AIza-test" },
    },
    {
      name: "grok env key",
      cfg: baseCfg,
      env: { XAI_API_KEY: "xai-test" },
    },
    {
      name: "kimi env key",
      cfg: baseCfg,
      env: { KIMI_API_KEY: "sk-kimi-test" },
    },
    {
      name: "moonshot env key",
      cfg: baseCfg,
      env: { MOONSHOT_API_KEY: "sk-moonshot-test" },
    },
    {
      name: "openrouter env fallback",
      cfg: baseCfg,
      env: { OPENROUTER_API_KEY: "sk-or-v1-test" },
    },
  ])("$name", ({ cfg, env }) => {
    const [finding] = collectSmallModelRiskFindings({
      cfg,
      env,
    });

    expect(finding?.checkId).toBe("models.small_params");
    expect(finding?.severity).toBe("critical");
    expect(finding?.detail).toContain("web_search");
  });
});
