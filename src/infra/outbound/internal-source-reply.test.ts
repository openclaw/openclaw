import { afterEach, describe, expect, it, vi } from "vitest";

// Prevent bootstrapping from wiping our mock registry
vi.mock("./channel-bootstrap.runtime.js", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    bootstrapOutboundChannelPlugin: vi.fn(),
  };
});

import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { shouldUseInternalSourceReplySink } from "./internal-source-reply.js";

describe("internal-source-reply sink fallback", () => {
  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
  });

  const baseInput = {
    cfg: { channels: { "custom-slack": { enabled: true } } } as unknown as OpenClawConfig,
    action: "send",
    toolContext: { currentChannelProvider: "custom-slack", currentChannelId: "channel:C123" },
    sessionKey: "agent:main:custom-slack:channel:C123",
    sourceReplyDeliveryMode: "message_tool_only" as const,
  };

  it("routes to plugin natively if it handles send action (bypasses sink)", async () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "custom-slack",
          source: "test",
          plugin: {
            id: "custom-slack",
            actions: {
              handleAction: async () => ({ handled: true }),
              supportsAction: ({ action }: any) => action === "send",
            },
            config: {
              listAccountIds: () => ["default"],
              resolveAccount: () => ({ enabled: true }),
              isConfigured: () => true,
            },
          },
        },
      ]),
    );

    const isInternalSink = await shouldUseInternalSourceReplySink(baseInput, { message: "Test" });
    expect(isInternalSink).toBe(false);
  });

  it("falls back to internal sink if it does not support send action", async () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "custom-slack",
          source: "test",
          plugin: {
            id: "custom-slack",
            actions: {
              handleAction: async () => ({ handled: true }),
              supportsAction: ({ action }: any) => action !== "send", // Declines "send"
            },
            config: {
              listAccountIds: () => ["default"],
              resolveAccount: () => ({ enabled: true }),
              isConfigured: () => true,
            },
          },
        },
      ]),
    );

    const isInternalSink = await shouldUseInternalSourceReplySink(baseInput, { message: "Test" });
    expect(isInternalSink).toBe(true);
  });
});
