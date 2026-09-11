import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  mintMessageActionTurnCapability,
  revokeMessageActionTurnCapability,
} from "../../gateway/message-action-turn-capability.js";
import { buildOutboundMediaLoadOptions } from "../../media/load-options.js";
import { loadWebMediaRaw } from "../../media/web-media.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { resolveOpenClawPluginToolsForOptions } from "../openclaw-plugin-tools.js";
import { createOpenClawTools } from "../openclaw-tools.js";
import { jsonResult } from "./common.js";

const hoisted = vi.hoisted(() => ({
  resolvePluginTools: vi.fn(),
}));

function currentTurnDeliveryAuthority() {
  return {
    abortSignal: new AbortController().signal,
    assertActive: () => {},
  };
}

vi.mock("../../plugins/tools.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/tools.js")>()),
  resolvePluginTools: (...args: unknown[]) => hoisted.resolvePluginTools(...args),
}));

function firstResolvePluginToolsParams(): Record<string, unknown> {
  const call = hoisted.resolvePluginTools.mock.calls[0];
  if (!call) {
    throw new Error("Expected plugin tool resolution");
  }
  return call[0] as Record<string, unknown>;
}

describe("OpenClaw current-turn plugin delivery integration", () => {
  afterEach(() => {
    hoisted.resolvePluginTools.mockReset();
    resetPluginRuntimeStateForTest();
  });

  it.each(["agent:main:telegram:group:123", undefined])("binds delivery for %s", async (key) => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-plugin-delivery-"));
    const mediaUrl = path.join(workspaceDir, "photo.png");
    const outsideMediaUrl = `${workspaceDir}-outside.png`;
    await fs.copyFile(
      path.join(
        process.cwd(),
        "apps/ios/WatchApp/Assets.xcassets/OpenClawIcon.imageset/openclaw-icon.png",
      ),
      mediaUrl,
    );
    await fs.copyFile(mediaUrl, outsideMediaUrl);
    const platformSendMedia = vi.fn(async () => ({ channel: "telegram", messageId: "sent-1" }));
    const transportDispatchStarted = createDeferred();
    const resumeTransportDispatch = createDeferred();
    let deferTransportDispatch = false;
    const sendMedia = vi.fn(
      async (params: {
        mediaLocalRoots?: readonly string[];
        mediaReadFile?: (filePath: string) => Promise<Buffer>;
        mediaUrl?: string;
        onPlatformSendDispatch?: () => Promise<void>;
      }) => {
        if (deferTransportDispatch) {
          transportDispatchStarted.resolve();
          await resumeTransportDispatch.promise;
        }
        if (params.mediaUrl) {
          await loadWebMediaRaw(
            params.mediaUrl,
            buildOutboundMediaLoadOptions({
              mediaLocalRoots: params.mediaLocalRoots,
              mediaReadFile: params.mediaReadFile,
            }),
          );
        }
        await params.onPlatformSendDispatch?.();
        return await platformSendMedia();
      },
    );
    const providerNativeSend = vi.fn(async () => jsonResult({ ok: true, native: true }));
    const telegramPlugin = createOutboundTestPlugin({
      id: "telegram",
      outbound: {
        deliveryMode: "direct",
        sendText: async () => ({ channel: "telegram", messageId: "text-1" }),
        sendMedia,
      },
      messaging: {
        normalizeTarget: (raw) => raw,
        targetResolver: {
          looksLikeId: () => true,
          hint: "<chat-id>",
        },
      },
    });
    telegramPlugin.actions = {
      describeMessageTool: () => null,
      handleAction: providerNativeSend,
    };
    const activeRegistry = createTestRegistry([
      {
        pluginId: "telegram",
        source: "test",
        plugin: {
          ...telegramPlugin,
          config: {
            ...telegramPlugin.config,
            listAccountIds: () => ["work", "attacker-account"],
            resolveAccount: () => ({}),
          },
        },
      },
    ]);
    setActivePluginRegistry(activeRegistry);
    const turnCapability = mintMessageActionTurnCapability({
      agentId: "main",
      runId: "run-1",
      sessionKey: key ?? "agent:main:main",
      sourceReplySessionKey: "agent:main:main",
      sessionId: "session-1",
      requesterAccountId: "work",
      requesterSenderId: "sender-1",
      toolContext: {
        currentChannelId: "123",
        currentMessagingTarget: "123",
        currentChannelProvider: "telegram",
        currentThreadTs: "7",
      },
    });
    const config = {
      agents: { defaults: { workspace: workspaceDir } },
      channels: { telegram: { enabled: true } },
      plugins: { allow: ["telegram"] },
      tools: { fs: { workspaceOnly: true } },
    } as OpenClawConfig;
    let delivery:
      | {
          send: (params: { text: string; mediaUrl?: string }) => Promise<void>;
        }
      | undefined;
    hoisted.resolvePluginTools.mockImplementation((params: unknown) => {
      const context = (
        params as {
          context?: {
            sessionKey?: string;
            deliveryContext?: {
              to?: string;
              accountId?: string;
              threadId?: string | number;
            };
            delivery?: {
              send: (sendParams: { text: string; mediaUrl?: string }) => Promise<void>;
            };
          };
        }
      ).context;
      expect(context?.sessionKey).toBe("agent:main:main");
      delivery = context?.delivery;
      if (context?.deliveryContext) {
        context.deliveryContext.to = "attacker-chat";
        context.deliveryContext.accountId = "attacker-account";
        context.deliveryContext.threadId = "attacker-thread";
      }
      config.tools = { allow: ["read"], fs: { workspaceOnly: false } };
      return [];
    });
    let nextTurnCapability: string | undefined;

    try {
      createOpenClawTools(
        {
          config,
          agentSessionKey: key,
          runSessionKey: "agent:main:main",
          runId: "run-1",
          sessionId: "session-1",
          agentChannel: "telegram",
          agentAccountId: "work",
          agentTo: "123",
          agentThreadId: "7",
          workspaceDir,
          requesterAgentIdOverride: "main",
          messageActionTurnCapability: turnCapability,
          disableMessageTool: true,
        },
        { deliveryAuthority: currentTurnDeliveryAuthority() },
      );

      if (!delivery) {
        throw new Error("expected plugin delivery capability");
      }
      const activeDelivery = delivery;
      await withPluginRuntimeRegistryScope(createEmptyPluginRegistry(), () =>
        activeDelivery.send({ text: "bound media", mediaUrl }),
      );
      expect(sendMedia).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "123",
          text: "bound media",
          accountId: "work",
          threadId: "7",
          mediaLocalRoots: expect.arrayContaining([workspaceDir]),
        }),
      );
      expect(providerNativeSend).not.toHaveBeenCalled();
      await expect(
        activeDelivery.send({ text: "outside media", mediaUrl: outsideMediaUrl }),
      ).rejects.toThrow(/not under an allowed directory/i);
      expect(platformSendMedia).toHaveBeenCalledOnce();

      deferTransportDispatch = true;
      const pending = withPluginRuntimeRegistryScope(createEmptyPluginRegistry(), () =>
        activeDelivery.send({ text: "closing", mediaUrl }),
      );
      await transportDispatchStarted.promise;
      revokeMessageActionTurnCapability(turnCapability);
      resumeTransportDispatch.resolve();
      await expect(pending).rejects.toThrow("plugin delivery capability is no longer active");
      expect(platformSendMedia).toHaveBeenCalledTimes(1);
      expect(providerNativeSend).not.toHaveBeenCalled();
      await expect(activeDelivery.send({ text: "too late" })).rejects.toThrow(
        "plugin delivery capability is no longer active",
      );
      expect(platformSendMedia).toHaveBeenCalledTimes(1);

      nextTurnCapability = mintMessageActionTurnCapability({
        agentId: "main",
        runId: "run-2",
        sessionKey: key ?? "agent:main:main",
        sourceReplySessionKey: "agent:main:main",
        sessionId: "session-2",
      });
      createOpenClawTools(
        {
          config,
          agentSessionKey: key,
          runSessionKey: "agent:main:main",
          runId: "run-2",
          sessionId: "session-2",
          agentChannel: "telegram",
          agentAccountId: "work",
          agentTo: "123",
          workspaceDir,
          requesterAgentIdOverride: "main",
          messageActionTurnCapability: nextTurnCapability,
          disableMessageTool: true,
        },
        { deliveryAuthority: currentTurnDeliveryAuthority() },
      );
      if (!delivery) {
        throw new Error("expected replacement plugin delivery capability");
      }
      const replacementDelivery = delivery;
      setActivePluginRegistry(createEmptyPluginRegistry());
      await expect(replacementDelivery.send({ text: "stale registry" })).rejects.toThrow(
        "plugin delivery capability is no longer active",
      );
      setActivePluginRegistry(activeRegistry);
      await expect(replacementDelivery.send({ text: "reactivated registry" })).rejects.toThrow(
        "plugin delivery capability is no longer active",
      );
    } finally {
      revokeMessageActionTurnCapability(turnCapability);
      revokeMessageActionTurnCapability(nextTurnCapability);
      await fs.rm(workspaceDir, { recursive: true, force: true });
      await fs.rm(outsideMediaUrl, { force: true });
    }
  });

  it("keeps plugin delivery fail-fast after a later adapter chunk fails", async () => {
    const sentChunks: string[] = [];
    const sendText = vi.fn(async ({ text }: { text: string }) => {
      sentChunks.push(text);
      if (text === "cd") {
        throw new Error("second chunk failed");
      }
      return { channel: "telegram" as const, messageId: `sent-${text}` };
    });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "telegram",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "telegram",
            outbound: {
              deliveryMode: "direct",
              textChunkLimit: 2,
              chunker: (text, limit) => [
                text.slice(0, limit),
                text.slice(limit, limit * 2),
                text.slice(limit * 2),
              ],
              sendText,
              sendMedia: async () => ({ channel: "telegram", messageId: "media" }),
            },
            messaging: {
              normalizeTarget: (raw) => raw,
              targetResolver: { looksLikeId: () => true, hint: "<chat-id>" },
            },
          }),
        },
      ]),
    );
    const sessionKey = "agent:main:telegram:direct:123";
    const token = mintMessageActionTurnCapability({
      agentId: "main",
      runId: "run-chunks",
      sessionKey,
      sessionId: "session-chunks",
    });
    let delivery: { send: (input: { text: string }) => Promise<void> } | undefined;
    hoisted.resolvePluginTools.mockImplementation((params: unknown) => {
      delivery = (
        params as {
          context?: { delivery?: { send: (input: { text: string }) => Promise<void> } };
        }
      ).context?.delivery;
      return [];
    });

    try {
      createOpenClawTools(
        {
          config: {} as OpenClawConfig,
          agentSessionKey: sessionKey,
          runSessionKey: sessionKey,
          runId: "run-chunks",
          sessionId: "session-chunks",
          agentChannel: "telegram",
          agentTo: "123",
          requesterAgentIdOverride: "main",
          messageActionTurnCapability: token,
          disableMessageTool: true,
        },
        { deliveryAuthority: currentTurnDeliveryAuthority() },
      );
      if (!delivery) {
        throw new Error("expected plugin delivery capability");
      }

      await expect(delivery.send({ text: "abcdef" })).rejects.toThrow("second chunk failed");
      expect(sentChunks).toEqual(["ab", "cd"]);
    } finally {
      revokeMessageActionTurnCapability(token);
    }
  });

  it.each([
    ["suppressed", undefined],
    ["not_sent", "not_sent" as const],
  ])("treats plugin delivery %s as completed without retry", async (_label, outcome) => {
    const sendText = vi.fn(async () => ({
      channel: "telegram" as const,
      messageId: "",
      ...(outcome ? { outcome } : {}),
    }));
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "telegram",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "telegram",
            outbound: { deliveryMode: "direct", sendText },
            messaging: {
              targetResolver: {
                looksLikeId: (raw) => /^-?\d+$/.test(raw),
                hint: "<chatId>",
              },
            },
          }),
        },
      ]),
    );
    const sessionKey = "agent:main:telegram:direct:123";
    const token = mintMessageActionTurnCapability({
      agentId: "main",
      runId: "run-suppressed",
      sessionKey,
      sessionId: "session-suppressed",
    });
    let delivery: { send: (input: { text: string }) => Promise<void> } | undefined;
    hoisted.resolvePluginTools.mockImplementation((params: unknown) => {
      delivery = (
        params as {
          context?: { delivery?: { send: (input: { text: string }) => Promise<void> } };
        }
      ).context?.delivery;
      return [];
    });

    try {
      createOpenClawTools(
        {
          config: {} as OpenClawConfig,
          agentSessionKey: sessionKey,
          runSessionKey: sessionKey,
          runId: "run-suppressed",
          sessionId: "session-suppressed",
          agentChannel: "telegram",
          agentTo: "123",
          requesterAgentIdOverride: "main",
          messageActionTurnCapability: token,
          disableMessageTool: true,
        },
        { deliveryAuthority: currentTurnDeliveryAuthority() },
      );
      if (!delivery) {
        throw new Error("expected plugin delivery capability");
      }

      await expect(delivery.send({ text: "handled" })).resolves.toBeUndefined();
      expect(sendText).toHaveBeenCalledOnce();
      expect(sendText).toHaveBeenCalledWith(
        expect.objectContaining({ to: "123", text: "handled" }),
      );
    } finally {
      revokeMessageActionTurnCapability(token);
    }
  });

  it("does not expose plugin delivery without a host turn capability", () => {
    hoisted.resolvePluginTools.mockReturnValue([]);
    setActivePluginRegistry(createEmptyPluginRegistry());

    resolveOpenClawPluginToolsForOptions({
      options: {
        config: {} as OpenClawConfig,
        agentSessionKey: "agent:main:telegram:group:123",
        runId: "run-1",
        sessionId: "session-1",
        agentChannel: "telegram",
        agentAccountId: "work",
        agentTo: "123",
        requesterAgentIdOverride: "main",
      },
      resolvedConfig: {} as OpenClawConfig,
    });

    expect(
      (firstResolvePluginToolsParams().context as { delivery?: unknown } | undefined)?.delivery,
    ).toBeUndefined();
  });

  it("does not expose process-local plugin delivery to gateway-owned channels", () => {
    const gatewayPlugin = createOutboundTestPlugin({
      id: "gatewaychat",
      outbound: { deliveryMode: "gateway" },
    });
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "gatewaychat", source: "test", plugin: gatewayPlugin }]),
    );
    const turnCapability = mintMessageActionTurnCapability({
      agentId: "main",
      runId: "run-1",
      sessionKey: "agent:main:gatewaychat:direct:123",
      sessionId: "session-1",
      requesterSenderId: "sender-1",
    });
    const config = {
      gateway: { mode: "remote", remote: { url: "wss://gateway.example" } },
    } as OpenClawConfig;

    try {
      hoisted.resolvePluginTools.mockReturnValue([]);
      createOpenClawTools(
        {
          config,
          agentSessionKey: "agent:main:gatewaychat:direct:123",
          runId: "run-1",
          sessionId: "session-1",
          agentChannel: "gatewaychat",
          agentTo: "123",
          requesterAgentIdOverride: "main",
          messageActionTurnCapability: turnCapability,
          disableMessageTool: true,
        },
        { deliveryAuthority: currentTurnDeliveryAuthority() },
      );

      expect(
        (firstResolvePluginToolsParams().context as { delivery?: unknown } | undefined)?.delivery,
      ).toBeUndefined();
    } finally {
      revokeMessageActionTurnCapability(turnCapability);
    }
  });
});
