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
    ["OPENROUTER_API_KEY", "sk-or-v1-test"],
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

  it.each([
    ["perplexity", { perplexity: { apiKey: "pplx-key" } }], // pragma: allowlist secret
    ["gemini", { gemini: { apiKey: "gemini-key" } }], // pragma: allowlist secret
    ["grok", { grok: { apiKey: "grok-key" } }], // pragma: allowlist secret
    ["kimi", { kimi: { apiKey: "kimi-key" } }], // pragma: allowlist secret
  ])("treats %s search config credentials as enabling web_search exposure", (_provider, search) => {
    const findings = collectSmallModelRiskFindings({
      cfg: {
        agents: {
          defaults: {
            model: "qwen2.5-7b-instruct",
          },
        },
        tools: {
          web: {
            search,
          },
        },
      } as OpenClawConfig,
      env: {},
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.detail).toContain("web_search");
    expect(findings[0]?.detail).not.toContain("web=[off]");
  });

  it.each([
    ["perplexity", { OPENROUTER_API_KEY: "sk-or-v1-test" }], // pragma: allowlist secret
    ["grok", { XAI_API_KEY: "xai-env-key" }], // pragma: allowlist secret
  ])(
    "treats %s explicit provider env credentials as enabling web_search exposure",
    (provider, env) => {
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
                provider,
              },
            },
          },
        } as OpenClawConfig,
        env: env as NodeJS.ProcessEnv,
      });

      expect(findings).toHaveLength(1);
      expect(findings[0]?.detail).toContain("web_search");
      expect(findings[0]?.detail).not.toContain("web=[off]");
    },
  );

  it.each([
    [
      "perplexity ignores unrelated grok env keys",
      "perplexity",
      { XAI_API_KEY: "xai-env-key" }, // pragma: allowlist secret
      undefined,
    ],
    [
      "perplexity ignores unrelated grok config keys",
      "perplexity",
      {},
      { grok: { apiKey: "grok-key" } }, // pragma: allowlist secret
    ],
    [
      "grok ignores unrelated perplexity env keys",
      "grok",
      { OPENROUTER_API_KEY: "sk-or-v1-test" }, // pragma: allowlist secret
      undefined,
    ],
    [
      "grok ignores unrelated perplexity config keys",
      "grok",
      {},
      { perplexity: { apiKey: "pplx-key" } }, // pragma: allowlist secret
    ],
  ])("%s", (_name, provider, env, searchOverrides) => {
    const findings = collectSmallModelRiskFindings({
      cfg: {
        agents: {
          defaults: {
            model: "qwen2.5-7b-instruct",
          },
        },
        browser: {
          enabled: false,
        },
        tools: {
          web: {
            fetch: {
              enabled: false,
            },
            search: {
              provider,
              ...searchOverrides,
            },
          },
        },
      } as OpenClawConfig,
      env: env as NodeJS.ProcessEnv,
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.detail).not.toContain("web_search");
    expect(findings[0]?.detail).toContain("web=[off]");
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
