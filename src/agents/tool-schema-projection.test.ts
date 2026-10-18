// Tool schema projection tests cover runtime/provider filtering for plugin tool
// schemas before they are exposed to model providers.
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
  filterProviderNormalizableTools,
  filterRuntimeCompatibleTools,
  projectRuntimeToolInputSchema,
} from "./tool-schema-projection.js";
import type { AnyAgentTool } from "./tools/common.js";

describe("runtime tool input schema projection", () => {
  it("reports dynamic JSON Schema keywords in traversal order with exact paths", () => {
    expect(
      projectRuntimeToolInputSchema({
        type: "object",
        $dynamicAnchor: "root",
        $dynamicRef: "#root",
        anyOf: [{ $dynamicAnchor: "branch" }, { properties: { "": { $dynamicRef: "#empty" } } }],
        properties: {
          target: { $dynamicRef: "#target" },
          "literal.dot[0]": { $dynamicAnchor: "literal" },
        },
      }),
    ).toEqual({
      schema: {
        type: "object",
        $dynamicAnchor: "root",
        $dynamicRef: "#root",
        anyOf: [{ $dynamicAnchor: "branch" }, { properties: { "": { $dynamicRef: "#empty" } } }],
        properties: {
          target: { $dynamicRef: "#target" },
          "literal.dot[0]": { $dynamicAnchor: "literal" },
        },
      },
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

  it("keeps empty property names in non-finite diagnostic paths", () => {
    expect(
      projectRuntimeToolInputSchema({
        type: "object",
        properties: {
          "": { type: "number", maximum: Number.POSITIVE_INFINITY },
        },
      }),
    ).toEqual({
      schema: {},
      violations: ["parameters.properties..maximum is not JSON-serializable"],
    });
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

    expect(
      projectRuntimeToolInputSchema({
        type: "object",
        properties: { first: replacement, second: replacement },
      }),
    ).toEqual({
      schema: {},
      violations: ["parameters.properties.second.items[0].maximum is not JSON-serializable"],
    });
    expect(reads).toEqual(["first", "maximum", "second", "maximum"]);
  });

  it("reports boxed non-finite numeric schema values", () => {
    expect(
      projectRuntimeToolInputSchema({
        type: "object",
        properties: {
          score: { type: "number", maximum: Object(Number.POSITIVE_INFINITY) },
        },
      }),
    ).toEqual({
      schema: {},
      violations: ["parameters.properties.score.maximum is not JSON-serializable"],
    });
  });

  it("does not treat a spoofed Number tag as a boxed number", () => {
    const taggedValue = { [Symbol.toStringTag]: "Number", value: "finite" };
    expect(
      projectRuntimeToolInputSchema({
        type: "object",
        properties: {
          score: { default: taggedValue },
        },
      }),
    ).toEqual({
      schema: {
        type: "object",
        properties: {
          score: { default: { value: "finite" } },
        },
      },
      violations: [],
    });
  });

  it("ignores an unreadable Number tag that JSON serialization does not use", () => {
    const taggedValue = {
      get [Symbol.toStringTag](): string {
        throw new Error("unreadable tag");
      },
      value: "finite",
    };
    expect(
      projectRuntimeToolInputSchema({
        type: "object",
        properties: {
          score: { default: taggedValue },
        },
      }),
    ).toEqual({
      schema: {
        type: "object",
        properties: {
          score: { default: { value: "finite" } },
        },
      },
      violations: [],
    });
  });

  it("does not report schema map field names as dynamic JSON Schema keywords", () => {
    // Dynamic keywords are only invalid as JSON Schema control fields; property
    // names and definitions can legally contain the same strings.
    expect(
      projectRuntimeToolInputSchema({
        type: "object",
        $defs: {
          $dynamicAnchor: { type: "string" },
        },
        properties: {
          $dynamicRef: { type: "string" },
        },
      }).violations,
    ).toEqual([]);
  });

  it("keeps tools whose examples contain literal schema documents", () => {
    const instance = {
      document: {
        $dynamicAnchor: "node",
        properties: { child: { $dynamicRef: "#node" } },
      },
    };
    const parameters = Type.Object(
      { document: Type.Record(Type.String(), Type.Unknown()) },
      { examples: [instance] },
    );
    const original = structuredClone(parameters);
    const tool = { name: "store_schema", parameters };

    expect(projectRuntimeToolInputSchema(parameters)).toEqual({
      schema: original,
      violations: [],
    });
    expect(filterRuntimeCompatibleTools([tool])).toEqual({ tools: [tool], diagnostics: [] });
    expect(parameters).toEqual(original);
  });

  it("quarantines unreadable runtime tool fields without dropping healthy siblings", () => {
    const unreadable = {
      name: "fuzzplugin_unreadable",
      parameters: { type: "object", properties: {} },
    };
    Object.defineProperty(unreadable, "parameters", {
      enumerable: true,
      get() {
        throw new Error("fuzzplugin parameters getter exploded");
      },
    });
    const healthy = {
      name: "healthy",
      parameters: { type: "object", properties: {} },
    };

    expect(filterRuntimeCompatibleTools([unreadable, healthy])).toEqual({
      tools: [healthy],
      diagnostics: [
        {
          toolName: "fuzzplugin_unreadable",
          toolIndex: 0,
          violations: ["fuzzplugin_unreadable.parameters is unreadable"],
        },
      ],
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
    const arraySchema = {
      name: "fuzzplugin_array_root",
      parameters: { type: "array", items: { type: "number" } },
    };

    expect(filterProviderNormalizableTools([arraySchema])).toEqual({
      tools: [],
      diagnostics: [
        {
          toolName: "fuzzplugin_array_root",
          toolIndex: 0,
          violations: ['fuzzplugin_array_root.parameters.type must be "object"'],
        },
      ],
    });
  });
});
