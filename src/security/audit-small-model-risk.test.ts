import { expectDefined } from "@openclaw/normalization-core/expect";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { collectSmallModelRiskFindings } from "./audit-extra.summary.js";
import { collectAuditModelRefs } from "./audit-model-refs.js";

const web = { search: { enabled: true }, fetch: { enabled: true } };
const browser = { enabled: true };
function modelConfig(
  primary: string,
  defaults: NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]> = {},
): OpenClawConfig {
  return { agents: { defaults: { model: { primary }, ...defaults } }, tools: { web }, browser };
}
function risk(cfg: OpenClawConfig, env: NodeJS.ProcessEnv = {}) {
  return expectDefined(collectSmallModelRiskFindings({ cfg, env }).at(0), "risk finding");
}

describe("security audit small-model risk findings", () => {
  it("reports canonical paths for agent model references", () => {
    expect(
      collectAuditModelRefs({
        agents: {
          entries: {
            simple: { model: "ollama/mistral-8b" },
            structured: { model: { primary: "ollama/gemma-4b", fallbacks: ["ollama/phi-3b"] } },
          },
        },
      } satisfies OpenClawConfig),
    ).toEqual([
      { id: "ollama/mistral-8b", source: "agents.entries.simple.model" },
      { id: "ollama/gemma-4b", source: "agents.entries.structured.model.primary" },
      { id: "ollama/phi-3b", source: "agents.entries.structured.model.fallbacks" },
    ]);
  });

  it("preserves agent policy context for canonical model source paths", () => {
    const finding = risk({
      agents: {
        entries: {
          ops: {
            model: { primary: "ollama/mistral-8b" },
            tools: { deny: ["web_search", "web_fetch", "browser"] },
          },
        },
      },
      tools: { web },
      browser,
    });

    expect(finding.severity).toBe("info");
    expect(finding.detail).toContain("@ agents.entries.ops.model.primary");
    expect(finding.detail).toContain("web=[off]");
  });

  it("scores small-model risk by tool/sandbox exposure", () => {
    const cases: Array<{
      name: string;
      cfg: OpenClawConfig;
      expectedSeverity: "info" | "critical";
      detailIncludes: string[];
    }> = [
      {
        name: "small model with web and browser enabled",
        cfg: modelConfig("ollama/mistral-8b"),
        expectedSeverity: "critical",
        detailIncludes: ["mistral-8b", "web_search", "web_fetch", "browser"],
      },
      {
        name: "small model with sandbox all and web/browser disabled",
        cfg: {
          ...modelConfig("ollama/mistral-8b", { sandbox: { mode: "all" } }),
          tools: { web: { search: { enabled: false }, fetch: { enabled: false } } },
          browser: { enabled: false },
        },
        expectedSeverity: "info",
        detailIncludes: ["mistral-8b", "sandbox=all"],
      },
    ];

    for (const testCase of cases) {
      const finding = risk(testCase.cfg, process.env);
      expect(finding.severity, testCase.name).toBe(testCase.expectedSeverity);
      for (const snippet of testCase.detailIncludes) {
        expect(finding.detail, `${testCase.name}:${snippet}`).toContain(snippet);
      }
    }
  });

  it("resolves configured aliases before parameter-size classification", () => {
    const finding = risk(
      modelConfig("tiny", { models: { "ollama/mistral-8b": { alias: "tiny" } } }),
    );

    expect(finding.checkId).toBe("models.small_params");
    expect(finding.detail).toContain("ollama/mistral-8b");
    expect(finding.detail).toContain("@ agents.defaults.model.primary");
    expect(finding.detail).not.toContain("- tiny");
  });

  it("honors provider/model tool deny policy before reporting web exposure", () => {
    const finding = risk({
      ...modelConfig("openrouter/google/gemma-3-4b-it:free"),
      tools: {
        web,
        byProvider: {
          "openrouter/google/gemma-3-4b-it:free": { deny: ["web_search", "web_fetch", "browser"] },
        },
      },
    });

    expect(finding.checkId).toBe("models.small_params");
    expect(finding.severity).toBe("info");
    expect(finding.detail).toContain("openrouter/google/gemma-3-4b-it:free");
    expect(finding.detail).toContain("web=[off]");
    expect(finding.detail).toContain("No web/browser tools detected");
    expect(finding.detail).not.toContain("web=[web_search");
  });
});
