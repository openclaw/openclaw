// Covers synchronous extra security audit aggregation.
import { expectDefined } from "@openclaw/normalization-core/expect";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  createConfigResolutionFacts,
  setConfigResolutionFacts,
} from "../config/resolution-facts.js";
import {
  collectAttackSurfaceSummaryFindings,
  collectSmallModelRiskFindings,
} from "./audit-extra.summary.js";
import { collectSecretsInConfigFindings } from "./audit-secrets.js";

vi.mock("../plugins/web-search-credential-presence.js", () => ({
  hasConfiguredWebSearchCredential: () => false,
}));

describe("collectSecretsInConfigFindings", () => {
  it("distinguishes resolved env secrets from byte-identical stored literals", () => {
    const config = {
      gateway: { auth: { password: "synthetic-gateway-password" } },
      hooks: { enabled: true, token: "synthetic-hooks-token" },
    } satisfies OpenClawConfig;
    const resolved = new Map([
      ["gateway.auth.password", "GATEWAY_PASSWORD"],
      ["hooks.token", "HOOKS_TOKEN"],
    ]);
    setConfigResolutionFacts(
      config,
      createConfigResolutionFacts([], new Map(), undefined, resolved),
    );
    expect(collectSecretsInConfigFindings(config)).toEqual([]);

    setConfigResolutionFacts(config, createConfigResolutionFacts([]));
    expect(collectSecretsInConfigFindings(config).map((finding) => finding.checkId)).toEqual([
      "config.secrets.gateway_password_in_config",
      "config.secrets.hooks_token_in_config",
    ]);
  });

  it("distinguishes an unresolved password from byte-identical literal text", () => {
    const config = {
      gateway: { auth: { password: "${GATEWAY_PASSWORD}" } },
    } satisfies OpenClawConfig;
    setConfigResolutionFacts(config, new Set(["gateway.auth.password"]));
    expect(collectSecretsInConfigFindings(config)).toHaveLength(0);

    setConfigResolutionFacts(config, new Set());
    expect(collectSecretsInConfigFindings(config)).toHaveLength(1);
  });
});

describe("collectAttackSurfaceSummaryFindings", () => {
  it.each([
    ["internal hooks enabled", { hooks: { internal: { enabled: true } } }, "enabled"],
    ["internal hooks unconfigured", {}, "disabled"],
  ] satisfies [string, OpenClawConfig, string][])("%s", async (_name, cfg, internalStatus) => {
    const finding = expectDefined(
      (await collectAttackSurfaceSummaryFindings(cfg)).at(0),
      "attack surface summary finding",
    );
    expect(finding.checkId).toBe("summary.attack_surface");
    for (const snippet of ["hooks.webhooks: disabled", `hooks.internal: ${internalStatus}`]) {
      expect(finding.detail).toContain(snippet);
    }
  });
});

describe("collectSmallModelRiskFindings", () => {
  const browserDefaultCfg = {
    agents: { defaults: { model: { primary: "ollama/mistral-8b" } } },
    tools: { web: { fetch: { enabled: false } } },
  } satisfies OpenClawConfig;
  const configuredBrowserBlockedByPluginPolicyCfg = {
    ...browserDefaultCfg,
    plugins: { allow: ["openai"] },
    browser: { enabled: true },
  } satisfies OpenClawConfig;

  it.each([
    ["browser disabled", { ...browserDefaultCfg, browser: { enabled: false } }, "info"],
    ["browser enabled by default", browserDefaultCfg, "critical"],
    ["plugin policy blocks configured browser", configuredBrowserBlockedByPluginPolicyCfg, "info"],
  ] satisfies [string, OpenClawConfig, string][])("%s", (_name, cfg, expectedSeverity) => {
    const finding = expectDefined(
      collectSmallModelRiskFindings({
        cfg,
        env: {},
      }).at(0),
      "small model risk finding",
    );

    expect(finding.checkId).toBe("models.small_params");
    expect(finding.severity).toBe(expectedSeverity);
    expect(finding.detail).toContain("ollama/mistral-8b");
    const unsafe = expectedSeverity === "critical";
    for (const snippet of unsafe
      ? ["web=[browser]"]
      : ["web=[off]", "No web/browser tools detected"]) {
      expect(finding.detail).toContain(snippet);
    }
    expect(finding.detail).not.toContain(
      unsafe ? "No web/browser tools detected" : "web=[browser]",
    );
  });
});
