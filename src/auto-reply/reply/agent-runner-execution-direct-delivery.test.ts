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

async function executeWithBlockReply(onBlockReply: (payload: ReplyPayload) => Promise<void>) {
  const execute = await getExecuteAgentTurnForTest();
  return execute({
    ...createMinimalRunAgentTurnParams({ opts: { onBlockReply } }),
    blockStreamingEnabled: true,
  });
}

function observeFallbackDecision() {
  const decision: { allowed?: boolean } = {};
  state.runWithModelFallbackMock.mockImplementationOnce(async (params: DeliveryFallbackParams) => {
    const result = await params.run("anthropic", "claude", initialFallbackAttemptOptions(params));
    assert(params.canFallbackAfterError);
    decision.allowed = await params.canFallbackAfterError({
      provider: "anthropic",
      model: "claude",
      error: new Error("later failure"),
      attempt: 1,
      total: 2,
    });
    return { result, provider: "anthropic", model: "claude", attempts: [] };
  });
  return decision;
}

describe("direct delivery execution evidence", () => {
  it.each([false, true])(
    "keeps settlement completeness=%s when the source later changes during execution",
    async (completeAtSettlement) => {
      const source = createBlockReplySource();
      const fallback = observeFallbackDecision();
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
      const result = await executeWithBlockReply(onBlockReply);
      assert(result.kind === "success");
      expect(onBlockReply).toHaveBeenCalledTimes(1);
      expect(source.complete).toBe(!completeAtSettlement);
      expect(fallback.allowed).toBe(!completeAtSettlement);
      expect(result.hasDirectlySentBlockReply).toBe(completeAtSettlement || undefined);
    },
  );

  it.each(["after-success", "transport-serialization"])(
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

      await executeWithBlockReply(onBlockReply);
      expect(onBlockReply).toHaveBeenCalledTimes(1);
      expect(delivered).toEqual(failure === "after-success" ? ["Answer"] : []);
      // Unclassified transport errors retain ambiguous-send custody, even without success.
      expect(fallbackAllowed).toBe(false);
      if (failure === "transport-serialization") {
        expect(caughtError).toBeInstanceOf(TypeError);
      } else {
        expect(caughtError).toMatchObject({
          message: "runtime failed after delivery",
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
      const fallback = observeFallbackDecision();
      const onBlockReply = vi.fn(async (payload: ReplyPayload) => {
        setBlockReplyDelivery(Promise.resolve({ outcome, pending }), payload);
      });
      state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
        await params.onBlockReply?.({ text: "Answer" });
        return { payloads: [{ text: "Final" }], meta: {} };
      });
      const result = await executeWithBlockReply(onBlockReply);
      assert(result.kind === "success");
      expect(onBlockReply).toHaveBeenCalledTimes(1);
      expect(result.hasDirectlySentBlockReply).toBe(confirmed || undefined);
      expect(fallback.allowed).toBe(retry);
    },
  );
});
