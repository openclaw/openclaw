import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createReplyRestartRecoveryClaimController } from "../../auto-reply/reply/restart-recovery-claim.js";
import { createReplyRecoveryActorFixture } from "../../auto-reply/reply/restart-recovery-claim.test-support.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  mintMessageActionTurnCapability,
  revokeMessageActionTurnCapability,
} from "../../gateway/message-action-turn-capability.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { runMessageAction } from "../../infra/outbound/message-action-runner.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { readEmbeddedMessageDeliveryFact } from "../embedded-agent-message-delivery.js";
import { readToolResultDetails } from "../tool-result-error.js";
import { createMessageTool } from "./message-tool-execution.js";

afterEach(() => {
  clearRuntimeConfigSnapshot();
  resetPluginRuntimeStateForTest();
});

describe("stranded retry message delivery", () => {
  it.each([
    { name: "stranded retry", retry: true, sends: 1 },
    { name: "ordinary duplicate source", retry: false, sends: 0 },
  ])("delivers a $name at most once through the channel", async ({ retry, sends }) => {
    await withOpenClawTestState({ layout: "state-only", prefix: "retry-send-" }, async (state) => {
      const send = vi.fn().mockResolvedValue({
        ok: true,
        messageId: "delivered-reply",
        toJid: "C123",
      });
      const plugin: ChannelPlugin = {
        ...createChannelTestPluginBase({
          id: "retrychat",
          capabilities: { chatTypes: ["group"] },
          config: {
            resolveAccount: () => ({ enabled: true }),
            isConfigured: () => true,
          },
        }),
        messaging: {
          normalizeTarget: (target) => target.replace(/^channel:/, ""),
          targetResolver: { looksLikeId: (target) => target === "C123" },
        },
        actions: {
          describeMessageTool: () => ({ actions: ["send"] }),
          resolveExecutionMode: () => "gateway",
          handleAction: vi.fn(),
        },
      };
      setActivePluginRegistry(
        createTestRegistry([{ pluginId: plugin.id, source: "test", plugin }]),
      );
      const identity = {
        agentId: "main",
        runId: "retry-runtime",
        sessionKey: "agent:main:retrychat:group:C123",
      };
      const sessionId = "retry-session";
      const sourceTurnId = "original-source";
      const storePath = path.join(state.stateDir, "agents", "main", "sessions", "sessions.json");
      const source = {
        currentChannelProvider: "retrychat",
        currentChannelId: "C123",
        currentMessagingTarget: "C123",
        currentMessageId: "inbound-message",
        currentSourceTurnId: sourceTurnId,
      };
      const config: OpenClawConfig = {
        channels: { retrychat: { enabled: true } },
        session: { store: storePath },
      };
      setRuntimeConfigSnapshot(config);
      let entry: InternalSessionEntry = {
        sessionId,
        updatedAt: 1,
        status: "done",
        restartRecoveryTerminalRunIds: [sourceTurnId],
      };
      await replaceSessionEntry({ ...identity, storePath }, entry);
      await using actor = createReplyRecoveryActorFixture({
        ...identity,
        storePath,
        getSessionId: () => sessionId,
      });
      const createClaim = () =>
        createReplyRestartRecoveryClaimController({
          ...identity,
          storePath,
          sourceTurnId,
          strandedReplyRetry: retry,
          lifecycleGeneration: getAgentEventLifecycleGeneration(),
          getEntry: () => entry,
          getSessionId: () => sessionId,
          setEntry: (next) => {
            entry = next;
          },
          acquireSessionActor: () => actor.acquireSessionActor(),
          isRestartAbort: () => false,
          resolveDeliveryContext: () => ({ channel: "retrychat", to: "C123" }),
          sourceReplyDeliveryMode: "message_tool_only",
        });
      const claim = createClaim();
      expect(await claim.admitUserTurn()).toBe(retry ? "admitted" : "duplicate-source");
      const capability = mintMessageActionTurnCapability({
        ...identity,
        requesterAccountId: "default",
        toolContext: source,
      });
      try {
        const tool = createMessageTool({
          ...identity,
          ...source,
          agentSessionKey: identity.sessionKey,
          sessionId,
          config,
          agentAccountId: "default",
          messageActionTurnCapability: capability,
          sourceReplyDeliveryMode: "message_tool_only",
          runMessageAction: (input) =>
            runMessageAction({
              ...input,
              gateway: {
                request: send,
                terminalSourceReplyReceiptOwner: "caller",
                clientName: "gateway-client",
                mode: "backend",
              },
            }),
          getScopedChannelsCommandSecretTargets: () => ({ targetIds: new Set<string>() }),
          resolveCommandSecretRefsViaGateway: async ({ config: resolvedConfig }) => ({
            resolvedConfig,
            diagnostics: [],
            targetStatesByPath: {},
            hadUnresolvedTargets: false,
          }),
        });
        const first = await tool.execute("first-send", {
          action: "send",
          target: "C123",
          message: "The result.",
        });
        expect(send).toHaveBeenCalledTimes(sends);
        if (sends) {
          expect(
            readEmbeddedMessageDeliveryFact(readToolResultDetails(first)?.messageDelivery)
              ?.sourceReplyDelivered,
          ).toBe(true);
          expect(
            loadSessionEntry({ ...identity, storePath })?.restartRecoveryDeliveryReceiptState,
          ).toBe("delivered-terminal");
        } else {
          expect(first).toMatchObject({ details: { status: "already_delivered" } });
        }
        const duplicate = await tool.execute("second-send", {
          action: "send",
          target: "C123",
          message: "The result again.",
        });
        expect(duplicate).toMatchObject({ details: { status: "already_delivered" } });
        expect(send).toHaveBeenCalledTimes(sends);
        if (retry) {
          await claim.clear();
          expect(await createClaim().admitUserTurn()).toBe("duplicate-source");
          const replay = await tool.execute("replayed-send", {
            action: "send",
            target: "C123",
            message: "The result after restart.",
          });
          expect(replay).toMatchObject({ details: { status: "already_delivered" } });
          expect(send).toHaveBeenCalledTimes(1);
        }
      } finally {
        revokeMessageActionTurnCapability(capability);
      }
    });
  });
});
