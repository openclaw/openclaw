import { expectDefined } from "@openclaw/normalization-core";
import { Type } from "typebox";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { createCapturedPluginRegistration } from "../plugins/captured-registration.js";
import { defineToolPlugin, getToolPluginMetadata } from "./tool-plugin.js";

const echoTool = {
  name: "echo",
  description: "Echo input.",
  parameters: Type.Object({ input: Type.String() }),
};
const pluginDetails = { id: "test-tools", name: "Test Tools", description: "Tool plugin fixture." };
function register(entry: ReturnType<typeof defineToolPlugin>, config?: Record<string, unknown>) {
  const captured = createCapturedPluginRegistration({ id: entry.id });
  if (config) {
    captured.api.pluginConfig = config;
  }
  const registerTool = vi.spyOn(captured.api, "registerTool");
  entry.register(captured.api);
  return { ...captured, registerTool };
}
function firstTool(captured: ReturnType<typeof register>) {
  return expectDefined(captured.tools[0], "captured.tools[0] test invariant");
}

describe("defineToolPlugin", () => {
  it("registers declared tools and wraps plain object results", async () => {
    const outputSchema = Type.Object({ input: Type.String(), configured: Type.Boolean() });
    const entry = defineToolPlugin({
      ...pluginDetails,
      configSchema: Type.Object({ apiKey: Type.String() }),
      tools: (tool) => [
        tool({
          ...echoTool,
          label: "Echo",
          outputSchema,
          optional: true,
          workspaceAccess: true,
          async execute(params, config) {
            expectTypeOf(params.input).toEqualTypeOf<string>();
            expectTypeOf(config.apiKey).toEqualTypeOf<string>();
            return { input: params.input, configured: config.apiKey === "test-key" };
          },
        }),
      ],
    });
    const captured = register(entry, { apiKey: "test-key" });

    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({ ...echoTool, label: "Echo", outputSchema });
    expect(captured.registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: "echo" }), {
      optional: true,
      workspaceAccess: true,
    });
    expect(getToolPluginMetadata(entry)?.tools).toMatchObject([
      { name: "echo", optional: true, workspaceAccess: true },
    ]);
    expect(getToolPluginMetadata(entry)?.tools[0]?.outputSchema).toBe(outputSchema);
    const result = await firstTool(captured).execute("call-1", { input: "OPEN" });
    expect(result).toEqual({
      details: { input: "OPEN", configured: true },
      content: [{ type: "text", text: '{\n  "input": "OPEN",\n  "configured": true\n}' }],
    });
  });

  it("wraps plain string results", async () => {
    const entry = defineToolPlugin({
      ...pluginDetails,
      tools: (tool) => [tool({ ...echoTool, execute: ({ input }) => input })],
    });
    const result = await firstTool(register(entry)).execute("call-1", { input: "hello" });
    expect(result).toEqual({
      content: [{ type: "text", text: "hello" }],
      details: "hello",
    });
  });

  it("supports context factories while keeping static tool metadata", () => {
    const entry = defineToolPlugin({
      ...pluginDetails,
      tools: (tool) => [
        tool({
          ...echoTool,
          label: "Factory Echo",
          optional: true,
          workspaceAccess: "execute",
          factory: ({ toolContext }) =>
            toolContext.sandboxed
              ? null
              : {
                  ...echoTool,
                  label: "Factory Echo",
                  execute: async () => ({ content: [], details: undefined }),
                },
        }),
      ],
    });
    const { registerTool } = register(entry);

    expect(registerTool).toHaveBeenCalledWith(expect.any(Function), {
      name: "echo",
      optional: true,
      workspaceAccess: "execute",
    });
    expect(getToolPluginMetadata(entry)?.tools).toMatchObject([
      { name: "echo", label: "Factory Echo", optional: true, workspaceAccess: "execute" },
    ]);

    const factory = registerTool.mock.calls[0]?.[0] as (ctx: { sandboxed?: boolean }) => unknown;
    expect(factory({ sandboxed: true })).toBeNull();
    expect(factory({ sandboxed: false })).toMatchObject({ name: "echo" });
  });

  it("defaults author config to a strict empty object schema", () => {
    const entry = defineToolPlugin({ ...pluginDetails, tools: () => [] });

    const expected = { type: "object", additionalProperties: false, properties: {} };
    expect(entry.configSchema.jsonSchema).toEqual(expected);
    expect(getToolPluginMetadata(entry)?.configSchema).toEqual(expected);
  });
});
