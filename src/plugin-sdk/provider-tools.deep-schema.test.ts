import { expectDefined } from "@openclaw/normalization-core/expect";
import { describe, expect, it } from "vitest";
import { buildProviderToolCompatFamilyHooks } from "./provider-tools.js";

describe("deep provider tool schemas", () => {
  function tool(parameters: unknown) {
    return { name: "demo", description: "", parameters } as never;
  }

  function objectSchema(properties: Record<string, unknown>, overrides = {}) {
    return { type: "object", properties, ...overrides };
  }

  function context(tools: never[], provider = "deepseek") {
    return { provider, modelId: "fixture", modelApi: "openai-completions", tools };
  }

  it.each(["gemini", "deepseek"] as const)(
    "inspects deeply nested schemas through the %s family hook",
    (family) => {
      const depth = 20_000;
      let parameters: Record<string, unknown> = { anyOf: [], pattern: "^leaf$" };
      for (let index = 0; index < depth; index++) {
        parameters = objectSchema({ nested: parameters });
      }
      const hooks = buildProviderToolCompatFamilyHooks(family);
      const leafPath = `demo.parameters${".properties.nested".repeat(depth)}`;
      const keyword = family === "gemini" ? "pattern" : "anyOf";

      expect(hooks.inspectToolSchemas(context([tool(parameters)], family))).toEqual([
        { toolName: "demo", toolIndex: 0, violations: [`${leafPath}.${keyword}`] },
      ]);
    },
  );

  it.each(["gemini", "deepseek"] as const)(
    "reports shared schemas at each path and rejects cycles for %s",
    (family) => {
      const shared = { anyOf: [], pattern: "^shared$" };
      const parameters = objectSchema({ first: shared, second: shared });
      const hooks = buildProviderToolCompatFamilyHooks(family);
      const keyword = family === "gemini" ? "pattern" : "anyOf";
      expect(hooks.inspectToolSchemas(context([tool(parameters)], family))).toEqual([
        {
          toolName: "demo",
          toolIndex: 0,
          violations: [
            `demo.parameters.properties.first.${keyword}`,
            `demo.parameters.properties.second.${keyword}`,
          ],
        },
      ]);
      const circular: Record<string, unknown> = {};
      circular.items = [circular];
      expect(() => hooks.inspectToolSchemas(context([tool(circular)], family))).toThrow(
        "Cannot inspect a circular tool schema",
      );
      if (family === "deepseek") {
        expect(() => hooks.normalizeToolSchemas(context([tool(circular)]))).toThrow(
          "Cannot normalize a circular tool schema",
        );
      }
    },
  );

  it("normalizes deeply nested DeepSeek unions without mutating the source", () => {
    const depth = 4_000;
    const leaf = { anyOf: [{ const: "first" }, { const: "second" }] };
    const stable = { type: "string" };
    let parameters: Record<string, unknown> = leaf;
    for (let index = 0; index < depth; index++) {
      parameters = objectSchema({ nested: parameters, stable });
    }
    const originalTool = tool(parameters);
    const hooks = buildProviderToolCompatFamilyHooks("deepseek");
    const normalized = hooks.normalizeToolSchemas(context([originalTool]));
    let source = parameters;
    let result = normalized[0]?.parameters as Record<string, unknown>;
    expect(normalized[0] === originalTool).toBe(false);
    for (let index = 0; index < depth; index++) {
      expect(result === source).toBe(false);
      const sourceProperties = source.properties as Record<string, Record<string, unknown>>;
      const resultProperties = result.properties as Record<string, Record<string, unknown>>;
      expect(resultProperties.stable).toBe(stable);
      source = expectDefined(sourceProperties.nested, "source nested schema");
      result = expectDefined(resultProperties.nested, "normalized nested schema");
    }
    expect(source).toBe(leaf);
    expect(source).toEqual({ anyOf: [{ const: "first" }, { const: "second" }] });
    expect(result).toEqual({ type: "string", enum: ["first", "second"] });
    expect(
      hooks.normalizeToolSchemas(context([tool(normalized[0]?.parameters)]))[0]?.parameters,
    ).toBe(normalized[0]?.parameters);
  });

  it("reduces object unions with deeply nested shared constraints and literals", () => {
    const nested = (leaf: string): Record<string, unknown> => {
      let schema: Record<string, unknown> = { type: "string", const: leaf };
      for (let index = 0; index < 4_000; index++) {
        schema = objectSchema({ nested: schema });
      }
      return schema;
    };
    const first = nested("first");
    const equalFirst = nested("first");
    const second = nested("second");
    const parameters = {
      anyOf: [
        objectSchema(
          { common: first, choice: { const: first, enum: [equalFirst] } },
          { additionalProperties: false },
        ),
        objectSchema(
          { common: equalFirst, choice: { const: second, enum: [second] } },
          { additionalProperties: false },
        ),
      ],
    };
    const hooks = buildProviderToolCompatFamilyHooks("deepseek");
    const normalized = hooks.normalizeToolSchemas(context([tool(parameters)]));
    const result = normalized[0]?.parameters as {
      type: string;
      properties: { common: unknown; choice: { enum: unknown[]; const?: unknown } };
    };
    expect(result.type).toBe("object");
    expect(result.properties.common === first).toBe(true);
    expect(result.properties.choice.enum).toHaveLength(2);
    expect(result.properties.choice.enum[0] === first).toBe(true);
    expect(result.properties.choice.enum[1] === second).toBe(true);
    expect(result.properties.choice).not.toHaveProperty("const");
  });
});
