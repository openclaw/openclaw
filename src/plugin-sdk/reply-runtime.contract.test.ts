import type { PluginHookReplyDispatchEvent } from "openclaw/plugin-sdk/core";
import { expect, expectTypeOf, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { PLUGIN_COMMAND_DISPATCH } from "../plugins/plugin-command-dispatch-contract.js";
import type { PluginRuntimeChannel } from "../plugins/runtime/types-channel.js";
import type * as ReplyChunking from "./reply-chunking.js";
import type * as ReplyRuntime from "./reply-runtime.js";
import {
  createReplyDispatcher,
  dispatchInboundMessage,
  isSilentReplyText,
  type GetReplyOptions as Options,
  type PreparedAgentRunStart,
} from "./reply-runtime.js";

type ProgressResult = boolean | void;
type ProgressReturn = Promise<ProgressResult> | ProgressResult;
type AsyncVisibility = (() => Promise<boolean>) | undefined;
type PublicReplyKey =
  | "internalEventExecution"
  | "onReplyOperationAdmitted"
  | "onReplyOperationOwned";
type Present<T> = Exclude<T, undefined>;
type ProgressCallback = Options[
  | "onToolResult"
  | "onToolStart"
  | "onItemEvent"
  | "onPlanUpdate"
  | "onApprovalEvent"
  | "onCommandOutput"
  | "onPatchSummary"];
type ProgressBoundaryCallback = Options[
  | "onReasoningEnd"
  | "onAssistantMessageStart"
  | "onBlockReplyQueued"
  | "onCompactionStart"
  | "onCompactionEnd"];

it("exposes only the exact helper from reply-runtime", () => {
  type ChunkingExports = keyof typeof ReplyChunking;
  type RuntimeExports = keyof typeof ReplyRuntime;
  expectTypeOf<"SILENT_REPLY_TOKEN">().not.toExtend<ChunkingExports>();
  expectTypeOf<"SILENT_REPLY_TOKEN">().toExtend<RuntimeExports>();
  expectTypeOf<"isSilentReplyText">().not.toExtend<ChunkingExports>();
  expectTypeOf<"isSilentReplyPayloadText">().not.toExtend<ChunkingExports>();
  expectTypeOf<"isSilentReplyPayloadText">().not.toExtend<RuntimeExports>();
  expectTypeOf(isSilentReplyText).parameters.toEqualTypeOf<[text?: string]>();
});
it("retains released lifecycle callback arguments and synchronous completion acknowledgment", () => {
  type Deferral = Present<Present<Options["turnAdoptionLifecycle"]>["onDeferred"]>;
  expectTypeOf<Parameters<Deferral>>().toEqualTypeOf<[]>();
  expectTypeOf<ReturnType<Deferral>>().toEqualTypeOf<boolean | void>();
  type AgentRunStart = NonNullable<Options["onAgentRunStart"]>;
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

it("requires prepared transcript facts on the modern run-start contract", () => {
  type Callback = NonNullable<Options["onPreparedAgentRunStart"]>;
  expectTypeOf<Parameters<Callback>>().toEqualTypeOf<[PreparedAgentRunStart]>();
  expectTypeOf<{ runId: string }>().not.toExtend<PreparedAgentRunStart>();
  expectTypeOf<Callback>().returns.toEqualTypeOf<unknown>();
});

it("retains released synchronous visibility contracts beside awaited companions", () => {
  expectTypeOf<Options["onVerboseProgressVisibility"]>().toEqualTypeOf<
    ((isActive: () => boolean) => void) | undefined
  >();
  expectTypeOf<Options["onVerboseProgressVisibilityAsync"]>().toEqualTypeOf<
    ((isActive: () => Promise<boolean>) => Promise<void> | void) | undefined
  >();
  type Event = PluginHookReplyDispatchEvent;
  expectTypeOf<Event["shouldSendToolSummaries"]>().toEqualTypeOf<boolean>();
  expectTypeOf<Event["shouldSendFullToolDetails"]>().toEqualTypeOf<boolean>();
  expectTypeOf<Event["shouldSendToolSummariesAsync"]>().toEqualTypeOf<AsyncVisibility>();
  expectTypeOf<Event["shouldSendFullToolDetailsAsync"]>().toEqualTypeOf<AsyncVisibility>();
  expectTypeOf<
    Omit<Event, "shouldSendToolSummariesAsync" | "shouldSendFullToolDetailsAsync">
  >().toExtend<Event>();
});
it("still accepts the deprecated suppressToolErrorWarnings option as a no-op", () => {
  // Removal window: first stable release after 2026.10 (see GetReplyOptions).
  expectTypeOf<Options["suppressToolErrorWarnings"]>().toEqualTypeOf<boolean | undefined>();
});

it("exports acceptance-aware progress callback results", () => {
  expectTypeOf<Present<ProgressCallback>>().returns.toEqualTypeOf<ProgressReturn>();
  expectTypeOf<Present<Options["onPartialReply"]>>().returns.toEqualTypeOf<ProgressReturn>();
  expectTypeOf<Present<Options["onReasoningStream"]>>().returns.toEqualTypeOf<ProgressReturn>();
  expectTypeOf<Present<ProgressBoundaryCallback>>().returns.toEqualTypeOf<ProgressReturn>();
});

it("exports the snapshotted commentary delivery gate", () => {
  expectTypeOf<Options["commentaryPayloadsEnabled"]>().toEqualTypeOf<boolean | undefined>();
  expectTypeOf<
    Present<Options["shouldDeliverCommentaryPayloads"]>
  >().returns.toEqualTypeOf<boolean>();
});
it("keeps internal event authority out of the public reply option types", () => {
  type DispatchOptions = NonNullable<Parameters<typeof dispatchInboundMessage>[0]["replyOptions"]>;
  type RuntimeOptions = NonNullable<
    Parameters<PluginRuntimeChannel["reply"]["dispatchReplyFromConfig"]>[0]["replyOptions"]
  >;
  type Resolver = NonNullable<Parameters<typeof dispatchInboundMessage>[0]["replyResolver"]>;
  type ResolverOptions = NonNullable<Parameters<Resolver>[1]>;
  expectTypeOf<Extract<keyof DispatchOptions, PublicReplyKey>>().toEqualTypeOf<never>();
  expectTypeOf<Extract<keyof RuntimeOptions, PublicReplyKey>>().toEqualTypeOf<never>();
  expectTypeOf<Extract<keyof ResolverOptions, PublicReplyKey>>().toEqualTypeOf<never>();
  expectTypeOf<"onSessionPrepared">().toExtend<keyof DispatchOptions>();
  expectTypeOf<"onSessionPrepared">().toExtend<keyof ResolverOptions>();
});

it("rejects plugin-supplied event custody while retaining public reply options", async () => {
  const callback = vi.fn();
  const options = {
    isHeartbeat: true,
    onReplyStart: callback,
    internalEventExecution: { assertCurrent: callback, onStarted: callback },
    onReplyOperationAdmitted: callback,
    onReplyOperationOwned: callback,
    [PLUGIN_COMMAND_DISPATCH]: { kind: "non-plugin" as const },
  };
  const delivered: string[] = [];
  const dispatcher = createReplyDispatcher({
    deliver: async (payload) => {
      delivered.push(payload.text ?? "");
    },
  });
  await dispatchInboundMessage({
    ctx: { Body: "hello", SessionKey: "agent:main:sdk-reply", CommandAuthorized: false },
    cfg: {},
    dispatcher,
    replyOptions: options,
    dispatchReplyFromConfig: async ({ replyOptions }) => {
      expect(replyOptions).not.toHaveProperty("internalEventExecution");
      expect(replyOptions).not.toHaveProperty("onReplyOperationAdmitted");
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
  expect(delivered).toEqual(["public reply"]);
  expect(options.internalEventExecution.onStarted).toBe(callback);
  expect(options.onReplyOperationAdmitted).toBe(callback);
  expect(options.onReplyOperationOwned).toBe(callback);
});

it("preserves deprecated admission counters beside settled receipt outcomes", async () => {
  const firstDelivery = createDeferred();
  const dispatcher = createReplyDispatcher({
    beforeDeliver: async (payload) => (payload.text === "cancel" ? null : payload),
    deliver: async (payload) => {
      if (payload.text === "delivered") {
        await firstDelivery.promise;
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

  firstDelivery.resolve();
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
