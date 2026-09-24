// Focused suite for the per-turn per-target send budget (#119992 / PR #120491), split out
// of message-tool.test.ts to keep that grandfathered file from growing. Shares the
// channel-plugin factory and runner-input type with the main suite via
// message-tool.test-support.ts; the tool-assembly wiring assertion stays in
// message-tool.test.ts where the createOpenClawTools mock forest lives.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.js";
import type { MessageActionResult } from "../../infra/outbound/message-action-contracts.js";
import { resetDiagnosticSessionStateForTest } from "../../logging/diagnostic-session-state.js";
import { resetGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { wrapStreamFnTrimToolCallNames } from "../embedded-agent-runner/run/attempt-tool-call-stream-normalization.js";
import { createMessageTool } from "./message-tool-execution.js";
import { createChannelPlugin, type RunMessageActionInput } from "./message-tool.test-support.js";
import {
  buildTurnSendLedgerSessionKey,
  buildTurnSendTargetKey,
  peekTurnSendCount,
  resetTurnSendLedgerForTest,
} from "./turn-send-ledger.js";

type CreateMessageTool = typeof createMessageTool;

const mocks = vi.hoisted(() => ({
  runMessageAction: vi.fn(),
  getRuntimeConfig: vi.fn(() => ({})),
  resolveCommandSecretRefsViaGateway: vi.fn(async ({ config }: { config: unknown }) => ({
    resolvedConfig: config,
    diagnostics: [],
  })),
  getScopedChannelsCommandSecretTargets: vi.fn(() => ({ targetIds: new Set<string>() })),
}));

vi.mock("../../channels/plugins/bundled.js", async () => {
  const actual = await vi.importActual<typeof import("../../channels/plugins/bundled.js")>(
    "../../channels/plugins/bundled.js",
  );
  return {
    ...actual,
    getBundledChannelPlugin: vi.fn(() => undefined),
    getBundledChannelSetupPlugin: vi.fn(() => undefined),
  };
});

vi.mock("../../infra/outbound/message-action-runner.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../infra/outbound/message-action-runner.js")
  >("../../infra/outbound/message-action-runner.js");
  return { ...actual, runMessageAction: mocks.runMessageAction };
});

vi.mock("../../config/config.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js");
  return { ...actual, getRuntimeConfig: mocks.getRuntimeConfig };
});

vi.mock("../../cli/command-secret-gateway.js", () => ({
  resolveCommandSecretRefsViaGateway: mocks.resolveCommandSecretRefsViaGateway,
}));

vi.mock("../../cli/command-secret-targets.js", () => ({
  getScopedChannelsCommandSecretTargets: mocks.getScopedChannelsCommandSecretTargets,
}));

vi.mock("../../channels/plugins/message-tool-api.js", () => ({
  resolveBundledChannelMessageToolDiscoveryAdapter: () => ({
    describeMessageTool: () => ({ actions: ["send"], capabilities: [] }),
  }),
}));

const { runMessageAction: actualRunMessageAction } = await vi.importActual<
  typeof import("../../infra/outbound/message-action-runner.js")
>("../../infra/outbound/message-action-runner.js");

beforeEach(() => {
  resetGlobalHookRunner();
  resetPluginRuntimeStateForTest();
  resetDiagnosticSessionStateForTest();
  mocks.runMessageAction.mockReset();
  mocks.getRuntimeConfig.mockReset().mockReturnValue({});
  mocks.resolveCommandSecretRefsViaGateway.mockReset().mockImplementation(async ({ config }) => ({
    resolvedConfig: config,
    diagnostics: [],
  }));
  mocks.getScopedChannelsCommandSecretTargets.mockClear();
  setActivePluginRegistry(createTestRegistry([]));
});

afterEach(() => {
  resetGlobalHookRunner();
  resetTurnSendLedgerForTest();
});

describe("per-turn send budget", () => {
  const currentChat = "iMessage;-;+15550002222";
  let sessionCounter = 0;

  function registerImessageSendPlugin() {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "imessage",
          source: "test",
          plugin: createChannelPlugin({
            id: "imessage",
            label: "iMessage",
            docsPath: "/channels/imessage",
            blurb: "iMessage test plugin",
            actions: ["send", "sendAttachment"],
            config: { listAccountIds: () => ["primary"] },
          }),
        },
      ]),
    );
  }

  // A real direct-mode iMessage outbound adapter that records every delivered text. Used
  // by the direct-route replay test so the REAL runMessageAction -> sendMessage path drives
  // the adapter and its call count is the authoritative "delivered exactly once" proof.
  function registerImessageDirectDeliveryPlugin(deliveries: string[]) {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "imessage",
          source: "test",
          plugin: createChannelPlugin({
            id: "imessage",
            label: "iMessage",
            docsPath: "/channels/imessage",
            blurb: "iMessage test plugin",
            actions: ["send", "sendAttachment"],
            config: { listAccountIds: () => ["primary"] },
            outbound: {
              deliveryMode: "direct",
              sendText: async (ctx) => {
                deliveries.push(ctx.text);
                return {
                  channel: "imessage" as ChannelPlugin["id"],
                  messageId: `m${deliveries.length}`,
                };
              },
            },
          }),
        },
      ]),
    );
  }

  // A gateway-mode iMessage plugin. Route detection reads outbound.deliveryMode, so this
  // makes the message tool treat the send as genuinely Gateway-routed (repeat idempotency
  // keys are deduped to the completed operation by the backend). Its send methods are never
  // called: the gateway-route replay test keeps the runner mocked to model that dedup.
  function registerImessageGatewayDeliveryPlugin() {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "imessage",
          source: "test",
          plugin: createChannelPlugin({
            id: "imessage",
            label: "iMessage",
            docsPath: "/channels/imessage",
            blurb: "iMessage test plugin",
            actions: ["send", "sendAttachment"],
            config: { listAccountIds: () => ["primary"] },
            outbound: { deliveryMode: "gateway" },
          }),
        },
      ]),
    );
  }

  function createBudgetTool(params?: {
    sessionKey?: string;
    runId?: string;
    maxPerTurn?: number;
    turnSendNudge?: boolean;
  }) {
    registerImessageSendPlugin();
    const sessionKey =
      params?.sessionKey ?? `agent:test:imessage:direct:budget${(sessionCounter += 1)}`;
    const messageConfig: Record<string, unknown> = {};
    if (params?.maxPerTurn !== undefined) {
      messageConfig.maxMessagesPerTurnPerTarget = params.maxPerTurn;
    }
    if (params?.turnSendNudge !== undefined) {
      messageConfig.turnSendNudge = params.turnSendNudge;
    }
    const config =
      Object.keys(messageConfig).length === 0
        ? undefined
        : ({ tools: { message: messageConfig } } as never);
    return createMessageTool({
      currentChannelProvider: "imessage",
      currentChannelId: currentChat,
      agentAccountId: "primary",
      agentSessionKey: sessionKey,
      runId: params?.runId ?? "run-budget-1",
      sourceReplyDeliveryMode: "message_tool_only",
      runMessageAction: mocks.runMessageAction as never,
      ...(config ? { config } : {}),
    });
  }

  function stubSend(overrides?: {
    dryRun?: boolean;
    kind?: "send" | "broadcast";
    deliveryStatus?: "suppressed" | "failed" | "partial_failed";
  }) {
    mocks.runMessageAction.mockReset();
    if (overrides?.kind === "broadcast") {
      mocks.runMessageAction.mockResolvedValue({
        kind: "broadcast",
        action: "broadcast",
        channel: "imessage",
        handledBy: "core",
        payload: { results: [] },
        dryRun: false,
      } as MessageActionResult);
      return;
    }
    // A core send reports its outcome via sendResult.deliveryStatus. A best-effort
    // send never throws, so "suppressed" (no_visible_payload) and "failed" both reach
    // the tool as a returned status and must not count; "partial_failed" still counts.
    const deliveryStatus = overrides?.deliveryStatus;
    mocks.runMessageAction.mockResolvedValue({
      kind: "send",
      action: "send",
      channel: "imessage",
      to: currentChat,
      handledBy: deliveryStatus ? "core" : "plugin",
      payload: {},
      dryRun: overrides?.dryRun ?? false,
      ...(deliveryStatus
        ? {
            sendResult: {
              channel: "imessage",
              to: currentChat,
              via: "direct",
              mediaUrl: null,
              deliveryStatus,
            },
          }
        : {}),
    } as MessageActionResult);
  }

  function softNotice(result: { content: Array<{ type: string; text?: string }> }) {
    return result.content
      .filter((entry): entry is { type: "text"; text: string } => entry.type === "text")
      .map((entry) => entry.text)
      .find((text) => text.includes("already sent"));
  }

  async function send(tool: ReturnType<CreateMessageTool>, message: string, action = "send") {
    return tool.execute(`call-${message}`, { action, channel: "imessage", message });
  }

  it("stays silent on the first send to a target", async () => {
    stubSend();
    const tool = createBudgetTool();
    const result = await send(tool, "first");
    expect(softNotice(result)).toBeUndefined();
  });

  it("appends a soft reminder from the second send to the same target this turn", async () => {
    stubSend();
    const tool = createBudgetTool();
    const first = await send(tool, "first");
    const second = await send(tool, "second variant");
    const third = await send(tool, "third variant");
    expect(softNotice(second)).toContain("already sent 2 messages");
    expect(softNotice(third)).toContain("already sent 3 messages");
    // The reminder also rides in the projected details so a Code Mode guest, which
    // only receives details (content is dropped), still sees it. The details string
    // matches the content notice by construction.
    expect(first.details).not.toMatchObject({ turnSendNotice: expect.any(String) });
    expect(second.details).toMatchObject({
      turnSendNotice: expect.stringContaining("already sent 2 messages"),
    });
    expect(third.details).toMatchObject({
      turnSendNotice: expect.stringContaining("already sent 3 messages"),
    });
    // Never blocks without an opt-in cap.
    expect(second.details).not.toMatchObject({ status: "suppressed" });
    expect(mocks.runMessageAction).toHaveBeenCalledTimes(3);
  });

  it("resets the count for a new turn (new runId, same session)", async () => {
    stubSend();
    const sessionKey = "agent:test:imessage:direct:budget-shared";
    const firstTurn = createBudgetTool({ sessionKey, runId: "run-a" });
    await send(firstTurn, "a1");
    await send(firstTurn, "a2");
    const secondTurn = createBudgetTool({ sessionKey, runId: "run-b" });
    const result = await send(secondTurn, "b1");
    expect(softNotice(result)).toBeUndefined();
  });

  it("does not count a suppressed core send", async () => {
    stubSend({ deliveryStatus: "suppressed" });
    const tool = createBudgetTool({ maxPerTurn: 1 });
    const first = await send(tool, "first");
    // A suppressed delivery reached the runner but not the peer, so no nudge.
    expect(softNotice(first)).toBeUndefined();
    // A confirmed delivery to the same target is now the first counted send: it is
    // not blocked (the suppressed send never consumed the cap slot) and stays silent.
    stubSend();
    const second = await send(tool, "second");
    expect(second.details).not.toMatchObject({ status: "suppressed" });
    expect(softNotice(second)).toBeUndefined();
    expect(mocks.runMessageAction).toHaveBeenCalledTimes(1);
  });

  it("does not count a failed best-effort send", async () => {
    // Current-source replies are forced bestEffort=true, so a failed send returns
    // deliveryStatus "failed" instead of throwing; nothing reached the peer.
    stubSend({ deliveryStatus: "failed" });
    const tool = createBudgetTool();
    const first = await send(tool, "first");
    expect(softNotice(first)).toBeUndefined();
    // The next confirmed delivery is the first counted send and stays silent; a
    // second confirmed delivery then nudges at count 2, not 3.
    stubSend();
    const second = await send(tool, "second");
    expect(softNotice(second)).toBeUndefined();
    const third = await send(tool, "third");
    expect(softNotice(third)).toContain("already sent 2 messages");
  });

  it("does not let a failed best-effort send block the next send under the hard cap", async () => {
    stubSend({ deliveryStatus: "failed" });
    const tool = createBudgetTool({ maxPerTurn: 1 });
    const first = await send(tool, "first");
    // The failed send never consumed the cap slot, so it did not block anything.
    expect(first.details).not.toMatchObject({ status: "suppressed" });
    // stubSend resets the mock; if the failed send had counted, the cap would block the
    // next send before dispatch and the runner would never be reached (0 calls). It is
    // admitted instead, so the runner is called once.
    stubSend();
    const second = await send(tool, "second");
    expect(second.details).not.toMatchObject({ status: "suppressed" });
    expect(mocks.runMessageAction).toHaveBeenCalledTimes(1);
  });

  it("counts a partial_failed send (a visible partial message reached the peer)", async () => {
    stubSend({ deliveryStatus: "partial_failed" });
    const tool = createBudgetTool();
    const first = await send(tool, "first");
    expect(softNotice(first)).toBeUndefined();
    // partial_failed counts, so the second send to the same target nudges at count 2.
    stubSend({ deliveryStatus: "partial_failed" });
    const second = await send(tool, "second");
    expect(softNotice(second)).toContain("already sent 2 messages");
  });

  it("blocks the next send after a partial_failed send reaches the hard cap", async () => {
    stubSend({ deliveryStatus: "partial_failed" });
    const tool = createBudgetTool({ maxPerTurn: 1 });
    await send(tool, "first");
    expect(mocks.runMessageAction).toHaveBeenCalledTimes(1);
    const blocked = await send(tool, "second");
    // The partial_failed send consumed the single-send budget, so this is blocked.
    expect(blocked.details).toMatchObject({
      status: "suppressed",
      reason: "turn_send_budget_exhausted",
    });
    expect(mocks.runMessageAction).toHaveBeenCalledTimes(1);
  });

  it("does not count dry-run results", async () => {
    stubSend({ dryRun: true });
    const tool = createBudgetTool();
    await send(tool, "first");
    const second = await send(tool, "second");
    expect(softNotice(second)).toBeUndefined();
  });

  it("does not count a throwing send", async () => {
    mocks.runMessageAction.mockReset();
    mocks.runMessageAction.mockRejectedValueOnce(new Error("delivery failed"));
    const tool = createBudgetTool();
    await expect(send(tool, "boom")).rejects.toThrow("delivery failed");
    stubSend();
    const second = await send(tool, "after failure");
    // The failed send never incremented the ledger, so this is the first success.
    expect(softNotice(second)).toBeUndefined();
  });

  it("does not count broadcast fan-out", async () => {
    stubSend({ kind: "broadcast" });
    const tool = createBudgetTool();
    const first = await tool.execute("bc-1", {
      action: "broadcast",
      channel: "all",
      message: "hi",
    });
    const second = await tool.execute("bc-2", {
      action: "broadcast",
      channel: "all",
      message: "hi again",
    });
    expect(softNotice(first)).toBeUndefined();
    expect(softNotice(second)).toBeUndefined();
  });

  it("isolates counts across sessions", async () => {
    stubSend();
    const toolA = createBudgetTool({ sessionKey: "agent:test:imessage:direct:iso-a" });
    const toolB = createBudgetTool({ sessionKey: "agent:test:imessage:direct:iso-b" });
    await send(toolA, "a1");
    const bFirst = await send(toolB, "b1");
    expect(softNotice(bFirst)).toBeUndefined();
  });

  it("blocks before dispatch once the opt-in hard cap is reached", async () => {
    stubSend();
    const tool = createBudgetTool({ maxPerTurn: 1 });
    await send(tool, "first");
    expect(mocks.runMessageAction).toHaveBeenCalledTimes(1);
    const blocked = await send(tool, "second");
    expect(blocked.details).toMatchObject({
      status: "suppressed",
      reason: "turn_send_budget_exhausted",
    });
    // The second send never reached the runner.
    expect(mocks.runMessageAction).toHaveBeenCalledTimes(1);
  });

  it("suppresses an idempotent replay on a direct route and delivers exactly once (real delivery path)", async () => {
    // Route-aware admission (PR #120491 / #119992). On a direct in-process channel the
    // delivery layer does NOT dedup on the idempotency key, so a repeated send is a genuine
    // second delivery. The tool therefore WITHHOLDS the operationId from the ledger on a
    // direct route, so under maxMessagesPerTurnPerTarget:1 an identical replay is treated as
    // an ordinary new send and cap-blocked before dispatch. This drives the REAL
    // runMessageAction -> sendMessage -> outbound adapter path (no mocked runner), so the
    // recording adapter's own call count is the authoritative "delivered exactly once" proof
    // — the very re-delivery the previous mock-runner version wrongly assumed away.
    const deliveries: string[] = [];
    registerImessageDirectDeliveryPlugin(deliveries);
    mocks.runMessageAction.mockReset();
    mocks.runMessageAction.mockImplementation(actualRunMessageAction as never);
    const tool = createMessageTool({
      currentChannelProvider: "imessage",
      currentChannelId: currentChat,
      agentId: "test",
      agentAccountId: "primary",
      agentSessionKey: "agent:test:imessage:direct:real-direct-replay",
      runId: "run-real-direct",
      config: {
        channels: { imessage: { enabled: true } },
        tools: { message: { maxMessagesPerTurnPerTarget: 1 } },
      } as never,
      runMessageAction: mocks.runMessageAction as never,
    });
    const args = {
      action: "send",
      channel: "imessage",
      target: "+15550009999",
      message: "same answer",
    };

    // First send: admitted, real direct delivery, adapter records one message.
    const first = await tool.execute("call-real-direct", { ...args }, undefined);
    expect(first.details).not.toMatchObject({ status: "suppressed" });
    expect(deliveries).toEqual(["same answer"]);

    // Replay (same toolCallId + identical params -> same autogenerated idempotency key):
    // cap-blocked before dispatch because the direct route withholds the operationId.
    const replay = await tool.execute("call-real-direct", { ...args }, undefined);
    expect(replay.details).toMatchObject({
      status: "suppressed",
      reason: "turn_send_budget_exhausted",
    });
    // No re-delivery: the direct adapter received the message exactly once.
    expect(deliveries).toEqual(["same answer"]);
  });

  it("admits an idempotent replay on a Gateway-routed channel without re-delivering or double-counting", async () => {
    // The gateway-route counterpart to the direct-route test above. On a genuinely
    // Gateway-routed channel (outbound.deliveryMode "gateway") the backend resolves a
    // repeated idempotency key to the already-completed operation and returns it without
    // sending again, so the tool DOES hand the operationId to the ledger: under
    // maxMessagesPerTurnPerTarget:1 an identical replay is admitted past the cap (`replay`),
    // reaches the runner, draws no false nudge, and does not double-count. The mocked runner
    // models the backend's key-based dedup (one physical delivery per distinct idempotency
    // key); the real Gateway dedup is proven end to end by per-turn-send-budget.e2e.test.ts
    // scenario 4.
    registerImessageGatewayDeliveryPlugin();
    const deliveredKeys = new Set<string>();
    mocks.runMessageAction.mockReset();
    mocks.runMessageAction.mockImplementation(async (input: RunMessageActionInput) => {
      deliveredKeys.add(String(input.params?.idempotencyKey));
      return {
        kind: "send",
        action: "send",
        channel: "imessage",
        to: currentChat,
        handledBy: "plugin",
        payload: {},
        dryRun: false,
      } as MessageActionResult;
    });
    const sessionKey = "agent:test:imessage:direct:gw-replay";
    const runId = "run-gw-replay";
    const tool = createMessageTool({
      currentChannelProvider: "imessage",
      currentChannelId: currentChat,
      agentId: "test",
      agentAccountId: "primary",
      agentSessionKey: sessionKey,
      runId,
      sourceReplyDeliveryMode: "message_tool_only",
      runMessageAction: mocks.runMessageAction as never,
      config: { tools: { message: { maxMessagesPerTurnPerTarget: 1 } } } as never,
    });
    const args = { action: "send", channel: "imessage", message: "only" };

    // First send: admitted, one delivery, counted (count 1).
    const first = await tool.execute("call-gw-replay", { ...args }, undefined);
    expect(first.details).not.toMatchObject({ status: "suppressed" });
    expect(softNotice(first)).toBeUndefined();
    expect(mocks.runMessageAction).toHaveBeenCalledTimes(1);

    // Replay (same toolCallId + identical params): admitted past the cap and reaches the
    // runner a second time, but the backend dedups the repeated key, so exactly one physical
    // delivery lands and no false nudge fires.
    const replay = await tool.execute("call-gw-replay", { ...args }, undefined);
    expect(replay.details).not.toMatchObject({
      status: "suppressed",
      reason: "turn_send_budget_exhausted",
    });
    expect(softNotice(replay)).toBeUndefined();
    expect(mocks.runMessageAction).toHaveBeenCalledTimes(2);
    expect(deliveredKeys.size).toBe(1);

    // No double count: the ledger still records exactly one send for the turn.
    const ledgerSessionKey = buildTurnSendLedgerSessionKey("test", sessionKey)!;
    const targetKey = buildTurnSendTargetKey({
      channel: "imessage",
      accountId: "primary",
      target: currentChat,
    });
    expect(peekTurnSendCount({ sessionKey: ledgerSessionKey, runId, targetKey })).toBe(1);
  });

  it("disambiguates a duplicate model-emitted toolCallId into a distinct cap-blocked send, not an idempotent replay", async () => {
    // #119992 / PR #120491: distinct tool-call ids derive distinct idempotency keys, so a
    // second same-target send is a NEW send subject to the cap, never an idempotent replay.
    // The runtime disambiguates a duplicate model-emitted tool-call id BEFORE the tool sees
    // it, so two same-answer sends the model emits under one id still reach the tool as
    // distinct ids and the second is cap-blocked. (On a direct route the tool would now
    // cap-block a genuine same-id replay too — see the direct-route replay test above — but
    // this disambiguation still holds on every route and is what per-turn-send-budget
    // .e2e.test.ts scenario 6 proves end to end; this covers the same chain at a faster unit
    // layer.) It is honestly labeled: this proves the CAP-BLOCK/disambiguation path.
    const args = { action: "send", channel: "imessage", message: "same reworded answer" };

    // (1) The model emits the SAME `message` tool-call id twice in one response, with
    // byte-identical arguments (the duplicate-answer scenario #119992 guards). Drive the
    // real streaming normalization the runtime runs on every response
    // (wrapStreamFnTrimToolCallNames -> normalizeToolCallIdsInMessage).
    const callA = { type: "toolCall", name: "message", id: "call_dup", arguments: { ...args } };
    const callB = { type: "toolCall", name: "message", id: "call_dup", arguments: { ...args } };
    const finalMessage = { role: "assistant", content: [callA, callB] };
    const baseFn = vi.fn(() => ({
      result: async () => finalMessage,
      [Symbol.asyncIterator]: () => (async function* () {})(),
    }));
    const wrappedFn = wrapStreamFnTrimToolCallNames(baseFn as never, new Set(["message"]));
    const stream = await Promise.resolve(wrappedFn({} as never, {} as never, {} as never));
    await (stream as { result: () => Promise<unknown> }).result();

    // The duplicate id was rewritten to a fresh unique id, so the two executed tool calls
    // now carry DISTINCT ids — the disambiguation that makes the replay branch
    // unreachable from a real model turn.
    expect(callA.id).toBe("call_dup");
    expect(callB.id).not.toBe("call_dup");
    expect(callB.id).not.toBe(callA.id);

    // (2) Execute the message tool with the two disambiguated ids under a cap of 1, using
    // byte-identical params. Distinct toolCallIds derive distinct idempotency keys
    // (deriveMessageToolIdempotency keys on the toolCallId), so the second copy is a NEW
    // send subject to the cap — not a replay.
    stubSend();
    const tool = createBudgetTool({ maxPerTurn: 1 });
    const first = await tool.execute(callA.id, { ...args }, undefined);
    expect(first.details).not.toMatchObject({ status: "suppressed" });
    expect(mocks.runMessageAction).toHaveBeenCalledTimes(1);

    const second = await tool.execute(callB.id, { ...args }, undefined);
    // Cap-blocked before dispatch — NOT admitted as a replay: exactly one delivery on the
    // direct channel. Had the duplicate id NOT been disambiguated (both executed as
    // "call_dup"), the second would derive the SAME idempotency key, be admitted as an
    // idempotent replay, and reach the runner a second time (the re-delivery this guard
    // prevents on a direct channel — see the "admits an idempotent replay" test above).
    expect(second.details).toMatchObject({
      status: "suppressed",
      reason: "turn_send_budget_exhausted",
    });
    expect(mocks.runMessageAction).toHaveBeenCalledTimes(1);
  });

  it("exempts media actions from the hard cap while still counting them", async () => {
    stubSend();
    const tool = createBudgetTool({ maxPerTurn: 1 });
    await send(tool, "attach-1", "sendAttachment");
    const second = await send(tool, "attach-2", "sendAttachment");
    // Not blocked despite the cap, because media is exempt...
    expect(second.details).not.toMatchObject({ status: "suppressed" });
    expect(mocks.runMessageAction).toHaveBeenCalledTimes(2);
    // ...but the soft reminder still fires.
    expect(softNotice(second)).toContain("already sent 2 messages");
  });

  it("suppresses the soft reminder when turnSendNudge is disabled", async () => {
    stubSend();
    const tool = createBudgetTool({ turnSendNudge: false });
    await send(tool, "first");
    const second = await send(tool, "second variant");
    const third = await send(tool, "third variant");
    // The nudge text is gated off...
    expect(softNotice(second)).toBeUndefined();
    expect(softNotice(third)).toBeUndefined();
    // ...but every send still reached the runner (counting is unaffected).
    expect(mocks.runMessageAction).toHaveBeenCalledTimes(3);
  });

  it("still enforces the hard cap when turnSendNudge is disabled", async () => {
    stubSend();
    const tool = createBudgetTool({ maxPerTurn: 1, turnSendNudge: false });
    await send(tool, "first");
    expect(mocks.runMessageAction).toHaveBeenCalledTimes(1);
    const blocked = await send(tool, "second");
    // Counting kept running past the first send, so the cap still blocks...
    expect(blocked.details).toMatchObject({
      status: "suppressed",
      reason: "turn_send_budget_exhausted",
    });
    expect(mocks.runMessageAction).toHaveBeenCalledTimes(1);
  });
});
