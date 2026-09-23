import { assert, beforeEach, describe, expect, it, vi } from "vitest";
import type { runWithModelFallback } from "../../agents/model-fallback-runner.js";
import type { ReplyPayload } from "../types.js";
import {
  createMinimalRunAgentTurnParams,
  getExecuteAgentTurnForTest,
  setupAgentRunnerExecutionTestState,
  initialFallbackAttemptOptions,
  type EmbeddedAgentParams,
  type FallbackRunnerParams,
} from "./agent-runner-execution.test-support.js";
import { createBlockReplySource, setBlockReplyDelivery } from "./block-reply-delivery.js";
import type { ReplyDispatchDeliveryOutcome } from "./reply-dispatch-outcome.types.js";

const state = await setupAgentRunnerExecutionTestState();
const delivery = await vi.importActual<typeof import("./reply-delivery.js")>("./reply-delivery.js");
type DeliveryFallbackParams = FallbackRunnerParams &
  Pick<Parameters<typeof runWithModelFallback>[0], "canFallbackAfterError">;

beforeEach(() => {
  state.createBlockReplyDeliveryHandlerMock.mockImplementation(
    delivery.createBlockReplyDeliveryHandler,
  );
});

describe("direct delivery execution evidence", () => {
  it.each(["cycle", "bigint"])(
    "keeps a successful direct send when opaque channelData contains %s",
    async (kind) => {
      const channelData: Record<string, unknown> = {};
      channelData.value = kind === "cycle" ? channelData : 1n;
      const payload: ReplyPayload = { text: "Delivered answer", channelData };
      const onBlockReply = vi.fn<(payload: ReplyPayload) => Promise<void>>(async () => {});
      let blockError: unknown;
      state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
        try {
          await params.onBlockReply?.(payload);
        } catch (error) {
          blockError = error;
          throw error;
        }
        return { payloads: [], meta: {} };
      });

      const execute = await getExecuteAgentTurnForTest();
      const result = await execute({
        ...createMinimalRunAgentTurnParams({ opts: { onBlockReply } }),
        blockStreamingEnabled: true,
      });

      expect(onBlockReply).toHaveBeenCalledTimes(1);
      expect(onBlockReply.mock.calls[0]?.[0]).toMatchObject({ text: payload.text, channelData });
      expect(blockError).toBeUndefined();
      assert(result.kind === "success");
      expect(result.runResult.payloads).toEqual([]);
    },
  );

  it.each([false, true])(
    "keeps settlement completeness=%s when the source later changes during execution",
    async (completeAtSettlement) => {
      const source = createBlockReplySource();
      let fallbackAllowed: boolean | undefined;
      source.setComplete(completeAtSettlement);
      const onBlockReply = vi.fn(async (payload: ReplyPayload) => {
        await source.run(async () => {
          setBlockReplyDelivery(Promise.resolve({ outcome: "delivered" }), payload);
        });
      });
      state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
        await params.onBlockReply?.({ text: "Answer" });
        source.setComplete(!completeAtSettlement);
        return { payloads: [], meta: {} };
      });
      state.runWithModelFallbackMock.mockImplementationOnce(
        async (params: DeliveryFallbackParams) => {
          const result = await params.run(
            "anthropic",
            "claude",
            initialFallbackAttemptOptions(params),
          );
          assert(params.canFallbackAfterError);
          fallbackAllowed = await params.canFallbackAfterError({
            provider: "anthropic",
            model: "claude",
            error: new Error("later failure"),
            attempt: 1,
            total: 2,
          });
          return { result, provider: "anthropic", model: "claude", attempts: [] };
        },
      );

      const execute = await getExecuteAgentTurnForTest();
      const result = await execute({
        ...createMinimalRunAgentTurnParams({ opts: { onBlockReply } }),
        blockStreamingEnabled: true,
      });
      assert(result.kind === "success");
      expect(onBlockReply).toHaveBeenCalledTimes(1);
      expect(source.complete).toBe(!completeAtSettlement);
      expect(fallbackAllowed).toBe(!completeAtSettlement);
      expect(result.hasDirectlySentBlockReply).toBe(completeAtSettlement || undefined);
    },
  );

  it.each(["after-success", "transport-rejection", "transport-serialization"])(
    "uses real direct receipts for thrown runtime fallback: %s",
    async (failure) => {
      const opaque: Record<string, unknown> = {};
      opaque.self = opaque;
      const payload: ReplyPayload = { text: "Answer", channelData: opaque };
      const delivered: string[] = [];
      let fallbackAllowed: boolean | undefined;
      let caughtError: unknown;
      const onBlockReply = vi.fn(async (reply: ReplyPayload) => {
        if (failure === "transport-serialization") {
          JSON.stringify(reply.channelData);
        }
        if (failure === "transport-rejection") {
          throw new Error("transport rejected");
        }
        delivered.push(reply.text ?? "");
      });
      state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
        await params.onBlockReply?.(payload);
        throw new Error("runtime failed after delivery");
      });
      state.runWithModelFallbackMock.mockImplementationOnce(
        async (params: DeliveryFallbackParams) => {
          try {
            await params.run("anthropic", "claude", initialFallbackAttemptOptions(params));
            assert.fail("expected the runtime or transport to reject");
          } catch (error) {
            caughtError = error;
            assert(params.canFallbackAfterError);
            fallbackAllowed = await params.canFallbackAfterError({
              provider: "anthropic",
              model: "claude",
              error,
              attempt: 1,
              total: 2,
            });
            throw error;
          }
        },
      );

      const execute = await getExecuteAgentTurnForTest();
      await execute({
        ...createMinimalRunAgentTurnParams({ opts: { onBlockReply } }),
        blockStreamingEnabled: true,
      });
      expect(onBlockReply).toHaveBeenCalledTimes(1);
      expect(delivered).toEqual(failure === "after-success" ? ["Answer"] : []);
      // Unclassified transport errors retain ambiguous-send custody, even without success.
      expect(fallbackAllowed).toBe(false);
      if (failure === "transport-serialization") {
        expect(caughtError).toBeInstanceOf(TypeError);
      } else {
        expect(caughtError).toMatchObject({
          message:
            failure === "transport-rejection"
              ? "transport rejected"
              : "runtime failed after delivery",
        });
      }
    },
  );

  it.each([
    { outcome: "delivered", pending: false, confirmed: true, retry: false },
    { outcome: "delivered", pending: true, confirmed: false, retry: false },
    { outcome: "cancelled", pending: false, confirmed: false, retry: true },
    { outcome: "failed-before-deliver", pending: false, confirmed: false, retry: true },
    { outcome: "delivered-not-visible", pending: false, confirmed: false, retry: true },
    { outcome: "recovery-owned", pending: false, confirmed: false, retry: false },
  ] satisfies Array<{
    outcome: ReplyDispatchDeliveryOutcome;
    pending: boolean;
    confirmed: boolean;
    retry: boolean;
  }>)(
    "preserves receipt custody for $outcome (pending=$pending)",
    async ({ outcome, pending, confirmed, retry }) => {
      let fallbackAllowed: boolean | undefined;
      const onBlockReply = vi.fn(async (payload: ReplyPayload) => {
        setBlockReplyDelivery(Promise.resolve({ outcome, pending }), payload);
      });
      state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
        await params.onBlockReply?.({ text: "Answer" });
        return { payloads: [{ text: "Final" }], meta: {} };
      });
      state.runWithModelFallbackMock.mockImplementationOnce(
        async (params: DeliveryFallbackParams) => {
          const result = await params.run(
            "anthropic",
            "claude",
            initialFallbackAttemptOptions(params),
          );
          assert(params.canFallbackAfterError);
          fallbackAllowed = await params.canFallbackAfterError({
            provider: "anthropic",
            model: "claude",
            error: new Error("later error"),
            attempt: 1,
            total: 2,
          });
          return { result, provider: "anthropic", model: "claude", attempts: [] };
        },
      );
      const execute = await getExecuteAgentTurnForTest();
      const result = await execute({
        ...createMinimalRunAgentTurnParams({ opts: { onBlockReply } }),
        blockStreamingEnabled: true,
      });
      assert(result.kind === "success");
      expect(onBlockReply).toHaveBeenCalledTimes(1);
      expect(result.hasDirectlySentBlockReply).toBe(confirmed || undefined);
      expect(fallbackAllowed).toBe(retry);
    },
  );
});
