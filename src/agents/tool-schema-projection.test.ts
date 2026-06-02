import { describe, expect, it } from "vitest";
import {
  filterProviderNormalizableTools,
  filterRuntimeCompatibleTools,
  inspectRuntimeToolInputSchemas,
  projectRuntimeToolInputSchema,
} from "./tool-schema-projection.js";
import type { AnyAgentTool } from "./tools/common.js";

describe("runtime tool input schema projection", () => {
  it("accepts JSON object input schemas", () => {
    expect(
      projectRuntimeToolInputSchema({
        type: "object",
        properties: {
          angle: { type: "number" },
        },
      }),
    ).toEqual({
      schema: {
        type: "object",
        properties: {
          angle: { type: "number" },
        },
      },
      violations: [],
    });
  });

  it("reports non-object dynamic tool input schemas", () => {
    expect(
      inspectRuntimeToolInputSchemas([
        {
          name: "fuzzplugin_move_angles",
          parameters: { type: "array", items: { type: "number" } },
        },
      ] as never),
    ).toEqual([
      {
        toolName: "fuzzplugin_move_angles",
        toolIndex: 0,
        violations: ['fuzzplugin_move_angles.parameters.type must be "object"'],
      },
    ]);
  });

  it("reports dynamic JSON Schema keywords", () => {
    expect(
      projectRuntimeToolInputSchema({
        type: "object",
        anyOf: [{ $dynamicAnchor: "root" }],
        properties: {
          target: { $dynamicRef: "#target" },
        },
      }),
    ).toEqual({
      schema: {
        type: "object",
        anyOf: [{ $dynamicAnchor: "root" }],
        properties: {
          target: { $dynamicRef: "#target" },
        },
      },
      violations: [
        "parameters.anyOf[0].$dynamicAnchor",
        "parameters.properties.target.$dynamicRef",
      ],
    });
  });

  it("does not report schema map field names as dynamic JSON Schema keywords", () => {
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

  it("projects nullable and literal unions to OpenAPI-friendly provider schemas", () => {
    expect(
      projectRuntimeToolInputSchema({
        type: "object",
        properties: {
          agentId: {
            anyOf: [{ type: "string" }, { type: "null" }],
            description: "Agent id, or null to clear",
          },
          toolsAllow: {
            anyOf: [{ type: "array", items: { type: "string" } }, { type: "null" }],
            description: "Allowed tools, or null to clear",
          },
          mode: {
            anyOf: [
              { type: "string", const: "announce" },
              { type: "string", const: "webhook" },
              { type: "null" },
            ],
          },
          singleLiteral: {
            anyOf: [{ type: "string", const: "last" }, { type: "null" }],
          },
          flexibleId: {
            anyOf: [{ type: "string", const: "last" }, { type: "string" }, { type: "null" }],
          },
          threadId: {
            anyOf: [{ type: "string" }, { type: "number" }, { type: "null" }],
            description: "Thread/topic id",
          },
        },
      }).schema,
    ).toEqual({
      type: "object",
      properties: {
        agentId: {
          type: "string",
          description: "Agent id, or null to clear",
        },
        toolsAllow: {
          type: "array",
          items: { type: "string" },
          description: "Allowed tools, or null to clear",
        },
        mode: {
          type: "string",
          enum: ["announce", "webhook"],
        },
        singleLiteral: {
          type: "string",
          enum: ["last"],
        },
        flexibleId: {
          anyOf: [{ type: "string", const: "last" }, { type: "string" }],
        },
        threadId: {
          anyOf: [{ type: "string" }, { type: "number" }],
          description: "Thread/topic id",
        },
      },
    });
  });

  it("reports dynamic JSON Schema keywords before provider projection", () => {
    const hiddenByProjection = {
      name: "fuzzplugin_dynamic_ref_union",
      parameters: {
        type: "object",
        anyOf: [{ $dynamicRef: "#target" }, { type: "string" }],
        properties: {},
      },
    };

    expect(projectRuntimeToolInputSchema(hiddenByProjection.parameters)).toEqual({
      schema: {
        type: "object",
        anyOf: [{ $dynamicRef: "#target" }, { type: "string" }],
        properties: {},
      },
      violations: ["parameters.anyOf[0].$dynamicRef"],
    });
    expect(filterRuntimeCompatibleTools([hiddenByProjection])).toEqual({
      tools: [],
      diagnostics: [
        {
          toolName: "fuzzplugin_dynamic_ref_union",
          toolIndex: 0,
          violations: ["fuzzplugin_dynamic_ref_union.parameters.anyOf[0].$dynamicRef"],
        },
      ],
    });
  });

  it("filters unsupported schemas without dropping healthy tools", () => {
    const healthy = {
      name: "healthy",
      parameters: { type: "object", properties: {} },
    };
    const broken = {
      name: "fuzzplugin_move_angles",
      parameters: { type: "array", items: { type: "number" } },
    };

    expect(filterRuntimeCompatibleTools([healthy, broken])).toEqual({
      tools: [healthy],
      diagnostics: [
        {
          toolName: "fuzzplugin_move_angles",
          toolIndex: 1,
          violations: ['fuzzplugin_move_angles.parameters.type must be "object"'],
        },
      ],
    });
  });

  it("quarantines unreadable runtime tool entries before field projection", () => {
    const healthy = {
      name: "healthy",
      parameters: { type: "object", properties: {} },
    };
    const tools = [healthy] as Array<typeof healthy>;
    const proxy = new Proxy(tools, {
      get(target, property, receiver) {
        if (property === "1") {
          throw new Error("fuzzplugin tool entry getter exploded");
        }
        if (property === "length") {
          return 2;
        }
        return Reflect.get(target, property, receiver);
      },
    });

    expect(filterRuntimeCompatibleTools(proxy)).toEqual({
      tools: [healthy],
      diagnostics: [
        {
          toolName: "tool[1]",
          toolIndex: 1,
          violations: ["tool[1] is unreadable"],
        },
      ],
    });
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

  it("keeps provider-normalizable object schemas for provider-specific cleanup", () => {
    const dynamicSchema = {
      name: "fuzzplugin_dynamic_ref",
      parameters: {
        type: "object",
        properties: {
          target: { $dynamicRef: "#target" },
        },
      },
    };

    expect(filterProviderNormalizableTools([dynamicSchema])).toEqual({
      tools: [dynamicSchema],
      diagnostics: [],
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
