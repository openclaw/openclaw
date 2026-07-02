// Covers tool availability evaluation and disabled-tool reasons.
import { describe, expect, it } from "vitest";
import { evaluateToolAvailability, isToolAvailabilityExpression } from "./availability.js";
import type { ToolDescriptor } from "./types.js";

const baseDescriptor: ToolDescriptor = {
  name: "example",
  description: "Example tool",
  inputSchema: { type: "object" },
  owner: { kind: "core" },
  executor: { kind: "core", executorId: "example" },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

describe("evaluateToolAvailability", () => {
  it("treats descriptors without signals as available", () => {
    expect(evaluateToolAvailability({ descriptor: baseDescriptor })).toStrictEqual([]);
  });

  it("evaluates auth, env, config, plugin, and context signals from data only", () => {
    const descriptor: ToolDescriptor = {
      ...baseDescriptor,
      availability: {
        allOf: [
          { kind: "auth", providerId: "openai" },
          { kind: "env", name: "OPENAI_API_KEY" },
          { kind: "config", path: ["plugins", "entries", "demo", "config"], check: "non-empty" },
          { kind: "plugin-enabled", pluginId: "demo" },
          { kind: "context", key: "channel", equals: "telegram" },
        ],
      },
    };

    expect(
      evaluateToolAvailability({
        descriptor,
        context: {
          authProviderIds: new Set(["openai"]),
          env: { OPENAI_API_KEY: "set" },
          config: { plugins: { entries: { demo: { config: { mode: "local" } } } } },
          enabledPluginIds: new Set(["demo"]),
          values: { channel: "telegram" },
        },
      }),
    ).toStrictEqual([]);
  });

  it("returns deterministic diagnostics for missing signals", () => {
    const descriptor: ToolDescriptor = {
      ...baseDescriptor,
      availability: {
        allOf: [
          { kind: "auth", providerId: "openai" },
          { kind: "env", name: "OPENAI_API_KEY" },
          { kind: "config", path: ["plugins", "entries", "demo", "config"], check: "non-empty" },
          { kind: "plugin-enabled", pluginId: "demo" },
          { kind: "context", key: "channel", equals: "telegram" },
        ],
      },
    };

    expect(
      evaluateToolAvailability({
        descriptor,
        context: {
          authProviderIds: new Set(),
          env: {},
          config: { plugins: { entries: { demo: { config: {} } } } },
          enabledPluginIds: new Set(),
          values: { channel: "discord" },
        },
      }).map((entry) => entry.reason),
    ).toEqual([
      "auth-missing",
      "env-missing",
      "config-missing",
      "plugin-disabled",
      "context-mismatch",
    ]);
  });

  it("does not treat credential config values as available without an injected resolver", () => {
    const descriptor: ToolDescriptor = {
      ...baseDescriptor,
      availability: {
        kind: "config",
        path: ["models", "providers", "openai", "apiKey"],
        check: "available",
      },
    };

    expect(
      evaluateToolAvailability({
        descriptor,
        context: {
          config: {
            models: {
              providers: {
                openai: {
                  apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
                },
              },
            },
          },
          env: {},
        },
      }).map((entry) => entry.reason),
    ).toEqual(["config-missing"]);
  });

  it("accepts credential config values only through an injected availability resolver", () => {
    const descriptor: ToolDescriptor = {
      ...baseDescriptor,
      availability: {
        kind: "config",
        path: ["models", "providers", "openai", "apiKey"],
        check: "available",
      },
    };

    expect(
      evaluateToolAvailability({
        descriptor,
        context: {
          config: {
            models: {
              providers: {
                openai: {
                  apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
                },
              },
            },
          },
          env: { OPENAI_API_KEY: "set" },
          isConfigValueAvailable: ({ value }) =>
            isRecord(value) &&
            value.source === "env" &&
            value.provider === "default" &&
            value.id === "OPENAI_API_KEY",
        },
      }),
    ).toStrictEqual([]);
  });

  it("does not infer env-template strings as configured credentials", () => {
    const descriptor: ToolDescriptor = {
      ...baseDescriptor,
      availability: {
        kind: "config",
        path: ["models", "providers", "openai", "apiKey"],
        check: "available",
      },
    };

    expect(
      evaluateToolAvailability({
        descriptor,
        context: {
          config: {
            models: {
              providers: {
                openai: { apiKey: "${OPENAI_API_KEY}" },
              },
            },
          },
          env: { OPENAI_API_KEY: "set" },
        },
      }).map((entry) => entry.reason),
    ).toEqual(["config-missing"]);
  });

  it("does not infer ordinary objects with source/provider/id fields as credentials", () => {
    const descriptor: ToolDescriptor = {
      ...baseDescriptor,
      availability: {
        kind: "config",
        path: ["tools", "example"],
        check: "non-empty",
      },
    };

    expect(
      evaluateToolAvailability({
        descriptor,
        context: {
          config: {
            tools: {
              example: { source: "manual", provider: "docs", id: "readme" },
            },
          },
        },
      }),
    ).toStrictEqual([]);
  });

  it("supports anyOf availability expressions", () => {
    const descriptor: ToolDescriptor = {
      ...baseDescriptor,
      availability: {
        anyOf: [
          { kind: "auth", providerId: "openai" },
          { kind: "env", name: "OPENAI_API_KEY" },
          {
            allOf: [
              { kind: "config", path: ["plugins", "entries", "local"], check: "non-empty" },
              { kind: "plugin-enabled", pluginId: "local" },
            ],
          },
        ],
      },
    };

    expect(
      evaluateToolAvailability({
        descriptor,
        context: {
          authProviderIds: new Set(),
          env: { OPENAI_API_KEY: "set" },
          enabledPluginIds: new Set(),
        },
      }),
    ).toStrictEqual([]);

    expect(
      evaluateToolAvailability({
        descriptor,
        context: {
          authProviderIds: new Set(),
          env: {},
          enabledPluginIds: new Set(),
        },
      }).map((entry) => entry.reason),
    ).toEqual(["auth-missing", "env-missing", "config-missing", "plugin-disabled"]);
  });

  it("surfaces an unsupported-signal sibling even when another anyOf branch is available", () => {
    const descriptor: ToolDescriptor = {
      ...baseDescriptor,
      availability: {
        anyOf: [
          { kind: "auth", providerId: "openai" },
          // Empty allOf is a malformed descriptor; its unsupported-signal must not be masked.
          { allOf: [] },
        ],
      },
    };

    expect(
      evaluateToolAvailability({
        descriptor,
        context: { authProviderIds: new Set(["openai"]) },
      }).map((entry) => entry.reason),
    ).toEqual(["unsupported-signal"]);
  });

  it("rejects self-referential availability without infinite recursion", () => {
    // Plugin-authored availability can contain a cycle; it must be reported as
    // unsupported rather than overflowing the stack during shape validation.
    const cyclic: { allOf: unknown[] } = { allOf: [] };
    cyclic.allOf.push(cyclic);
    const descriptor = {
      ...baseDescriptor,
      availability: cyclic,
    } as unknown as ToolDescriptor;

    expect(evaluateToolAvailability({ descriptor }).map((entry) => entry.reason)).toEqual([
      "unsupported-signal",
    ]);
  });

  it("treats an expression that reuses the same signal object across siblings as valid shape", () => {
    // Reusing one object in sibling branches is not a cycle. The active-recursion
    // stack must clear it between branches; otherwise shape validation rejects the
    // descriptor and buildToolPlan hides it. A genuine self-cycle still returns false.
    const auth = { kind: "auth", providerId: "openai" } as const;
    expect(isToolAvailabilityExpression({ allOf: [auth, auth] })).toBe(true);
    expect(isToolAvailabilityExpression({ anyOf: [auth, { allOf: [auth, auth] }] })).toBe(true);

    const cyclic: { allOf: unknown[] } = { allOf: [] };
    cyclic.allOf.push(cyclic);
    expect(isToolAvailabilityExpression(cyclic)).toBe(false);
  });
});
