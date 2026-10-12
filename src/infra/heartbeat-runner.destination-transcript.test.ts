import { expect, it, vi } from "vitest";
import { heartbeatRunnerWhatsAppPlugin } from "../../test/helpers/infra/heartbeat-runner-channel-plugins.js";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import { loadTranscriptEvents } from "../config/sessions/session-accessor.js";
import { readTranscriptEventMessage } from "../config/sessions/session-accessor.sqlite-read.js";
import { buildChannelOutboundSessionRoute } from "../plugin-sdk/core.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import { installHeartbeatRunnerTestRuntime } from "./heartbeat-runner.test-harness.js";
import {
  heartbeatTestConfig,
  seedSessionStore,
  withTempHeartbeatSandbox,
} from "./heartbeat-runner.test-utils.js";
import { peekSystemEvents, resetSystemEventsForTest } from "./system-events.js";

installHeartbeatRunnerTestRuntime();

it("writes a confirmed isolated heartbeat to its destination without an awareness event", async () => {
  await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
    const registry = captureActivePluginRegistrySnapshot();
    const target = "+15551234567";
    const sessionKey = `agent:main:whatsapp:direct:${target}`;
    const sessionId = "heartbeat-recipient";
    const cfg = heartbeatTestConfig(tmpDir, "whatsapp", "whatsapp", storePath);
    cfg.agents!.entries = { main: {} };
    cfg.agents!.defaults!.heartbeat!.isolatedSession = true;
    cfg.agents!.defaults!.heartbeat!.to = target;
    cfg.session = { ...cfg.session, dmScope: "per-channel-peer" };
    await seedSessionStore(storePath, "agent:main:main", {
      sessionId: "heartbeat-source",
      updatedAt: Date.now(),
    });
    await seedSessionStore(storePath, sessionKey, {
      sessionId,
      updatedAt: 1,
      lastChannel: "whatsapp",
      lastTo: target,
    });
    const sendText = vi.fn(async () => ({
      channel: "whatsapp" as const,
      messageId: "heartbeat-message",
    }));
    const plugin: ChannelPlugin = {
      ...heartbeatRunnerWhatsAppPlugin,
      outbound: { deliveryMode: "direct", sendText },
      messaging: {
        targetResolver: { looksLikeId: () => true },
        resolveOutboundSessionRoute: (params) =>
          buildChannelOutboundSessionRoute({
            cfg: params.cfg,
            agentId: params.agentId,
            channel: "whatsapp",
            accountId: params.accountId,
            recipientSessionExact: true,
            peer: { kind: "direct", id: target },
            chatType: "direct",
            from: target,
            to: target,
          }),
      },
    };
    setActivePluginRegistry(createTestRegistry([{ pluginId: "whatsapp", source: "test", plugin }]));
    replySpy.mockResolvedValueOnce({ text: "Status needs attention." });
    try {
      await expect(
        runHeartbeatOnce({
          cfg,
          deps: { getReplyFromConfig: replySpy, getQueueSize: () => 0 },
        }),
      ).resolves.toMatchObject({ status: "ran" });
      expect(sendText).toHaveBeenCalledOnce();
      const messages = (
        await loadTranscriptEvents({ agentId: "main", storePath, sessionKey, sessionId })
      )
        .map(readTranscriptEventMessage)
        .filter((message) => message?.role === "assistant");
      expect(messages).toEqual([
        expect.objectContaining({
          content: [{ type: "text", text: "Status needs attention." }],
          provider: "openclaw",
          model: "automation-result",
        }),
      ]);
      expect(peekSystemEvents(sessionKey)).toEqual([]);
    } finally {
      resetSystemEventsForTest();
      restoreActivePluginRegistrySnapshot(registry);
    }
  });
});
