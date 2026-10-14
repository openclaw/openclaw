// Gateway-boundary proof that a message-tool send the delivery queue takes custody of keeps
// its per-turn send-budget charge (#119992). The real message tool calls the real
// `message.action` handler; that handler delivers through the real outbound path and SQLite
// delivery queue in an isolated state dir, and recovery replays the queued row through the
// real deliverer. Only the channel's transport (`sendText`) is a test double.
//
// Route: a Gateway client that carries an agent-runtime identity (the in-process route a
// turn capability selects) skips the queue for `send`, because the tool owns those retries
// (send.ts skipQueue, #124279). Queue custody reaches the message tool when its Gateway
// client carries no agent-runtime identity, as with an explicit or remote Gateway
// connection. The tool here is built without a turn capability, which dispatches the same
// way while keeping the transport in-process.
import { expect, it, vi } from "vitest";
import type { ChannelOutboundContext } from "../../channels/plugins/outbound.types.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../../gateway/agent-runtime-approval-authority.js";
import { createGatewayMethodRegistry } from "../../gateway/methods/registry.js";
import type {
  GatewayRequestContext,
  GatewayRequestHandler,
} from "../../gateway/server-methods/types.js";
import {
  claimAgentRunDelegatedAuthority,
  getActiveAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { PlatformMessageNotDispatchedError } from "../../infra/outbound/deliver-types.js";
import { deliverOutboundPayloads } from "../../infra/outbound/deliver.js";
import { recoverPendingDeliveries } from "../../infra/outbound/delivery-queue-recovery.js";
import { loadUnfinishedDeliveries } from "../../infra/outbound/delivery-queue-storage.js";
import { runMessageAction } from "../../infra/outbound/message-action-runner.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createOperationalRunInstanceRef } from "../admitted-run-context.js";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import { createMessageTool } from "./message-tool-execution.js";
import {
  buildTurnSendLedgerSessionKey,
  buildTurnSendTargetKey,
  peekTurnSendCount,
  resetTurnSendLedgerForTest,
} from "./turn-send-ledger.js";

it("keeps the cap charge while the Gateway queue owns a failed send, and recovery delivers it once", async () => {
  const state = await createOpenClawTestState({
    env: { OPENCLAW_GATEWAY_URL: undefined, OPENCLAW_GATEWAY_TOKEN: undefined },
  });
  const registry = captureActivePluginRegistrySnapshot();
  const operationalRunInstance = createOperationalRunInstanceRef("queue-custody-run");
  const runId = operationalRunInstance.runId;
  const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
  const sessionKey = "agent:ops:gatewaychat:direct:alice";
  try {
    const config: OpenClawConfig = {
      agents: { entries: { ops: {} }, defaults: { workspace: state.workspaceDir } },
      channels: { gatewaychat: { enabled: true } },
      tools: { message: { maxMessagesPerTurnPerTarget: 1 } },
    };
    setRuntimeConfigSnapshot(config, config);
    // The peer-visible transport: the first platform send fails transiently, so the queue
    // keeps the row for recovery; later sends land.
    const delivered: string[] = [];
    let failNext = true;
    const sendText = vi.fn(async ({ text }: ChannelOutboundContext) => {
      if (failNext) {
        failNext = false;
        // A refused connection provably never reached the platform, so the queue keeps
        // the row replayable instead of waiting on adapter reconciliation.
        throw new PlatformMessageNotDispatchedError("connect ECONNREFUSED", {
          cause: new Error("connect ECONNREFUSED"),
        });
      }
      delivered.push(text);
      return { channel: "gatewaychat", messageId: `m${delivered.length}` };
    });
    const plugin: ChannelPlugin = {
      ...createChannelTestPluginBase({
        id: "gatewaychat",
        capabilities: { chatTypes: ["direct"] },
        config: {
          listAccountIds: () => ["default"],
          resolveAccount: () => ({ enabled: true }),
          isConfigured: () => true,
        },
      }),
      messaging: { targetResolver: { looksLikeId: () => true } },
      outbound: { deliveryMode: "gateway", sendText },
      actions: {
        describeMessageTool: () => ({ actions: ["send"] }),
        resolveExecutionMode: () => "gateway",
      },
    };
    setActivePluginRegistry(createTestRegistry([{ pluginId: plugin.id, source: "test", plugin }]));
    const { sendHandlers } = await import("../../gateway/server-methods/send.js");
    const messageAction = sendHandlers["message.action"] as GatewayRequestHandler;
    const methods = createGatewayMethodRegistry([
      {
        name: "message.action",
        owner: { kind: "core", area: "message" },
        scope: "operator.write",
        handler: messageAction,
      },
    ]);
    const context = {
      getRuntimeConfig: () => config,
      getGatewayMethodRegistry: () => methods,
      validateAgentRuntimeApprovalAuthority: createAgentRuntimeApprovalAuthorityValidator(),
      trackExecution: <T>(run: () => Promise<T>) => run(),
      dedupe: new Map(),
    } as GatewayRequestContext;
    const toolRunMessageAction = vi.fn(runMessageAction);
    const tool = createMessageTool({
      config,
      getRuntimeConfig: () => config,
      runMessageAction: toolRunMessageAction,
      agentId: "ops",
      agentAccountId: "default",
      agentSessionKey: sessionKey,
      runId,
      getScopedChannelsCommandSecretTargets: () => ({ targetIds: new Set<string>() }),
      resolveCommandSecretRefsViaGateway: async ({ config: resolvedConfig }) => ({
        resolvedConfig,
        diagnostics: [],
        targetStatesByPath: {},
        hadUnresolvedTargets: false,
      }),
    });
    const send = (callId: string, message: string) =>
      withGatewayToolCallerIdentity(
        {
          agentId: "ops",
          sessionKey,
          operationalRunInstance,
          gatewayContextResolver: () => context,
          receiptAuthority: () =>
            getActiveAgentRunDelegatedAuthority(operationalRunInstance) === authority,
        },
        () =>
          tool.execute(callId, {
            action: "send",
            channel: "gatewaychat",
            target: "alice",
            message,
          }),
      );
    const sentKey = (call: number) =>
      (toolRunMessageAction.mock.calls[call]?.[0].params as { idempotencyKey?: string } | undefined)
        ?.idempotencyKey;
    const committed = () =>
      peekTurnSendCount({
        sessionKey: buildTurnSendLedgerSessionKey("ops", sessionKey)!,
        runId,
        targetKey: buildTurnSendTargetKey({
          channel: "gatewaychat",
          accountId: "default",
          target: "alice",
        }),
      });

    // 1. The platform send fails after the queue admitted the row, so the Gateway reports
    //    queue custody and the tool keeps the cap charge.
    const first = await send("call-1", "answer");
    expect(first.details).toMatchObject({ status: "delivery_queued", delivered: false });
    expect(sendText).toHaveBeenCalledOnce();
    expect(delivered).toEqual([]);
    expect(await loadUnfinishedDeliveries(state.stateDir)).toHaveLength(1);
    expect(committed()).toBe(1);

    // 2. A reworded send is a distinct operation: blocked before it reaches the Gateway, so
    //    it never takes queue custody of its own.
    const distinct = await send("call-2", "reworded answer");
    expect(distinct.details).toMatchObject({
      status: "suppressed",
      reason: "turn_send_budget_exhausted",
    });
    expect(toolRunMessageAction).toHaveBeenCalledOnce();
    expect(await loadUnfinishedDeliveries(state.stateDir)).toHaveLength(1);

    // 3. A same-content resend reuses the queued operation's key. It is admitted past the
    //    cap, and the Gateway answers from its operation record without a new attempt.
    const replay = await send("call-3", "answer");
    expect(replay.details).toMatchObject({ status: "delivery_queued", delivered: false });
    expect(toolRunMessageAction).toHaveBeenCalledTimes(2);
    expect(sentKey(1)).toBe(sentKey(0));
    expect(sendText).toHaveBeenCalledOnce();
    expect(await loadUnfinishedDeliveries(state.stateDir)).toHaveLength(1);
    expect(committed()).toBe(1);

    // 4. Recovery owns the retry and delivers the queued send exactly once. Move the clock
    //    past the row's retry backoff instead of waiting it out.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 10 * 60_000);
    await recoverPendingDeliveries({
      deliver: deliverOutboundPayloads,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      cfg: config,
      stateDir: state.stateDir,
    });
    expect(delivered).toEqual(["answer"]);
    expect(await loadUnfinishedDeliveries(state.stateDir)).toEqual([]);
  } finally {
    vi.useRealTimers();
    releaseAgentRunDelegatedAuthority(authority);
    restoreActivePluginRegistrySnapshot(registry);
    clearRuntimeConfigSnapshot();
    resetTurnSendLedgerForTest();
    await state.cleanup();
  }
}, 30_000);
