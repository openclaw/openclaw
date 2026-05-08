import { describe, expect, it } from "vitest";
import {
  collectStringModelFallbackClobberWarnings,
  formatConfigPath,
  resolveConfigPathTarget,
  stripUnknownConfigKeys,
} from "./doctor-config-analysis.js";

describe("doctor config analysis helpers", () => {
  it("formats config paths predictably", () => {
    expect(formatConfigPath([])).toBe("<root>");
    expect(formatConfigPath(["channels", "slack", "accounts", 0, "token"])).toBe(
      "channels.slack.accounts[0].token",
    );
  });

  it("resolves nested config targets without throwing", () => {
    const target = resolveConfigPathTarget(
      { channels: { slack: { accounts: [{ token: "x" }] } } },
      ["channels", "slack", "accounts", 0],
    );
    expect(target).toEqual({ token: "x" });
    expect(resolveConfigPathTarget({ channels: null }, ["channels", "slack"])).toBeNull();
  });

  it("strips unknown config keys while keeping known values", () => {
    const result = stripUnknownConfigKeys({
      hooks: {},
      unexpected: true,
    } as never);
    expect(result.removed).toContain("unexpected");
    expect((result.config as Record<string, unknown>).unexpected).toBeUndefined();
    expect((result.config as Record<string, unknown>).hooks).toEqual({});
  });
});

describe("collectStringModelFallbackClobberWarnings", () => {
  it("returns empty when defaults has no fallbacks", () => {
    const cfg = {
      agents: {
        defaults: { model: { primary: "openai/gpt-5.5" } },
        list: [{ id: "mybot", model: "openai/gpt-5.5" }],
      },
    } as never;
    expect(collectStringModelFallbackClobberWarnings(cfg)).toHaveLength(0);
  });

  it("returns empty when no agents use string-form model", () => {
    const cfg = {
      agents: {
        defaults: { model: { primary: "openai/gpt-5.5", fallbacks: ["openai/gpt-5.4"] } },
        list: [{ id: "mybot", model: { primary: "openai/gpt-5.5", fallbacks: [] } }],
      },
    } as never;
    expect(collectStringModelFallbackClobberWarnings(cfg)).toHaveLength(0);
  });

  it("warns when a per-agent string model clobbers non-empty default fallbacks", () => {
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.5", fallbacks: ["openai/gpt-5.4", "openai/gpt-5.3"] },
        },
        list: [{ id: "researcher", model: "openai-codex/gpt-5.3-codex-spark" }],
      },
    } as never;
    const warnings = collectStringModelFallbackClobberWarnings(cfg);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("agents.list[researcher].model");
    expect(warnings[0]).toContain("clobbers agents.defaults.model.fallbacks");
    expect(warnings[0]).toContain("openai/gpt-5.4");
  });

  it("warns for each offending agent independently", () => {
    const cfg = {
      agents: {
        defaults: { model: { primary: "openai/gpt-5.5", fallbacks: ["openai/gpt-5.4"] } },
        list: [
          { id: "bot-a", model: "openai/gpt-5.5" },
          { id: "bot-b", model: { primary: "openai/gpt-5.5", fallbacks: [] } },
          { id: "bot-c", model: "openai/gpt-5.4" },
        ],
      },
    } as never;
    const warnings = collectStringModelFallbackClobberWarnings(cfg);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("agents.list[bot-a].model");
    expect(warnings[1]).toContain("agents.list[bot-c].model");
  });

  it("uses numeric index as id when agent has no id", () => {
    const cfg = {
      agents: {
        defaults: { model: { primary: "openai/gpt-5.5", fallbacks: ["openai/gpt-5.4"] } },
        list: [{ model: "openai/gpt-5.5" }],
      },
    } as never;
    const warnings = collectStringModelFallbackClobberWarnings(cfg);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("agents.list[0].model");
  });
});
