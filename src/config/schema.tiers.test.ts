import { beforeAll, describe, expect, it } from "vitest";
import { buildConfigSchemaCore } from "./schema.js";
import type { ConfigJsonSchemaObject } from "./schema.shared.js";
import { applyResolvedConfigTierHints } from "./schema.tiers.js";

function customSchema(properties: Record<string, ConfigJsonSchemaObject>): ConfigJsonSchemaObject {
  return { type: "object", properties: { custom: { type: "object", properties } } };
}

describe("config schema tiers", () => {
  let baseSchema: ReturnType<typeof buildConfigSchemaCore>;

  beforeAll(() => {
    baseSchema = buildConfigSchemaCore();
  });

  it("preserves wildcard field metadata when plugin tiers become concrete", () => {
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
  });

  it.each([
    [
      "leading wildcard specificity",
      [
        ["custom.*.*", false],
        ["*.item.value", true],
      ],
      "custom.item.value",
      true,
    ],
    [
      "earlier leading wildcard",
      [
        ["*.item.value", true],
        ["custom.item.*", false],
      ],
      "custom.item.value",
      true,
    ],
    [
      "earlier rooted wildcard",
      [
        ["custom.item.*", false],
        ["*.item.value", true],
      ],
      "custom.item.value",
      false,
    ],
    [
      "exact before wildcard",
      [
        ["custom.item.*", true],
        ["custom.item.value", false],
      ],
      "custom.item.value",
      false,
    ],
    [
      "last exact alias",
      [
        ["custom..item.value", true],
        ["custom.item.value", false],
      ],
      "custom.item.value",
      false,
    ],
    [
      "first array alias",
      [
        ["custom.items[]", true],
        ["custom.items.*", false],
      ],
      "custom.items.*",
      true,
    ],
    [
      "first wildcard alias",
      [
        ["custom.items.*", false],
        ["custom.items[]", true],
      ],
      "custom.items.*",
      false,
    ],
  ] as const)("preserves tier precedence for %s", (_name, entries, target, expected) => {
    const hints = applyResolvedConfigTierHints(
      customSchema({
        item: { type: "object", properties: { value: { type: "string" } } },
        items: { type: "array", items: { type: "string" } },
      }),
      Object.fromEntries(entries.map(([key, advanced]) => [key, { advanced }])),
    );
    expect(hints[target]?.advanced).toBe(expected);
  });

  it("resolves numeric composition branches before inheriting child tiers", () => {
    const branches = [
      { type: "object", properties: { child: { type: "string" } } },
      { type: "integer" },
    ];
    for (const variants of [branches, branches.toReversed()]) {
      const hints = applyResolvedConfigTierHints(customSchema({ choice: { anyOf: variants } }), {
        custom: { advanced: false },
      });
      expect(hints["custom.choice"]?.advanced).toBe(true);
      expect(hints["custom.choice.child"]?.advanced).toBe(true);
    }
  });

  it.each([false, true])(
    "ranks generated numeric wildcards with authored tiers (explicit common=%s)",
    (explicitCommon) => {
      const hints = applyResolvedConfigTierHints(
        customSchema({
          group: {
            type: "object",
            properties: {
              item: {
                type: "object",
                properties: { value: { type: "string" } },
                additionalProperties: { type: "integer" },
              },
            },
          },
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
