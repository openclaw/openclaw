import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "./types.js";
import { collectConfigValidationWarnings } from "./validation-core.js";
import { validateConfigObjectWithPlugins } from "./validation.js";

function configWith(value: unknown): OpenClawConfig {
  return value as OpenClawConfig;
}

// Every warning below comes from the empty-allow collector.
describe("collectConfigValidationWarnings empty allow (#147342)", () => {
  it("warns for an empty allow list that is the whole global policy", () => {
    const warnings = collectConfigValidationWarnings(configWith({ tools: { allow: [] } }));
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

  it("stays silent when a non-empty deny gives the empty allow a purpose", () => {
    const warnings = collectConfigValidationWarnings(
      configWith({
        tools: {
          allow: [],
          deny: ["exec"],
          sandbox: { tools: { allow: [], deny: ["*"] } },
          toolsBySender: { "e164:+390000000000": { allow: [], deny: ["write"] } },
        },
      }),
    );
    expect(warnings).toEqual([]);
  });

  it("stays silent when a non-empty alsoAllow accompanies the empty allow", () => {
    const warnings = collectConfigValidationWarnings(
      configWith({
        tools: {
          allow: [],
          alsoAllow: ["read"],
          subagents: { tools: { allow: [], alsoAllow: ["read"] } },
          sandbox: { tools: { allow: [], alsoAllow: ["read"] } },
        },
      }),
    );
    expect(warnings).toEqual([]);
  });

  it("still warns when deny and alsoAllow are present but empty", () => {
    const warnings = collectConfigValidationWarnings(
      configWith({ tools: { allow: [], deny: [], alsoAllow: [] } }),
    );
    expect(warnings.map((warning) => warning.path)).toEqual(["tools"]);
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

// Behavior through the real `config validate` pipeline, not just the collector.
describe("validateConfigObjectWithPlugins empty allow (#147342)", () => {
  it("surfaces empty allow warnings while keeping the config valid", () => {
    const result = validateConfigObjectWithPlugins({
      tools: { allow: [], sandbox: { tools: { allow: [] } } },
    });
    expect(result.ok).toBe(true);
    const paths = result.warnings
      .filter((warning) => warning.message.includes('deny:["*"]'))
      .map((warning) => warning.path)
      .toSorted();
    expect(paths).toEqual(["tools", "tools.sandbox.tools"]);
  });

  it("stays silent when deny or alsoAllow accompany the empty allow", () => {
    const result = validateConfigObjectWithPlugins({
      tools: {
        allow: [],
        deny: ["exec"],
        subagents: { tools: { allow: [], alsoAllow: ["read"] } },
      },
    });
    expect(result.ok).toBe(true);
    expect(result.warnings.filter((warning) => warning.message.includes('deny:["*"]'))).toEqual([]);
  });
});
