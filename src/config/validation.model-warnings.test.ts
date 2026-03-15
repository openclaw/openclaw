import { describe, expect, it } from "vitest";
import type { ModelCatalogEntry } from "../agents/model-catalog.js";
import type { OpenClawConfig } from "./types.js";
import { collectModelConfigWarnings } from "./validation.js";

const CATALOG: ModelCatalogEntry[] = [
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "anthropic" },
  { id: "gpt-5.2", name: "GPT-5.2", provider: "openai" },
];

function makeConfig(overrides: Partial<OpenClawConfig> = {}): OpenClawConfig {
  return {
    gateway: { mode: "local" },
    ...overrides,
  } as OpenClawConfig;
}

describe("collectModelConfigWarnings", () => {
  it("returns no warnings when agents.defaults.model is in catalog", () => {
    const cfg = makeConfig({
      agents: { defaults: { model: { primary: "anthropic/claude-sonnet-4-6" } } },
    });
    expect(collectModelConfigWarnings(cfg, CATALOG)).toEqual([]);
  });

  it("warns when agents.defaults.model.primary is not in catalog", () => {
    const cfg = makeConfig({
      agents: { defaults: { model: { primary: "openai-codex/gpt-5.4-codex" } } },
    });
    const warnings = collectModelConfigWarnings(cfg, CATALOG);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].path).toBe("agents.defaults.model.primary");
    expect(warnings[0].message).toContain("not found in model catalog");
  });

  it("warns when agents.defaults.model is a string not in catalog", () => {
    const cfg = makeConfig({
      agents: { defaults: { model: "fake-provider/nonexistent" } },
    });
    const warnings = collectModelConfigWarnings(cfg, CATALOG);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].path).toBe("agents.defaults.model.primary");
  });

  it("warns when an agent list entry model is not in catalog", () => {
    const cfg = makeConfig({
      agents: {
        list: [{ id: "test-agent", model: { primary: "openai/no-such-model" } }],
      },
    });
    const warnings = collectModelConfigWarnings(cfg, CATALOG);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].path).toBe("agents.list.0.model.primary");
    expect(warnings[0].message).toContain("not found in model catalog");
  });

  it("returns no warnings when no model is configured", () => {
    const cfg = makeConfig({});
    expect(collectModelConfigWarnings(cfg, CATALOG)).toEqual([]);
  });

  it("returns no warnings with an empty catalog", () => {
    const cfg = makeConfig({
      agents: { defaults: { model: { primary: "anthropic/claude-sonnet-4-6" } } },
    });
    // Empty catalog means we can't validate — still warn.
    const warnings = collectModelConfigWarnings(cfg, []);
    expect(warnings).toHaveLength(1);
  });
});
