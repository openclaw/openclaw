import { beforeAll, beforeEach, expect, it } from "vitest";
import { clearAgentHarnesses } from "../../agents/harness/registry.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import {
  emptyConfig,
  hookMocks,
  mocks,
  resetPluginTtsAndThreadMocks,
  setDiscordTestRegistry,
} from "./dispatch-from-config.shared.test-harness.js";
import { resetInboundDedupe } from "./inbound-dedupe.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";
import { buildTestCtx } from "./test-ctx.js";

let dispatchReplyFromConfig: typeof import("./dispatch-from-config.js").dispatchReplyFromConfig;
beforeAll(async () => {
  ({ dispatchReplyFromConfig } = await import("./dispatch-from-config.js"));
});
beforeEach(() => {
  clearAgentHarnesses();
  resetInboundDedupe();
  resetPluginTtsAndThreadMocks();
  setDiscordTestRegistry();
  hookMocks.runner.hasHooks.mockReset().mockReturnValue(false);
  mocks.tryFastAbortFromMessage.mockReset().mockResolvedValue({ handled: false, aborted: false });
});

async function dispatch(
  body: string,
  sessionKey: string,
  replyResolver: Parameters<typeof dispatchReplyFromConfig>[0]["replyResolver"],
  replyOptions?: GetReplyOptions,
) {
  const delivered: ReplyPayload[] = [];
  const dispatcher = createReplyDispatcher({
    deliver: async (payload) => {
      delivered.push(payload);
    },
  });
  const result = await dispatchReplyFromConfig({
    ctx: buildTestCtx({
      Body: body,
      BodyForAgent: body,
      From: "user1",
      Surface: "telegram",
      SessionKey: sessionKey,
    }),
    cfg: emptyConfig,
    dispatcher,
    replyResolver,
    replyOptions,
  });
  dispatcher.markComplete();
  await dispatcher.waitForIdle();
  return { result, delivered };
}

it("sanitizes reasoning snapshots without changing source payloads or presentation metadata", async () => {
  const internal =
    "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nprivate metadata\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>";
  const visible: Array<Parameters<NonNullable<GetReplyOptions["onReasoningStream"]>>[0]> = [
    {
      text: "Checking files.",
      isReasoning: true,
      isReasoningSnapshot: true,
      requiresReasoningProgressOptIn: true,
    },
    { text: "Reading config.\n\nChecking files.", isReasoningSnapshot: true },
    { text: "", mediaUrls: ["https://example.com/reasoning.png"] },
  ];
  const source = [
    { text: internal },
    ...visible.map((payload) => ({
      ...payload,
      text: payload.text ? `${internal}\n\n${payload.text}` : internal,
    })),
  ];
  const original = structuredClone(source);
  const observed: typeof visible = [];
  await dispatch(
    "Show status.",
    "agent:test:reasoning-scaffolding",
    async (_ctx, options) => {
      for (const payload of source) {
        await options?.onReasoningStream?.(payload);
      }
      return { text: "Visible answer." };
    },
    {
      onReasoningStream: (payload) => {
        observed.push(payload);
        return false;
      },
    },
  );
  expect(source).toEqual(original);
  expect(observed).toEqual(visible);
});

it("binds the finalized inbound prompt before raw final replies reach the dispatcher", async () => {
  const conversationContext = [
    "[Chat messages since your last reply - for context]",
    "[Telegram] Alice: private history",
    "",
    "[Current message - respond to this]",
    '<function_calls><invoke name="exec">private XML</invoke></function_calls>',
    "private inbound paragraph",
  ].join("\n");
  const { result, delivered } = await dispatch(
    conversationContext,
    "agent:test:scaffolding-provenance",
    async () => ({ text: `${conversationContext}\n\nVisible answer.` }),
  );
  expect(result.queuedFinal).toBe(true);
  expect(delivered).toEqual([expect.objectContaining({ text: "Visible answer." })]);
});
