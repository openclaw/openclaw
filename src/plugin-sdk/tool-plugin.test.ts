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
  const id = entry.id;
  const captured = createCapturedPluginRegistration({
    id,
    ...(config ? { config: { plugins: { entries: { [id]: { config } } } } } : {}),
  });
  if (config) {
    captured.api.pluginConfig = config;
  }
  entry.register(captured.api);
  return captured;
}
function captureRegistration(entry: ReturnType<typeof defineToolPlugin>, pluginConfig = {}) {
  const captured = createCapturedPluginRegistration({ id: entry.id });
  captured.api.pluginConfig = pluginConfig;
  const registerTool = vi.fn<typeof captured.api.registerTool>();
  captured.api.registerTool = registerTool;
  entry.register(captured.api);
  return registerTool;
}
function firstTool(captured: ReturnType<typeof register>) {
  return expectDefined(captured.tools[0], "captured.tools[0] test invariant");
}

describe("defineToolPlugin", () => {
  it("registers declared tools and wraps plain object results", async () => {
    const outputSchema = Type.Object(
      { symbol: Type.String(), configured: Type.Boolean() },
      { additionalProperties: false },
    );
    const entry = defineToolPlugin({
      ...pluginDetails,
      configSchema: Type.Object({ apiKey: Type.String() }),
      tools: (tool) => [
        tool({
          name: "quote",
          label: "Quote",
          description: "Fetch a quote.",
          parameters: Type.Object({ symbol: Type.String() }),
          outputSchema,
          async execute(params, config) {
            expectTypeOf(params.symbol).toEqualTypeOf<string>();
            expectTypeOf(config.apiKey).toEqualTypeOf<string>();
            return { symbol: params.symbol, configured: config.apiKey === "test-key" };
          },
        }),
      ],
    });
    const captured = register(entry, { apiKey: "test-key" });

    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: "quote",
      label: "Quote",
      description: "Fetch a quote.",
      outputSchema,
    });
    expect(getToolPluginMetadata(entry)?.tools[0]?.outputSchema).toBe(outputSchema);
    const result = await firstTool(captured).execute("call-1", { symbol: "OPEN" });
    expect(result.details).toEqual({ symbol: "OPEN", configured: true });
    expect(result.content).toEqual([
      { type: "text", text: JSON.stringify({ symbol: "OPEN", configured: true }, null, 2) },
    ]);
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

  it("passes optional tool workspace access through registration and metadata", () => {
    const workspaceAccess = true;
    const entry = defineToolPlugin({
      ...pluginDetails,
      tools: (tool) => [
        tool({
          ...echoTool,
          name: "optional_echo",
          optional: true,
          workspaceAccess,
          execute: ({ input }) => input,
        }),
      ],
    });
    const registerTool = captureRegistration(entry);

    expect(registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: "optional_echo" }), {
      optional: true,
      workspaceAccess,
    });
    expect(getToolPluginMetadata(entry)?.tools).toMatchObject([
      { name: "optional_echo", optional: true, workspaceAccess },
    ]);
  });

  it("supports context factories while keeping static tool metadata", () => {
    const entry = defineToolPlugin({
      ...pluginDetails,
      configSchema: Type.Object({ prefix: Type.String() }),
      tools: (tool) => [
        tool({
          ...echoTool,
          name: "factory_echo",
          label: "Factory Echo",
          optional: true,
          workspaceAccess: "execute",
          factory({ toolContext }) {
            if (toolContext.sandboxed) {
              return null;
            }
            return {
              ...echoTool,
              name: "factory_echo",
              label: "Factory Echo",
              execute: async () => ({ content: [], details: undefined }),
            };
          },
        }),
      ],
    });
    const registerTool = captureRegistration(entry, { prefix: "ctx" });

    expect(registerTool).toHaveBeenCalledWith(expect.any(Function), {
      name: "factory_echo",
      optional: true,
      workspaceAccess: "execute",
    });
    expect(getToolPluginMetadata(entry)?.tools).toMatchObject([
      { name: "factory_echo", label: "Factory Echo", optional: true, workspaceAccess: "execute" },
    ]);

    const factory = registerTool.mock.calls[0]?.[0] as (ctx: { sandboxed?: boolean }) => unknown;
    expect(factory({ sandboxed: true })).toBeNull();
    expect(factory({ sandboxed: false })).toMatchObject({ name: "factory_echo" });
  });

  it("defaults author config to a strict empty object schema", () => {
    const entry = defineToolPlugin({ ...pluginDetails, tools: () => [] });

    const expected = { type: "object", additionalProperties: false, properties: {} };
    expect(entry.configSchema.jsonSchema).toEqual(expected);
    expect(getToolPluginMetadata(entry)?.configSchema).toEqual(expected);
  });
});
