/**
 * Integration test for message_sending hook in outbound delivery pipeline.
 *
 * This test verifies that the message_sending hook is properly wired up
 * in the real delivery flow, allowing plugins to:
 * - Modify outgoing message content
 * - Cancel message delivery
 *
 * Debug: `pnpm vitest run src/infra/outbound/deliver.message-sending-hook.integration.test.ts`
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type {
  PluginHookMessageContext,
  PluginHookMessageSendingEvent,
} from "../../plugins/types.js";
import { whatsappOutbound } from "../../channels/plugins/outbound/whatsapp.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";

// Mock session transcript to avoid file system operations
vi.mock("../../config/sessions.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/sessions.js")>(
    "../../config/sessions.js",
  );
  return {
    ...actual,
    appendAssistantMessageToSessionTranscript: vi.fn(async () => ({ ok: true, sessionFile: "x" })),
  };
});

const { deliverOutboundPayloads } = await import("./deliver.js");

describe("message_sending hook integration", () => {
  // Track hook calls for verification
  let hookCalls: Array<{ event: PluginHookMessageSendingEvent; ctx: PluginHookMessageContext }> =
    [];
  let hookResponse: { content?: string; cancel?: boolean } | undefined = undefined;

  // Create a real registry with a message_sending hook registered
  function createRegistryWithHook() {
    const registry = createTestRegistry([
      {
        pluginId: "whatsapp",
        plugin: createOutboundTestPlugin({ id: "whatsapp", outbound: whatsappOutbound }),
        source: "test",
      },
    ]);

    // Register a real message_sending hook
    registry.typedHooks.push({
      pluginId: "test-audit-plugin",
      hookName: "message_sending",
      handler: async (event: PluginHookMessageSendingEvent, ctx: PluginHookMessageContext) => {
        hookCalls.push({ event, ctx });
        return hookResponse;
      },
      priority: 0,
      source: "test",
    });

    return registry;
  }

  beforeEach(() => {
    hookCalls = [];
    hookResponse = undefined;
  });

  afterEach(() => {
    resetGlobalHookRunner();
    setActivePluginRegistry(createTestRegistry([]));
  });

  it("calls message_sending hook with correct event and context", async () => {
    const registry = createRegistryWithHook();
    setActivePluginRegistry(registry);
    initializeGlobalHookRunner(registry);

    const sendWhatsApp = vi.fn().mockResolvedValue({ messageId: "w1", toJid: "jid" });
    const cfg: OpenClawConfig = {};

    await deliverOutboundPayloads({
      cfg,
      channel: "whatsapp",
      to: "+1555123456",
      accountId: "test-account",
      payloads: [{ text: "Hello from integration test" }],
      deps: { sendWhatsApp },
    });

    // Verify hook was called
    expect(hookCalls).toHaveLength(1);
    expect(hookCalls[0].event).toMatchObject({
      to: "+1555123456",
      content: "Hello from integration test",
    });
    expect(hookCalls[0].ctx).toMatchObject({
      channelId: "whatsapp",
      accountId: "test-account",
      conversationId: "+1555123456",
    });

    // Verify message was sent
    expect(sendWhatsApp).toHaveBeenCalledTimes(1);
  });

  it("allows hook to modify message content", async () => {
    const registry = createRegistryWithHook();
    setActivePluginRegistry(registry);
    initializeGlobalHookRunner(registry);

    // Configure hook to modify content
    hookResponse = { content: "[MODIFIED] Original message was filtered" };

    const sendWhatsApp = vi.fn().mockResolvedValue({ messageId: "w1", toJid: "jid" });
    const cfg: OpenClawConfig = {};

    await deliverOutboundPayloads({
      cfg,
      channel: "whatsapp",
      to: "+1555123456",
      payloads: [{ text: "Original sensitive message" }],
      deps: { sendWhatsApp },
    });

    // Verify hook was called with original content
    expect(hookCalls[0].event.content).toBe("Original sensitive message");

    // Verify message was sent with modified content
    expect(sendWhatsApp).toHaveBeenCalledWith(
      "+1555123456",
      "[MODIFIED] Original message was filtered",
      expect.anything(),
    );
  });

  it("allows hook to cancel message delivery", async () => {
    const registry = createRegistryWithHook();
    setActivePluginRegistry(registry);
    initializeGlobalHookRunner(registry);

    // Configure hook to cancel delivery
    hookResponse = { cancel: true };

    const sendWhatsApp = vi.fn().mockResolvedValue({ messageId: "w1", toJid: "jid" });
    const cfg: OpenClawConfig = {};

    const results = await deliverOutboundPayloads({
      cfg,
      channel: "whatsapp",
      to: "+1555123456",
      payloads: [{ text: "This message should be blocked" }],
      deps: { sendWhatsApp },
    });

    // Verify hook was called
    expect(hookCalls).toHaveLength(1);

    // Verify message was NOT sent
    expect(sendWhatsApp).not.toHaveBeenCalled();

    // Verify no results returned
    expect(results).toHaveLength(0);
  });

  it("processes multiple payloads with hook for each", async () => {
    const registry = createRegistryWithHook();
    setActivePluginRegistry(registry);
    initializeGlobalHookRunner(registry);

    const sendWhatsApp = vi.fn().mockResolvedValue({ messageId: "w1", toJid: "jid" });
    const cfg: OpenClawConfig = {};

    await deliverOutboundPayloads({
      cfg,
      channel: "whatsapp",
      to: "+1555123456",
      payloads: [{ text: "Message 1" }, { text: "Message 2" }, { text: "Message 3" }],
      deps: { sendWhatsApp },
    });

    // Verify hook was called for each payload
    expect(hookCalls).toHaveLength(3);
    expect(hookCalls[0].event.content).toBe("Message 1");
    expect(hookCalls[1].event.content).toBe("Message 2");
    expect(hookCalls[2].event.content).toBe("Message 3");

    // Verify all messages were sent
    expect(sendWhatsApp).toHaveBeenCalledTimes(3);
  });

  it("applies hook modifications to sendPayload path", async () => {
    // Create a custom registry with sendPayload adapter
    const sendPayloadMock = vi.fn().mockResolvedValue({
      channel: "custom" as const,
      messageId: "c1",
      roomId: "r1",
    });
    const customRegistry = createTestRegistry([
      {
        pluginId: "custom",
        source: "test",
        plugin: createOutboundTestPlugin({
          id: "custom",
          outbound: {
            deliveryMode: "direct",
            sendText: vi
              .fn()
              .mockResolvedValue({ channel: "custom", messageId: "t1", roomId: "r1" }),
            sendMedia: vi
              .fn()
              .mockResolvedValue({ channel: "custom", messageId: "m1", roomId: "r1" }),
            sendPayload: sendPayloadMock,
          },
        }),
      },
    ]);

    // Register hook that modifies content
    customRegistry.typedHooks.push({
      pluginId: "test-audit-plugin",
      hookName: "message_sending",
      handler: async (event: PluginHookMessageSendingEvent, ctx: PluginHookMessageContext) => {
        hookCalls.push({ event, ctx });
        return { content: "[FILTERED] " + event.content };
      },
      priority: 0,
      source: "test",
    });

    setActivePluginRegistry(customRegistry);
    initializeGlobalHookRunner(customRegistry);

    const cfg: OpenClawConfig = {};

    await deliverOutboundPayloads({
      cfg,
      channel: "custom",
      to: "room123",
      payloads: [{ text: "Original message", channelData: { custom: true } }],
    });

    // Verify hook was called
    expect(hookCalls).toHaveLength(1);

    // Verify sendPayload received modified text
    expect(sendPayloadMock).toHaveBeenCalledTimes(1);
    const callArg = sendPayloadMock.mock.calls[0][0];
    expect(callArg.text).toBe("[FILTERED] Original message");
    expect(callArg.payload.text).toBe("[FILTERED] Original message");
    expect(callArg.payload.channelData).toEqual({ custom: true });
  });

  it("continues delivery when no hooks are registered", async () => {
    // Use registry without hooks
    const registry = createTestRegistry([
      {
        pluginId: "whatsapp",
        plugin: createOutboundTestPlugin({ id: "whatsapp", outbound: whatsappOutbound }),
        source: "test",
      },
    ]);
    setActivePluginRegistry(registry);
    initializeGlobalHookRunner(registry);

    const sendWhatsApp = vi.fn().mockResolvedValue({ messageId: "w1", toJid: "jid" });
    const cfg: OpenClawConfig = {};

    await deliverOutboundPayloads({
      cfg,
      channel: "whatsapp",
      to: "+1555123456",
      payloads: [{ text: "No hooks registered" }],
      deps: { sendWhatsApp },
    });

    // Verify no hooks were called
    expect(hookCalls).toHaveLength(0);

    // Verify message was still sent
    expect(sendWhatsApp).toHaveBeenCalledTimes(1);
  });
});
