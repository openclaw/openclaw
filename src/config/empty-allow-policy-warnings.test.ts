import { describe, expect, it } from "vitest";
import { validateConfigObjectWithPlugins } from "./validation.js";

// Exercises the real production owner (validatePreparedConfigWithPlugins
// via validateConfigObjectWithPlugins) with fixed plugin metadata, so the
// assertions below fail if the wiring is removed. Refs #147342.
function emptyAllowWarnings(raw: unknown) {
  const result = validateConfigObjectWithPlugins(raw, {
    pluginMetadataSnapshot: { manifestRegistry: { diagnostics: [], plugins: [] } },
  });
  expect(result.ok).toBe(true);
  if (!result.ok) {
    return [];
  }
  return result.warnings.filter((warning) =>
    warning.message.includes("Empty allow list permits everything not denied"),
  );
}

describe("config validate empty allow warnings through plugin-aware validation (#147342)", () => {
  it("warns for an empty allow list on global tools", () => {
    const warnings = emptyAllowWarnings({ tools: { allow: [], deny: ["dangerous-*"] } });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.path).toBe("tools");
  });

  it("warns per sender in toolsBySender", () => {
    const warnings = emptyAllowWarnings({
      tools: {
        toolsBySender: {
          "e164:+3900000000": { allow: [] },
          "e164:+3911111111": { allow: ["read"] },
        },
      },
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.path).toBe("tools.toolsBySender.e164:+3900000000");
  });

  it("warns for agent entry tools and their sender overrides", () => {
    const warnings = emptyAllowWarnings({
      agents: {
        entries: {
          chat: {
            tools: {
              allow: [],
              toolsBySender: { "e164:+3900000000": { allow: [] } },
            },
          },
        },
      },
    });
    const paths = warnings.map((warning) => warning.path).toSorted();
    expect(paths).toEqual(
      [
        "agents.entries.chat.tools",
        "agents.entries.chat.tools.toolsBySender.e164:+3900000000",
      ].toSorted(),
    );
  });

  it("warns for sub-agent and sandbox tools scopes", () => {
    const warnings = emptyAllowWarnings({
      tools: {
        subagents: { tools: { allow: [] } },
        sandbox: { tools: { allow: [] } },
      },
    });
    const paths = warnings.map((warning) => warning.path).toSorted();
    expect(paths).toEqual(["tools.sandbox.tools", "tools.subagents.tools"].toSorted());
  });

  it("stays silent only for sub-agent allow: [] paired with alsoAllow", () => {
    const warnings = emptyAllowWarnings({
      tools: { subagents: { tools: { allow: [], alsoAllow: ["read"] } } },
    });
    expect(warnings).toHaveLength(0);
  });

  it("warns for global and sandbox allow: [] even with alsoAllow", () => {
    const warnings = emptyAllowWarnings({
      tools: {
        allow: [],
        alsoAllow: ["read"],
        sandbox: { tools: { allow: [], alsoAllow: ["read"] } },
      },
    });
    const paths = warnings.map((warning) => warning.path).toSorted();
    expect(paths).toEqual(["tools", "tools.sandbox.tools"].toSorted());
  });

  it("warns for byProvider and nested agent sandbox scopes", () => {
    const warnings = emptyAllowWarnings({
      tools: {
        byProvider: { openai: { allow: [] } },
      },
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
    });
    const paths = warnings.map((warning) => warning.path).toSorted();
    expect(paths).toEqual(
      [
        "tools.byProvider.openai",
        "agents.entries.chat.tools.byProvider.anthropic",
        "agents.entries.chat.tools.sandbox.tools",
      ].toSorted(),
    );
  });

  it("stays silent when allow is omitted, non-empty, or absent", () => {
    expect(emptyAllowWarnings({ tools: { deny: ["exec"] } })).toHaveLength(0);
    expect(emptyAllowWarnings({ tools: { allow: ["read"] } })).toHaveLength(0);
    expect(emptyAllowWarnings({})).toHaveLength(0);
  });
});
