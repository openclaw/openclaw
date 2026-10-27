import { describe, expect, it } from "vitest";
import { buildConfigSchemaCore } from "./schema.js";
import type { ConfigJsonSchemaObject } from "./schema.shared.js";
import { applyResolvedConfigTierHints } from "./schema.tiers.js";

const objectSchema = (
  properties: Record<string, ConfigJsonSchemaObject>,
): ConfigJsonSchemaObject => ({ type: "object", properties });
const customSchema = (properties: Record<string, ConfigJsonSchemaObject>) =>
  objectSchema({ custom: objectSchema(properties) });
const text = { type: "string" };
const number = { type: "integer" };

describe("config schema tiers", () => {
  it("materializes tiers and preserves wildcard metadata when plugin tiers become concrete", () => {
    const baseSchema = buildConfigSchemaCore();
    const merged = buildConfigSchemaCore({
      plugins: [{ id: "setup-fixture", configSchema: { type: "object", properties: {} } }],
      cache: false,
    });
    for (const suffix of ["hooks.timeoutMs", "hooks.timeouts.*", "hooks.allowPromptInjection"]) {
      expect(merged.uiHints[`plugins.entries.setup-fixture.${suffix}`]).toEqual(
        baseSchema.uiHints[`plugins.entries.*.${suffix}`],
      );
    }
    expect(merged.uiHints["plugins.entries.setup-fixture.hooks.timeoutMs"]?.placeholder).toBe(
      "Automatic (per hook)",
    );
    expect(baseSchema.uiHints["gateway.port"]?.advanced).toBe(false);
    expect(baseSchema.uiHints["gateway.reload.mode"]?.advanced).toBe(true);
    expect(baseSchema.uiHints["agents.defaults.workspace"]?.advanced).toBe(false);
    expect(baseSchema.uiHints["agents.defaults.compaction.timeoutSeconds"]?.advanced).toBe(true);
    expect(baseSchema.uiHints["agents.defaults.experimental.localModelLean"]?.advanced).toBe(true);
  });

  it.each([
    ["leading wildcard specificity", "custom.*.*", false, "*.item.value", true, true],
    ["earlier leading wildcard", "*.item.value", true, "custom.item.*", false, true],
    ["exact before wildcard", "custom.item.*", true, "custom.item.value", false, false],
    ["last exact alias", "custom..item.value", true, "custom.item.value", false, false],
    ["first array alias", "custom.items[]", true, "custom.items.*", false, true],
  ] as const)(
    "preserves tier precedence for %s",
    (_name, first, firstTier, second, secondTier, expected) => {
      const hints = applyResolvedConfigTierHints(
        customSchema({
          item: objectSchema({ value: text }),
          items: { type: "array", items: text },
        }),
        { [first]: { advanced: firstTier }, [second]: { advanced: secondTier } },
      );
      const target = first.startsWith("custom.items") ? "custom.items.*" : "custom.item.value";
      expect(hints[target]?.advanced).toBe(expected);
    },
  );

  it.each(["anyOf", "oneOf", "allOf"])(
    "resolves numeric %s branches before inheriting child tiers",
    (composition) => {
      const branches = [objectSchema({ child: text }), number];
      for (const variants of [branches, branches.toReversed()]) {
        const hints = applyResolvedConfigTierHints(
          customSchema({ choice: { [composition]: variants } }),
          { custom: { advanced: false } },
        );
        expect(hints["custom.choice"]?.advanced).toBe(true);
        expect(hints["custom.choice.child"]?.advanced).toBe(true);
      }
    },
  );

  it.each([false, true])(
    "ranks generated numeric wildcards with authored tiers (explicit common=%s)",
    (explicitCommon) => {
      const hints = applyResolvedConfigTierHints(
        customSchema({
          group: objectSchema({
            item: {
              ...objectSchema({ value: text }),
              additionalProperties: number,
            },
          }),
        }),
        {
          custom: { advanced: false },
          "custom.*.*.value": { advanced: false },
          ...(explicitCommon ? { "custom.group.item.value": { advanced: false } } : {}),
        },
      );
      expect(hints["custom.group.item.*"]?.advanced).toBe(true);
      expect(hints["custom.group.item.value"]?.advanced).toBe(!explicitCommon);
    },
  );
});
