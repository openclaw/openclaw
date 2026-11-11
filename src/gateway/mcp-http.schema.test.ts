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

  it("decides required keys per keyword when anyOf and oneOf are siblings", () => {
    const [entry] = buildMcpToolSchema([
      {
        name: "proof_tool",
        description: "proof",
        parameters: {
          anyOf: [
            { type: "object", properties: { action: { type: "string" } }, required: ["action"] },
          ],
          oneOf: [{ type: "object", properties: { mode: { type: "string" } }, required: ["mode"] }],
        },
      } as never,
    ]);

    expect((entry?.inputSchema.required as string[] | undefined)?.toSorted()).toEqual([
      "action",
      "mode",
    ]);
  });

  it("drops an empty top-level union instead of publishing it", () => {
    const [entry] = buildMcpToolSchema([
      {
        name: "proof_tool",
        description: "proof",
        parameters: { oneOf: [] },
      } as never,
    ]);

    expect(entry?.inputSchema).toEqual({ type: "object", properties: {}, required: [] });
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
