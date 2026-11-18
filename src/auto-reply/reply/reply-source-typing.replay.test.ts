import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { dispatchInboundMessageWithBufferedDispatcher } from "../dispatch.js";
import { dispatchLowLevelChannelReplyFromConfig } from "./dispatch-from-config.js";
import { createGroupReplyFixture } from "./group-participation.reply.test-support.js";
import { buildTestCtx } from "./test-ctx.js";

let fixture: Awaited<ReturnType<typeof createGroupReplyFixture>>;
beforeAll(async () => {
  fixture = await createGroupReplyFixture();
});
afterAll(async () => {
  await fixture.close();
});

it("keeps buffered ingress retryable when its caller supplied no adoption lifecycle", async () => {
  const failure = new Error("failed before source adoption");
  type Resolver = NonNullable<
    Parameters<typeof dispatchInboundMessageWithBufferedDispatcher>[0]["replyResolver"]
  >;
  const replyResolver = vi.fn<Resolver>(async (_ctx, options) => {
    await options?.turnAdoptionLifecycle?.onAdopted();
    throw failure;
  });
  const dispatch = () =>
    dispatchInboundMessageWithBufferedDispatcher({
      ctx: buildTestCtx({
        Provider: "telegram",
        Surface: "telegram",
        OriginatingChannel: "telegram",
        OriginatingTo: "-10123",
        From: "telegram:group:-10123",
        To: "telegram:-10123",
        ChatType: "group",
        SessionKey: "agent:main:telegram:group:-10123",
        MessageSid: "buffered-unadopted-retry",
        BodyForAgent: "Bob, which port?",
      }),
      cfg: fixture.config,
      replyResolver,
      dispatcherOptions: { deliver: async () => {} },
      dispatchReplyFromConfig: dispatchLowLevelChannelReplyFromConfig,
    });
  await expect(dispatch()).rejects.toBe(failure);
  replyResolver.mockResolvedValueOnce({ text: "Retry succeeded." });
  await dispatch();
  expect(replyResolver).toHaveBeenCalledTimes(2);
});
