import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "./types.js";
import { collectConfigValidationWarnings } from "./validation-core.js";

function configWith(value: unknown): OpenClawConfig {
  return value as OpenClawConfig;
}

// All fixtures stay at zero or one agent so the heartbeat-owner warning
// never fires; every warning below comes from the empty-allow collector.
describe("collectConfigValidationWarnings empty allow (#147342)", () => {
  it("warns for an empty allow list on global tools", () => {
    const warnings = collectConfigValidationWarnings(
      configWith({ tools: { allow: [], deny: ["dangerous-*"] } }),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.path).toBe("tools");
    expect(warnings[0]?.message).toContain("Empty allow list permits everything not denied");
  });

  it("warns per sender in toolsBySender", () => {
    const warnings = collectConfigValidationWarnings(
      configWith({
        tools: {
          toolsBySender: {
            "e164:+390000000000": { allow: [] },
            "e164:+391111111111": { allow: ["read"] },
          },
        },
      }),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.path).toBe("tools.toolsBySender.e164:+390000000000");
  });

  it("warns for agent entry tools and their sender overrides", () => {
    const warnings = collectConfigValidationWarnings(
      configWith({
        agents: {
          entries: {
            chat: {
              tools: {
                allow: [],
                toolsBySender: { "e164:+390000000000": { allow: [] } },
              },
            },
          },
        },
      }),
    );
    const paths = warnings.map((warning) => warning.path).toSorted();
    expect(paths).toEqual([
      "agents.entries.chat.tools",
      "agents.entries.chat.tools.toolsBySender.e164:+390000000000",
    ]);
  });

  it("warns for sub-agent and sandbox tools scopes", () => {
    const warnings = collectConfigValidationWarnings(
      configWith({
        tools: {
          subagents: { tools: { allow: [] } },
          sandbox: { tools: { allow: [] } },
        },
      }),
    );
    const paths = warnings.map((warning) => warning.path).toSorted();
    expect(paths).toEqual(["tools.sandbox.tools", "tools.subagents.tools"]);
  });

  it("stays silent only for sub-agent allow: [] paired with alsoAllow", () => {
    const warnings = collectConfigValidationWarnings(
      configWith({
        tools: {
          subagents: { tools: { allow: [], alsoAllow: ["read"] } },
          allow: [],
        },
      }),
    );
    const paths = warnings.map((warning) => warning.path).toSorted();
    expect(paths).toEqual(["tools"]);
  });

  it("warns for global and sandbox allow: [] even with alsoAllow", () => {
    const warnings = collectConfigValidationWarnings(
      configWith({
        tools: {
          allow: [],
          alsoAllow: ["read"],
          sandbox: { tools: { allow: [], alsoAllow: ["read"] } },
        },
      }),
    );
    const paths = warnings.map((warning) => warning.path).toSorted();
    expect(paths).toEqual(["tools", "tools.sandbox.tools"]);
  });

  it("warns for byProvider and nested agent sandbox scopes", () => {
    const warnings = collectConfigValidationWarnings(
      configWith({
        tools: { byProvider: { openai: { allow: [] } } },
        agents: {
          entries: {
            chat: {
              tools: {
                byProvider: { anthropic: { allow: [] } },
                sandbox: { tools: { allow: [] } },
              },
            },
          },
        },
      }),
    );
    const paths = warnings.map((warning) => warning.path).toSorted();
    expect(paths).toEqual([
      "agents.entries.chat.tools.byProvider.anthropic",
      "agents.entries.chat.tools.sandbox.tools",
      "tools.byProvider.openai",
    ]);
  });

  it("stays silent when allow is omitted, non-empty, or absent", () => {
    const warnings = collectConfigValidationWarnings(
      configWith({
        tools: { deny: ["*"] },
        agents: { entries: { main: { tools: { allow: ["read"] } } } },
      }),
    );
    expect(warnings).toEqual([]);
    expect(collectConfigValidationWarnings(configWith({}))).toEqual([]);
  });
});
