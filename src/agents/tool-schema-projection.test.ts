import { describe, expect, it } from "vitest";
import {
  inspectRuntimeToolInputSchemas,
  projectRuntimeToolInputSchema,
} from "./tool-schema-projection.js";

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
          name: "dofbot_move_angles",
          parameters: { type: "array", items: { type: "number" } },
        },
      ] as never),
    ).toEqual([
      {
        toolName: "dofbot_move_angles",
        toolIndex: 0,
        violations: ['dofbot_move_angles.parameters.type must be "object"'],
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
});
