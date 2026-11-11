// Gateway tests cover MCP loopback schema projection behavior.
import { describe, expect, it } from "vitest";
import { buildMcpToolSchema } from "./mcp-http.schema.js";

describe("buildMcpToolSchema", () => {
  // openclaw-1azg: native tool definitions reject allOf/anyOf/oneOf at the root of
  // a tool input schema, so every top-level union keyword has to be collapsed here.
  it("merges a top-level allOf and keeps every branch's required keys", () => {
    const [entry] = buildMcpToolSchema([
      {
        name: "proof_tool",
        description: "proof",
        parameters: {
          allOf: [
            { type: "object", properties: { left: { type: "string" } }, required: ["left"] },
            { type: "object", properties: { right: { type: "number" } }, required: ["right"] },
          ],
        },
      } as never,
    ]);

    expect(entry?.inputSchema).toMatchObject({
      type: "object",
      properties: { left: { type: "string" }, right: { type: "number" } },
    });
    expect(Object.hasOwn(entry?.inputSchema ?? {}, "allOf")).toBe(false);
    expect((entry?.inputSchema.required as string[] | undefined)?.toSorted()).toEqual([
      "left",
      "right",
    ]);
  });

  it("keeps root properties and required when a top-level union is flattened", () => {
    const [entry] = buildMcpToolSchema([
      {
        name: "proof_tool",
        description: "proof",
        parameters: {
          type: "object",
          properties: { root: { type: "string" } },
          required: ["root"],
          anyOf: [
            { type: "object", properties: { branch: { type: "string" } }, required: ["branch"] },
          ],
        },
      } as never,
    ]);

    expect(entry?.inputSchema).toMatchObject({
      type: "object",
      properties: { root: { type: "string" }, branch: { type: "string" } },
    });
    expect((entry?.inputSchema.required as string[] | undefined)?.toSorted()).toEqual([
      "branch",
      "root",
    ]);
  });

  it("refuses an alternative that overlaps a root property", () => {
    expect(() =>
      buildMcpToolSchema([
        {
          name: "root_overlap",
          parameters: {
            properties: { action: { type: "string" } },
            anyOf: [
              { properties: { action: { const: "read" } } },
              { properties: { action: { const: "write" } } },
            ],
          },
        } as never,
      ]),
    ).toThrow('tool "root_overlap" input schema declares "anyOf" at the top level');
  });

  it("refuses an allOf that intersects a property across branches", () => {
    expect(() =>
      buildMcpToolSchema([
        {
          name: "all_of_overlap",
          parameters: {
            allOf: [
              { properties: { action: { enum: ["read", "write"] } } },
              { properties: { action: { enum: ["write", "delete"] } } },
            ],
          },
        } as never,
      ]),
    ).toThrow('tool "all_of_overlap" input schema declares "allOf" at the top level');
  });

  it("refuses sibling anyOf and oneOf constraints", () => {
    expect(() =>
      buildMcpToolSchema([
        {
          name: "sibling_unions",
          parameters: {
            anyOf: [{ properties: { action: { type: "string" } }, required: ["action"] }],
            oneOf: [{ properties: { mode: { type: "string" } }, required: ["mode"] }],
          },
        } as never,
      ]),
    ).toThrow('tool "sibling_unions" input schema declares "anyOf" at the top level');
  });

  it("passes a plain object schema through unchanged", () => {
    const parameters = {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
    };
    const [entry] = buildMcpToolSchema([
      { name: "proof_tool", description: "proof", parameters } as never,
    ]);

    expect(entry?.inputSchema).toEqual(parameters);
  });
});
