import { assert, beforeEach, expect, it, vi } from "vitest";
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
const executeAgentTurn = await getExecuteAgentTurnForTest();
const delivery = await vi.importActual<typeof import("./reply-delivery.js")>("./reply-delivery.js");
type DeliveryFallbackParams = FallbackRunnerParams &
  Pick<Parameters<typeof runWithModelFallback>[0], "canFallbackAfterError">;

beforeEach(() => {
  state.createBlockReplyDeliveryHandlerMock.mockImplementation(
    delivery.createBlockReplyDeliveryHandler,
  );
});

async function executeWithBlockReply(
  onBlockReply: (payload: ReplyPayload) => Promise<void>,
  options: { payload?: ReplyPayload; afterReply?: () => void; final?: ReplyPayload[] } = {},
) {
  const decision: { allowed?: boolean; error?: unknown } = {};
  state.runWithModelFallbackMock.mockImplementationOnce(async (params: DeliveryFallbackParams) => {
    let failure: unknown = new Error("later failure");
    try {
      const result = await params.run("anthropic", "claude", initialFallbackAttemptOptions(params));
      return { result, provider: "anthropic", model: "claude", attempts: [] };
    } catch (error) {
      decision.error = failure = error;
      throw error;
    } finally {
      assert(params.canFallbackAfterError);
      decision.allowed = await params.canFallbackAfterError({
        provider: "anthropic",
        model: "claude",
        error: failure,
        attempt: 1,
        total: 2,
      });
    }
  });
  state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
    await params.onBlockReply?.(options.payload ?? { text: "Answer" });
    options.afterReply?.();
    return { payloads: options.final ?? [], meta: {} };
  });
  const result = await executeAgentTurn({
    ...createMinimalRunAgentTurnParams({ opts: { onBlockReply } }),
    blockStreamingEnabled: true,
  });
  return { result, fallback: decision };
}

it.each([false, true])(
  "keeps settlement completeness=%s when the source later changes during execution",
  async (completeAtSettlement) => {
    const source = createBlockReplySource();
    source.setComplete(completeAtSettlement);
    const onBlockReply = vi.fn(async (payload: ReplyPayload) => {
      await source.run(async () => {
        setBlockReplyDelivery(Promise.resolve({ outcome: "delivered" }), payload);
      });
    });
    const { result, fallback } = await executeWithBlockReply(onBlockReply, {
      afterReply: () => source.setComplete(!completeAtSettlement),
    });
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
    const onBlockReply = vi.fn(async (reply: ReplyPayload) => {
      if (failure === "transport-serialization") {
        JSON.stringify(reply.channelData);
      }
      delivered.push(reply.text ?? "");
    });
    const { fallback } = await executeWithBlockReply(onBlockReply, {
      payload,
      afterReply: () => {
        throw new Error("runtime failed after delivery");
      },
    });
    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(delivered).toEqual(failure === "after-success" ? ["Answer"] : []);
    // Unclassified transport errors retain ambiguous-send custody, even without success.
    expect(fallback).toMatchObject({
      allowed: false,
      error:
        failure === "transport-serialization"
          ? expect.any(TypeError)
          : { message: "runtime failed after delivery" },
    });
  },
);

it.each<[ReplyDispatchDeliveryOutcome, boolean, boolean, boolean]>([
  ["delivered", false, true, false],
  ["delivered", true, false, false],
  ["cancelled", false, false, true],
  ["failed-before-deliver", false, false, true],
  ["delivered-not-visible", false, false, true],
  ["recovery-owned", false, false, false],
])("preserves receipt custody for %s (pending=%s)", async (outcome, pending, confirmed, retry) => {
  const onBlockReply = vi.fn(async (payload: ReplyPayload) => {
    setBlockReplyDelivery(Promise.resolve({ outcome, pending }), payload);
  });
  const { result, fallback } = await executeWithBlockReply(onBlockReply, {
    final: [{ text: "Final" }],
  });
  assert(result.kind === "success");
  expect(onBlockReply).toHaveBeenCalledTimes(1);
  expect(result.hasDirectlySentBlockReply).toBe(confirmed || undefined);
  expect(fallback.allowed).toBe(retry);
});
