import type { PluginHookReplyDispatchEvent } from "openclaw/plugin-sdk/core";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { PLUGIN_COMMAND_DISPATCH } from "../plugins/plugin-command-dispatch-contract.js";
import type { PluginRuntimeChannel } from "../plugins/runtime/types-channel.js";
import {
  createReplyDispatcher,
  dispatchInboundMessage,
  type GetReplyOptions,
  type ReplyDispatcher,
} from "./reply-runtime.js";

type ProgressResult = boolean | void;
type ProgressCallback = GetReplyOptions[
  | "onToolResult"
  | "onToolStart"
  | "onItemEvent"
  | "onPlanUpdate"
  | "onApprovalEvent"
  | "onCommandOutput"
  | "onPatchSummary"];
type ProgressBoundaryCallback = GetReplyOptions[
  | "onReasoningEnd"
  | "onAssistantMessageStart"
  | "onBlockReplyQueued"
  | "onCompactionStart"
  | "onCompactionEnd"];

describe("reply runtime public progress contracts", () => {
  it("retains released run-start callback arguments and synchronous completion acknowledgment", () => {
    type AgentRunStart = NonNullable<GetReplyOptions["onAgentRunStart"]>;
    type LegacyAgentRunStart = (
      runId: string,
      executionIdentityToken?: Parameters<AgentRunStart>[1],
      options?: Parameters<AgentRunStart>[2],
    ) => unknown;

    expectTypeOf<[string]>().toExtend<Parameters<AgentRunStart>>();
    expectTypeOf<Parameters<LegacyAgentRunStart>>().toExtend<Parameters<AgentRunStart>>();
    expectTypeOf<LegacyAgentRunStart>().toExtend<AgentRunStart>();
    expectTypeOf<AgentRunStart>().toExtend<LegacyAgentRunStart>();
    expectTypeOf<AgentRunStart>().returns.toEqualTypeOf<unknown>();
  });

  it("retains released synchronous visibility contracts beside awaited companions", () => {
    expectTypeOf<GetReplyOptions["onVerboseProgressVisibility"]>().toEqualTypeOf<
      ((isActive: () => boolean) => void) | undefined
    >();
    expectTypeOf<GetReplyOptions["onVerboseProgressVisibilityAsync"]>().toEqualTypeOf<
      ((isActive: () => Promise<boolean>) => Promise<void> | void) | undefined
    >();
    expectTypeOf<
      PluginHookReplyDispatchEvent["shouldSendToolSummaries"]
    >().toEqualTypeOf<boolean>();
    expectTypeOf<
      PluginHookReplyDispatchEvent["shouldSendFullToolDetails"]
    >().toEqualTypeOf<boolean>();
    expectTypeOf<PluginHookReplyDispatchEvent["shouldSendToolSummariesAsync"]>().toEqualTypeOf<
      (() => Promise<boolean>) | undefined
    >();
    expectTypeOf<PluginHookReplyDispatchEvent["shouldSendFullToolDetailsAsync"]>().toEqualTypeOf<
      (() => Promise<boolean>) | undefined
    >();
    expectTypeOf<
      Omit<
        PluginHookReplyDispatchEvent,
        "shouldSendToolSummariesAsync" | "shouldSendFullToolDetailsAsync"
      >
    >().toExtend<PluginHookReplyDispatchEvent>();
  });
  it("still accepts the deprecated suppressToolErrorWarnings option as a no-op", () => {
    // Removal window: first stable release after 2026.10 (see GetReplyOptions).
    expectTypeOf<GetReplyOptions["suppressToolErrorWarnings"]>().toEqualTypeOf<
      boolean | undefined
    >();
  });

  it("exports acceptance-aware progress callback results", () => {
    expectTypeOf<Exclude<ProgressCallback, undefined>>().returns.toEqualTypeOf<
      Promise<ProgressResult> | ProgressResult
    >();
    expectTypeOf<Exclude<GetReplyOptions["onPartialReply"], undefined>>().returns.toEqualTypeOf<
      Promise<ProgressResult> | ProgressResult
    >();
    expectTypeOf<Exclude<GetReplyOptions["onReasoningStream"], undefined>>().returns.toEqualTypeOf<
      Promise<ProgressResult> | ProgressResult
    >();
    expectTypeOf<Exclude<ProgressBoundaryCallback, undefined>>().returns.toEqualTypeOf<
      Promise<ProgressResult> | ProgressResult
    >();
  });

  it("exports the snapshotted commentary delivery gate", () => {
    expectTypeOf<GetReplyOptions["commentaryPayloadsEnabled"]>().toEqualTypeOf<
      boolean | undefined
    >();
    expectTypeOf<
      Exclude<GetReplyOptions["shouldDeliverCommentaryPayloads"], undefined>
    >().returns.toEqualTypeOf<boolean>();
  });
});

describe("reply runtime public dispatcher compatibility", () => {
  it("keeps internal event authority out of the public reply option types", () => {
    type Options = NonNullable<Parameters<typeof dispatchInboundMessage>[0]["replyOptions"]>;
    type RuntimeOptions = NonNullable<
      Parameters<PluginRuntimeChannel["reply"]["dispatchReplyFromConfig"]>[0]["replyOptions"]
    >;
    type Resolver = NonNullable<Parameters<typeof dispatchInboundMessage>[0]["replyResolver"]>;
    expectTypeOf<"internalEventExecution">().not.toExtend<keyof Options>();
    expectTypeOf<"onReplyOperationOwned">().not.toExtend<keyof Options>();
    expectTypeOf<"internalEventExecution">().not.toExtend<keyof RuntimeOptions>();
    expectTypeOf<"onReplyOperationOwned">().not.toExtend<keyof RuntimeOptions>();
    type ResolverOptions = NonNullable<Parameters<Resolver>[1]>;
    expectTypeOf<"internalEventExecution">().not.toExtend<keyof ResolverOptions>();
    expectTypeOf<"onReplyOperationOwned">().not.toExtend<keyof ResolverOptions>();
    expectTypeOf<"onSessionPrepared">().toExtend<keyof Options>();
    expectTypeOf<"onSessionPrepared">().toExtend<keyof ResolverOptions>();
  });

  it("rejects plugin-supplied event custody while retaining public reply options", async () => {
    const callback = vi.fn();
    const options = {
      isHeartbeat: true,
      onReplyStart: callback,
      internalEventExecution: { assertCurrent: callback, onStarted: callback },
      onReplyOperationOwned: callback,
      [PLUGIN_COMMAND_DISPATCH]: { kind: "non-plugin" as const },
    };
    const delivered: string[] = [];
    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        delivered.push(payload.text ?? "");
      },
    });
    let dispatched = false;
    await dispatchInboundMessage({
      ctx: { Body: "hello", SessionKey: "agent:main:sdk-reply", CommandAuthorized: false },
      cfg: {},
      dispatcher,
      replyOptions: options,
      dispatchReplyFromConfig: async ({ replyOptions }) => {
        dispatched = true;
        expect(replyOptions).not.toHaveProperty("internalEventExecution");
        expect(replyOptions).not.toHaveProperty("onReplyOperationOwned");
        expect(replyOptions).toMatchObject({
          isHeartbeat: true,
          onReplyStart: callback,
          [PLUGIN_COMMAND_DISPATCH]: { kind: "non-plugin" },
        });
        dispatcher.sendFinalReply({ text: "public reply" });
        return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
      },
    });
    expect(dispatched).toBe(true);
    expect(delivered).toEqual(["public reply"]);
    expect(options.internalEventExecution.onStarted).toBe(callback);
    expect(options.onReplyOperationOwned).toBe(callback);
  });

  it("preserves deprecated admission counters beside settled receipt outcomes", async () => {
    let releaseFirstDelivery!: () => void;
    const firstDelivery = new Promise<void>((resolve) => {
      releaseFirstDelivery = resolve;
    });
    let firstDeliveryPending = true;
    const dispatcher: ReplyDispatcher = createReplyDispatcher({
      beforeDeliver: async (payload) => (payload.text === "cancel" ? null : payload),
      deliver: async (payload) => {
        if (firstDeliveryPending) {
          firstDeliveryPending = false;
          await firstDelivery;
        }
        if (payload.text === "fail") {
          throw new Error("transport failed after send started");
        }
      },
    });

    dispatcher.sendToolResult({ text: "delivered" });
    dispatcher.sendBlockReply({ text: "cancel" });
    dispatcher.sendFinalReply({ text: "fail" });

    expect(dispatcher.getQueuedCounts()).toEqual({ tool: 1, block: 1, final: 1 });
    expect(dispatcher.getCancelledCounts?.()).toEqual({ tool: 0, block: 0, final: 0 });
    expect(dispatcher.getFailedCounts()).toEqual({ tool: 0, block: 0, final: 0 });

    releaseFirstDelivery();
    dispatcher.markComplete();
    const receipt = await dispatcher.waitForIdle();

    expect(receipt).toMatchObject({
      anyVisibleDelivered: true,
      counts: {
        tool: { delivered: 1 },
        block: { cancelled: 1 },
        final: { failedAfterSend: 1 },
      },
    });
    expect(dispatcher.getQueuedCounts()).toEqual({ tool: 1, block: 1, final: 1 });
    expect(dispatcher.getCancelledCounts?.()).toEqual({ tool: 0, block: 1, final: 0 });
    expect(dispatcher.getFailedCounts()).toEqual({ tool: 0, block: 0, final: 1 });
  });
});
