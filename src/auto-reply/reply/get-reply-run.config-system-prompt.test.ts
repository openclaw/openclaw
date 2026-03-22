import { describe, expect, it } from "vitest";
import { resolveConfigSystemPrompt } from "../../agents/config-system-prompt.js";
import type { OpenClawConfig } from "../../config/config.js";

describe("resolveConfigSystemPrompt", () => {
  it("returns empty string when no config is set", () => {
    expect(resolveConfigSystemPrompt({} as OpenClawConfig, "main")).toBe("");
  });

  it("returns defaults systemPrompt when no per-agent override", () => {
    const cfg = {
      agents: { defaults: { systemPrompt: "Be safe." } },
    } as OpenClawConfig;
    expect(resolveConfigSystemPrompt(cfg, "main")).toBe("Be safe.");
  });

  it("returns defaults rules as numbered list", () => {
    const cfg = {
      agents: { defaults: { rules: ["Rule A", "Rule B", "Rule C"] } },
    } as OpenClawConfig;
    expect(resolveConfigSystemPrompt(cfg, "main")).toBe("1. Rule A\n2. Rule B\n3. Rule C");
  });

  it("combines systemPrompt and rules", () => {
    const cfg = {
      agents: {
        defaults: {
          systemPrompt: "Be helpful.",
          rules: ["No data exfil.", "Ask first."],
        },
      },
    } as OpenClawConfig;
    const result = resolveConfigSystemPrompt(cfg, "main");
    expect(result).toBe("Be helpful.\n\n1. No data exfil.\n2. Ask first.");
  });

  it("per-agent systemPrompt overrides defaults", () => {
    const cfg = {
      agents: {
        defaults: { systemPrompt: "Default prompt." },
        list: [{ id: "support", systemPrompt: "Support prompt." }],
      },
    } as OpenClawConfig;
    expect(resolveConfigSystemPrompt(cfg, "support")).toBe("Support prompt.");
    expect(resolveConfigSystemPrompt(cfg, "main")).toBe("Default prompt.");
  });

  it("per-agent rules override defaults rules", () => {
    const cfg = {
      agents: {
        defaults: { rules: ["Default rule."] },
        list: [{ id: "support", rules: ["Support rule A.", "Support rule B."] }],
      },
    } as OpenClawConfig;
    expect(resolveConfigSystemPrompt(cfg, "support")).toBe(
      "1. Support rule A.\n2. Support rule B.",
    );
    expect(resolveConfigSystemPrompt(cfg, "main")).toBe("1. Default rule.");
  });

  it("agent id matching uses normalizeAgentId", () => {
    const cfg = {
      agents: {
        defaults: { systemPrompt: "Default." },
        list: [{ id: "Support", systemPrompt: "Matched." }],
      },
    } as OpenClawConfig;
    expect(resolveConfigSystemPrompt(cfg, "support")).toBe("Matched.");
    expect(resolveConfigSystemPrompt(cfg, "SUPPORT")).toBe("Matched.");
  });

  it("ignores whitespace-only systemPrompt", () => {
    const cfg = {
      agents: { defaults: { systemPrompt: "   " } },
    } as OpenClawConfig;
    expect(resolveConfigSystemPrompt(cfg, "main")).toBe("");
  });

  it("empty rules array returns empty string", () => {
    const cfg = {
      agents: { defaults: { rules: [] } },
    } as OpenClawConfig;
    expect(resolveConfigSystemPrompt(cfg, "main")).toBe("");
  });
});
