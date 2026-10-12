import { expect, it, vi, type Mock } from "vitest";
import type { EmbeddedAgentRunResult } from "../../agents/embedded-agent-runner/types.js";
import type { ReplyPayload } from "../types.js";
import type { InternalGetReplyOptions } from "./get-reply.types.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";

type AgentRunParams = {
  onBlockReply?: (payload: ReplyPayload) => Promise<void> | void;
};

type ReasoningFallbackFixture = {
  runEmbeddedAgentMock: Mock<(params: AgentRunParams) => Promise<EmbeddedAgentRunResult>>;
  createMinimalRun: (params: { blockStreamingEnabled: boolean; opts: InternalGetReplyOptions }) => {
    run: () => Promise<ReplyPayload | ReplyPayload[] | undefined>;
  };
};

// Register inside the runner suite so its hoisted mocks and operation resets own these cases.
export function registerReasoningFallbackTests({
  runEmbeddedAgentMock,
  createMinimalRun,
}: ReasoningFallbackFixture) {
  it.each([
    { delivery: "direct", blockStreamingEnabled: false, reasoning: "enabled", enabled: true },
    { delivery: "pipeline", blockStreamingEnabled: true, reasoning: "enabled", enabled: true },
    {
      delivery: "direct",
      blockStreamingEnabled: false,
      reasoning: "default-off",
      enabled: undefined,
    },
    {
      delivery: "pipeline",
      blockStreamingEnabled: true,
      reasoning: "default-off",
      enabled: undefined,
    },
  ])(
    "keeps $reasoning reasoning separate from the final fallback through prepared $delivery delivery",
    async ({ blockStreamingEnabled, enabled }) => {
      const reasoning = { text: "Thinking\n\n_Checking the result._", isReasoning: true };
      const delivered = vi.fn(async (_payload: ReplyPayload) => {});
      const onBlockReply = vi.fn();
      const dispatcher = createReplyDispatcher({
        deliver: delivered,
        deliverPrepared: async (plan) => delivered(plan.payload),
      });
      runEmbeddedAgentMock.mockImplementationOnce(async (params: AgentRunParams) => {
        await params.onBlockReply?.(reasoning);
        return { payloads: [], meta: { durationMs: 0 } };
      });
      const { run } = createMinimalRun({
        blockStreamingEnabled,
        opts: {
          onBlockReply,
          onPreparedBlockReply: async (plan) => {
            dispatcher.sendPreparedReply("block", plan);
            await dispatcher.waitForIdle();
          },
          ...(enabled ? { reasoningPayloadsEnabled: true } : {}),
        },
      });

      try {
        const result = await run();
        await dispatcher.waitForIdle();
        const payloads = Array.isArray(result) ? result : [result];

        expect(onBlockReply).not.toHaveBeenCalled();
        if (enabled) {
          expect(delivered).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(reasoning));
        } else {
          expect(delivered).not.toHaveBeenCalled();
        }
        expect(payloads).toContainEqual(
          expect.objectContaining({
            text: expect.stringContaining("did not produce a visible reply"),
            isError: true,
          }),
        );
      } finally {
        dispatcher.markComplete();
        await dispatcher.waitForIdle();
      }
    },
  );
}
