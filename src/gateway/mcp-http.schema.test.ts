// Gateway tests cover MCP loopback schema projection behavior.
import { describe, expect, it, vi } from "vitest";
import { buildMcpToolSchema } from "./mcp-http.schema.js";

vi.mock("../logger.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../logger.js")>()),
  logWarn: vi.fn(),
}));
const { logWarn: logWarnMock } = vi.mocked(await import("../logger.js"));

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

  // A conjunctive overlap with an exact single-object projection keeps the tool
  // and the narrowed constraint; only a genuinely unrepresentable overlap skips
  // the tool with a named warning. Alternatives within a single keyword keep the
  // keep-first-and-warn publishing contract.
  it("narrows a root property with its alternatives' literals instead of skipping", () => {
    const [entry] = buildMcpToolSchema([
      {
        name: "root_overlap",
        description: "proof",
        parameters: {
          type: "object",
          properties: { action: { type: "string" } },
          anyOf: [
            { type: "object", properties: { action: { const: "read" } } },
            { type: "object", properties: { action: { const: "write" } } },
          ],
        },
      } as never,
    ]);

    expect(entry?.inputSchema).toEqual({
      type: "object",
      properties: { action: { type: "string", enum: ["read", "write"] } },
      required: [],
    });
  });

  it("intersects overlapping allOf enums rather than widening or skipping", () => {
    const [entry] = buildMcpToolSchema([
      {
        name: "all_of_overlap",
        description: "proof",
        parameters: {
          allOf: [
            { type: "object", properties: { mode: { enum: ["read", "write"] } } },
            { type: "object", properties: { mode: { enum: ["write", "delete"] } } },
          ],
        },
      } as never,
    ]);

    expect(entry?.inputSchema).toEqual({
      type: "object",
      properties: { mode: { enum: ["write"] } },
      required: [],
    });
  });

  it("keeps an allOf branch's additionalProperties when flattening", () => {
    const [entry] = buildMcpToolSchema([
      {
        name: "closed_branch",
        description: "proof",
        parameters: {
          allOf: [
            {
              type: "object",
              properties: { value: { type: "string" } },
              required: ["value"],
              additionalProperties: false,
            },
          ],
        },
      } as never,
    ]);

    expect(entry?.inputSchema).toEqual({
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    });
  });

  it("skips a tool whose allOf branch carries a constraint one object cannot express", () => {
    const entries = buildMcpToolSchema([
      {
        name: "nested_branch",
        description: "proof",
        parameters: {
          allOf: [
            {
              type: "object",
              properties: { value: { type: "string" } },
              not: { required: ["value"] },
            },
          ],
        },
      } as never,
    ]);

    expect(entries).toEqual([]);
    expect(logWarnMock).toHaveBeenCalledWith(
      'mcp-loopback: tool "nested_branch" has an allOf branch constraining "not", which one flattened object schema cannot express; skipping the tool instead of publishing a weakened constraint',
    );
  });

  it("skips a tool that closes one conjunct while another contributes a key", () => {
    const entries = buildMcpToolSchema([
      {
        name: "closed_root",
        description: "proof",
        parameters: {
          type: "object",
          properties: { root: { type: "string" } },
          additionalProperties: false,
          anyOf: [{ type: "object", properties: { branch: { type: "string" } } }],
        },
      } as never,
    ]);

    expect(entries).toEqual([]);
    expect(logWarnMock).toHaveBeenCalledWith(
      'mcp-loopback: tool "closed_root" closes the root schema to additional properties while another combined schema contributes "branch"; skipping the tool instead of publishing a weakened constraint',
    );
  });

  it("skips a tool whose sibling anyOf and oneOf overlap on one key", () => {
    const entries = buildMcpToolSchema([
      {
        name: "sibling_overlap",
        description: "proof",
        parameters: {
          anyOf: [{ type: "object", properties: { target: { type: "string" } } }],
          oneOf: [{ type: "object", properties: { target: { type: "number" } } }],
        },
      } as never,
    ]);

    expect(entries).toEqual([]);
    expect(logWarnMock).toHaveBeenCalledWith(
      'mcp-loopback: tool "sibling_overlap" input schema constrains "target" differently across combined top-level schemas; skipping the tool instead of publishing a weakened constraint',
    );
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
