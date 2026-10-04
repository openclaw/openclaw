import { describe, expect, expectTypeOf, it } from "vitest";
import { REPLY_ADMISSION_TICKET } from "../auto-reply/reply/reply-admission-ticket.js";
import { REPLY_OPERATION_RUN_STATE } from "../auto-reply/reply/reply-operation-run-state.js";
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
  it("strips private authority at public dispatch", async () => {
    const onReplyStart = () => {};
    const publicOptions = {
      onReplyStart,
      typingPolicy: "system_event",
    } satisfies GetReplyOptions;
    expectTypeOf(publicOptions).toMatchTypeOf<
      NonNullable<
        Parameters<PluginRuntimeChannel["reply"]["dispatchReplyFromConfig"]>[0]["replyOptions"]
      >
    >();
    const options = {
      ...publicOptions,
      scheduledAutomation: { job: { id: "copied-job" }, assertCurrent: () => {} },
      modelOverride: "example/private-model",
      internalEventExecution: { onStarted: () => {} },
      admittedSessionSettings: { permissionMode: "full" },
      operatorAuthority: { assertCurrent: () => {} },
      replyOperation: { sessionId: "copied-session" },
      [REPLY_ADMISSION_TICKET]: { copied: true },
      [REPLY_OPERATION_RUN_STATE]: { copied: true },
      [PLUGIN_COMMAND_DISPATCH]: { kind: "non-plugin" as const },
    };
    let dispatched = false;
    await dispatchInboundMessage({
      ctx: { Body: "hello", SessionKey: "agent:main:sdk-reply" },
      cfg: {},
      dispatcher: createReplyDispatcher({ deliver: async () => {} }),
      replyOptions: options,
      dispatchReplyFromConfig: async ({ replyOptions }) => {
        dispatched = true;
        expect(replyOptions).toEqual({
          onReplyStart,
          onAgentRunStart: expect.any(Function),
          typingPolicy: "system_event",
          [PLUGIN_COMMAND_DISPATCH]: { kind: "non-plugin" },
        });
        return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
      },
    });
    expect(dispatched).toBe(true);
    expect(options.scheduledAutomation.job.id).toBe("copied-job");
    expect(options.typingPolicy).toBe("system_event");
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

  it("publishes an empty receipt when no delivery was admitted", async () => {
    const dispatcher = createReplyDispatcher({ deliver: async () => {} });
    dispatcher.markComplete();
    await expect(dispatcher.waitForIdle()).resolves.toMatchObject({
      anyVisibleDelivered: false,
      counts: {
        tool: { delivered: 0 },
        block: { delivered: 0 },
        final: { delivered: 0 },
      },
    });
  });
});
