import { describe, expect, it } from "vitest";
import { capturePluginRegistration } from "./captured-registration.js";
import type { AnyAgentTool } from "./types.js";

describe("captured plugin registration", () => {
  it("keeps a complete plugin API surface available while capturing supported capabilities", () => {
    const capturedTool = {
      name: "captured-tool",
      description: "Captured tool",
      parameters: {},
      execute: async () => ({ content: [], details: {} }),
    } as unknown as AnyAgentTool;
    const captured = capturePluginRegistration({
      register(api) {
        api.registerTool(capturedTool);
        api.registerProvider({
          id: "captured-provider",
          label: "Captured Provider",
          auth: [],
        });
        api.registerChannel({
          plugin: {
            id: "captured-channel",
            meta: {
              id: "captured-channel",
              label: "Captured Channel",
              selectionLabel: "Captured Channel",
              docsPath: "/channels/captured-channel",
              blurb: "captured channel",
            },
            capabilities: { chatTypes: ["direct"] },
            config: {
              listAccountIds: () => [],
              resolveAccount: () => ({ accountId: "default" }),
            },
            outbound: { deliveryMode: "direct" },
          },
        });
        api.registerHook("message_received", () => {});
        api.registerCommand({
          name: "captured-command",
          description: "Captured command",
          handler: async () => ({ text: "ok" }),
        });
      },
    });

    expect(captured.tools.map((tool) => tool.name)).toEqual(["captured-tool"]);
    expect(captured.providers.map((provider) => provider.id)).toEqual(["captured-provider"]);
    expect(captured.api.registerMemoryEmbeddingProvider).toBeTypeOf("function");
    expect(captured.api.registerOperationsRuntime).toBeTypeOf("function");
  });
});
