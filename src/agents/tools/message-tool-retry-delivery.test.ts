import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createReplyRestartRecoveryClaimController } from "../../auto-reply/reply/restart-recovery-claim.js";
import { createReplyRecoveryActorFixture } from "../../auto-reply/reply/restart-recovery-claim.test-support.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  mintMessageActionTurnCapability,
  revokeMessageActionTurnCapability,
} from "../../gateway/message-action-turn-capability.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import * as messageActionRunner from "../../infra/outbound/message-action-runner.js";
import { resetPluginRuntimeStateForTest } from "../../plugins/runtime.js";
import { createChannelTestPluginBase } from "../../test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { readEmbeddedMessageDeliveryFact } from "../embedded-agent-message-delivery.js";
import { readToolResultDetails } from "../tool-result-error.js";
import { createMessageTool } from "./message-tool-execution.js";
import {
  messageSource,
  registerMessageChannel,
  stubMessageSecrets,
} from "./message-tool-execution.test-support.js";

const runRealMessageAction = messageActionRunner.runMessageAction;

afterEach(() => {
  vi.restoreAllMocks();
  clearRuntimeConfigSnapshot();
  resetPluginRuntimeStateForTest();
});

it.each([
  { name: "stranded retry", retry: true, sends: 1 },
  { name: "ordinary duplicate source", retry: false, sends: 0 },
])("delivers a $name at most once through the channel", async ({ retry, sends }) => {
  await withOpenClawTestState({ layout: "state-only", prefix: "retry-send-" }, async (state) => {
    const send = vi
      .fn()
      .mockResolvedValue({ ok: true, messageId: "delivered-reply", toJid: "C123" });
    registerMessageChannel({
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
    });
    const identity = {
      agentId: "main",
      runId: "retry-runtime",
      sessionKey: "agent:main:retrychat:group:C123",
    };
    const sessionId = "retry-session";
    const sourceTurnId = "original-source";
    const storePath = path.join(state.stateDir, "agents", "main", "sessions", "sessions.json");
    const scope = { ...identity, storePath };
    const source = {
      ...messageSource("retrychat", "C123", "inbound-message"),
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
    await replaceSessionEntry(scope, entry);
    await using actor = createReplyRecoveryActorFixture({
      ...scope,
      getSessionId: () => sessionId,
    });
    const createClaim = () =>
      createReplyRestartRecoveryClaimController({
        ...scope,
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
      vi.spyOn(messageActionRunner, "runMessageAction").mockImplementation((input) =>
        runRealMessageAction({
          ...input,
          gateway: {
            request: send,
            terminalSourceReplyReceiptOwner: "caller",
            clientName: "gateway-client",
            mode: "backend",
          },
        }),
      );
      stubMessageSecrets();
      const tool = createMessageTool({
        ...identity,
        ...source,
        agentSessionKey: identity.sessionKey,
        sessionId,
        config,
        agentAccountId: "default",
        messageActionTurnCapability: capability,
        sourceReplyDeliveryMode: "message_tool_only",
      });
      const deliver = (id: string, message: string) =>
        tool.execute(id, { action: "send", target: "C123", message });
      const first = await deliver("first-send", "The result.");
      expect(send).toHaveBeenCalledTimes(sends);
      if (sends) {
        expect(
          readEmbeddedMessageDeliveryFact(readToolResultDetails(first)?.messageDelivery)
            ?.sourceReplyDelivered,
        ).toBe(true);
        expect(loadSessionEntry(scope)?.restartRecoveryDeliveryReceiptState).toBe(
          "delivered-terminal",
        );
      } else {
        expect(first).toMatchObject({ details: { status: "already_delivered" } });
      }
      const duplicate = await deliver("second-send", "The result again.");
      expect(duplicate).toMatchObject({ details: { status: "already_delivered" } });
      expect(send).toHaveBeenCalledTimes(sends);
      if (retry) {
        await claim.clear();
        expect(await createClaim().admitUserTurn()).toBe("duplicate-source");
        const replay = await deliver("replayed-send", "The result after restart.");
        expect(replay).toMatchObject({ details: { status: "already_delivered" } });
        expect(send).toHaveBeenCalledTimes(1);
      }
    } finally {
      vi.restoreAllMocks();
      revokeMessageActionTurnCapability(capability);
    }
  });
});
