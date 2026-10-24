import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
  filterProviderNormalizableTools,
  filterRuntimeCompatibleTools,
  projectRuntimeToolInputSchema,
} from "./tool-schema-projection.js";
import type { AnyAgentTool } from "./tools/common.js";

const objectSchema = (properties: Record<string, unknown>) => ({ type: "object", properties });
const rejected = (toolName: string, violation: string) => ({
  tools: [],
  diagnostics: [{ toolName, toolIndex: 0, violations: [violation] }],
});
function expectInvalid(schema: unknown, path: string) {
  expect(projectRuntimeToolInputSchema(schema)).toEqual({
    schema: {},
    violations: [`parameters.${path} is not JSON-serializable`],
  });
}
function expectFiniteDefault(value: unknown) {
  expect(projectRuntimeToolInputSchema(objectSchema({ score: { default: value } }))).toEqual({
    schema: objectSchema({ score: { default: { value: "finite" } } }),
    violations: [],
  });
}

describe("runtime tool input schema projection", () => {
  it("reports dynamic JSON Schema keywords in traversal order with exact paths", () => {
    const schema = {
      type: "object",
      $dynamicAnchor: "root",
      $dynamicRef: "#root",
      anyOf: [{ $dynamicAnchor: "branch" }, { properties: { "": { $dynamicRef: "#empty" } } }],
      properties: {
        target: { $dynamicRef: "#target" },
        "literal.dot[0]": { $dynamicAnchor: "literal" },
      },
    };
    const expectedSchema = structuredClone(schema);
    expect(projectRuntimeToolInputSchema(schema)).toEqual({
      schema: expectedSchema,
      violations: [
        "parameters.$dynamicRef",
        "parameters.$dynamicAnchor",
        "parameters.anyOf[0].$dynamicAnchor",
        "parameters.anyOf[1].properties..$dynamicRef",
        "parameters.properties.target.$dynamicRef",
        "parameters.properties.literal.dot[0].$dynamicAnchor",
      ],
    });
  });

  it.each<[string, unknown, string]>([
    ["", Infinity, "properties..maximum"],
    ["score", Object(Infinity), "properties.score.maximum"],
  ])("reports non-finite limits at %s", (name, maximum, path) => {
    expectInvalid(objectSchema({ [name]: { type: "number", maximum } }), path);
  });

  it("tracks repeated descendants through each toJSON replacement without rereading getters", () => {
    const reads: string[] = [];
    let count = 0;
    const shared = {
      type: "number",
      get maximum() {
        reads.push("maximum");
        return count++ === 0 ? 1 : Number.POSITIVE_INFINITY;
      },
    };
    const replacement = {
      toJSON(key: string) {
        reads.push(key);
        return { type: "array", items: [shared] };
      },
    };

    expectInvalid(
      objectSchema({ first: replacement, second: replacement }),
      "properties.second.items[0].maximum",
    );
    expect(reads).toEqual(["first", "maximum", "second", "maximum"]);
  });

  it.each([
    { [Symbol.toStringTag]: "Number", value: "finite" },
    {
      get [Symbol.toStringTag](): string {
        throw new Error("unreadable tag");
      },
      value: "finite",
    },
  ])("ignores non-JSON Number tags (%#)", expectFiniteDefault);

  it("does not report schema map field names as dynamic JSON Schema keywords", () => {
    expect(
      projectRuntimeToolInputSchema({
        type: "object",
        $defs: { $dynamicAnchor: { type: "string" } },
        properties: { $dynamicRef: { type: "string" } },
      }).violations,
    ).toEqual([]);
  });

  it("keeps tools whose examples contain literal schema documents", () => {
    const instance = {
      document: { $dynamicAnchor: "node", properties: { child: { $dynamicRef: "#node" } } },
    };
    const parameters = Type.Object(
      { document: Type.Record(Type.String(), Type.Unknown()) },
      { examples: [instance] },
    );
    const original = structuredClone(parameters);
    const tool = { name: "store_schema", parameters };

    expect(projectRuntimeToolInputSchema(parameters)).toEqual({ schema: original, violations: [] });
    expect(filterRuntimeCompatibleTools([tool])).toEqual({ tools: [tool], diagnostics: [] });
    expect(parameters).toEqual(original);
  });

  it("quarantines unreadable runtime tool fields without dropping healthy siblings", () => {
    const unreadable = {
      name: "fuzzplugin_unreadable",
      get parameters(): Record<string, unknown> {
        throw new Error("fuzzplugin parameters getter exploded");
      },
    };
    const healthy = { name: "healthy", parameters: objectSchema({}) };

    expect(filterRuntimeCompatibleTools([unreadable, healthy])).toEqual({
      ...rejected("fuzzplugin_unreadable", "fuzzplugin_unreadable.parameters is unreadable"),
      tools: [healthy],
    });
  });

  it("keeps missing parameter schemas for provider-specific normalization", () => {
    const parameterFree = {
      name: "fuzzplugin_parameter_free",
      parameters: undefined,
    } as unknown as Pick<AnyAgentTool, "name" | "parameters">;

    expect(filterProviderNormalizableTools([parameterFree])).toEqual({
      tools: [parameterFree],
      diagnostics: [],
    });
  });

  it("quarantines non-object schemas before provider normalization", () => {
    const name = "fuzzplugin_array_root";
    const arraySchema = {
      name,
      parameters: { type: "array", items: { type: "number" } },
    };
    expect(filterProviderNormalizableTools([arraySchema])).toEqual(
      rejected(name, `${name}.parameters.type must be "object"`),
    );
  });
});
