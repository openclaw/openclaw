import { expect, it, vi } from "vitest";
import type { InternalDeliverOutboundPayloadsParams } from "../../infra/outbound/deliver-contracts.js";
import {
  sendDurableMessageBatch,
  withDurableMessageSendContext,
} from "../../plugin-sdk/channel-outbound.js";
import { sendDurableMessageBatchCore } from "./send.js";

const deliver = vi.hoisted(() =>
  vi.fn<(input: InternalDeliverOutboundPayloadsParams) => Promise<[]>>(async () => []),
);
// mock-isolation: Isolate the private delivery handoff; queue integration tests exercise the real runtime.
vi.mock("../../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloadsInternal: deliver,
  deliverStructuredOutboundPayloadsInternal: deliver,
}));

it.each(["batch", "context", "private-core"] as const)(
  "only explicit private arguments supply history custody through %s",
  async (entrypoint) => {
    deliver.mockClear();
    const generation = {
      agentId: "secondary",
      storePath: "/synthetic/agent.sqlite",
      sessionKey: "agent:secondary:dashboard:notice",
      sessionId: "notice-session",
      lifecycleRevision: null,
    };
    const injected = {
      cfg: {},
      channel: "reef",
      to: "reef:recipient",
      payloads: [{ text: "accepted notice" }],
      transcriptGeneration: generation,
      sessionGeneration: generation,
      session: { agentId: generation.agentId, policyKey: generation.sessionKey },
      transcriptProvenance: { kind: "recovery-notice" as const, noticeId: "notice" },
    };
    if (entrypoint === "batch") {
      await sendDurableMessageBatch(injected);
    } else if (entrypoint === "context") {
      await withDurableMessageSendContext(injected, async (ctx) => ctx.send(await ctx.render()));
    } else {
      await sendDurableMessageBatchCore(injected, undefined, undefined, generation);
    }
    expect(deliver).toHaveBeenCalledOnce();
    expect(deliver.mock.calls[0]?.[0].transcriptGeneration).toBeUndefined();
    expect(deliver.mock.calls[0]?.[0].sessionGeneration).toEqual(
      entrypoint === "private-core" ? generation : undefined,
    );
  },
);
