import { expect, it } from "vitest";
import { setConfigResolutionFacts } from "../config/resolution-facts.js";
import {
  collectAttackSurfaceSummaryFindings,
  collectSmallModelRiskFindings,
} from "./audit-extra.summary.js";
import { collectSecretsInConfigFindings } from "./audit-secrets.js";

it("distinguishes an unresolved password from byte-identical literal text", () => {
  const config = { gateway: { auth: { password: "${GATEWAY_PASSWORD}" } } };
  setConfigResolutionFacts(config, new Set(["gateway.auth.password"]));
  expect(collectSecretsInConfigFindings(config)).toEqual([]);
  setConfigResolutionFacts(config, new Set());
  expect(collectSecretsInConfigFindings(config)).toHaveLength(1);
});

it("summarizes enabled internal hooks", async () => {
  const [finding] = await collectAttackSurfaceSummaryFindings({
    hooks: { internal: { enabled: true } },
  });
  expect(finding).toMatchObject({ checkId: "summary.attack_surface" });
  expect(finding?.detail).toContain("hooks.webhooks: disabled");
  expect(finding?.detail).toContain("hooks.internal: enabled");
});

it.each<[string, boolean | undefined, string[] | undefined, string, string?]>([
  ["disabled", false, undefined, "info"],
  ["default", undefined, undefined, "critical"],
  ["blocked by plugin policy", true, ["openai"], "info"],
  ["configured web search without browser", false, undefined, "critical", "brave-key"],
])("%s", (_name, enabled, allow, severity, searchKey) => {
  const [finding] = collectSmallModelRiskFindings({
    cfg: {
      agents: { defaults: { model: { primary: "ollama/mistral-8b" } } },
      tools: {
        web: { fetch: { enabled: false }, ...(searchKey ? { search: { apiKey: searchKey } } : {}) },
      },
      browser: { enabled },
      plugins: { allow },
    },
    env: {},
  });
  const unsafe = severity === "critical";
  expect(finding).toMatchObject({
    checkId: "models.small_params",
    severity,
    detail: expect.stringContaining(
      unsafe ? (searchKey ? "web=[web_search]" : "web=[browser]") : "web=[off]",
    ),
  });
});
