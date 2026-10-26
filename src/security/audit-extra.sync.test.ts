import { expect, it, vi } from "vitest";
import { setConfigResolutionFacts } from "../config/resolution-facts.js";
import {
  collectAttackSurfaceSummaryFindings,
  collectSmallModelRiskFindings,
} from "./audit-extra.summary.js";
import { collectSecretsInConfigFindings } from "./audit-secrets.js";

vi.mock("../plugins/web-search-credential-presence.js", () => ({
  hasConfiguredWebSearchCredential: () => false,
}));

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

it.each<[string, boolean | undefined, string[] | undefined, string]>([
  ["disabled", false, undefined, "info"],
  ["default", undefined, undefined, "critical"],
  ["blocked by plugin policy", true, ["openai"], "info"],
])("%s", (_name, enabled, allow, severity) => {
  const [finding] = collectSmallModelRiskFindings({
    cfg: {
      agents: { defaults: { model: { primary: "ollama/mistral-8b" } } },
      tools: { web: { fetch: { enabled: false } } },
      browser: { enabled },
      plugins: { allow },
    },
    env: {},
  });
  const unsafe = severity === "critical";
  expect(finding).toMatchObject({
    checkId: "models.small_params",
    severity,
    detail: expect.stringContaining(unsafe ? "web=[browser]" : "web=[off]"),
  });
});
