import { expect, it, vi } from "vitest";
import { createReplyDispatcherWithTyping } from "../auto-reply/reply/reply-dispatcher.js";
import { buildTestCtx } from "../auto-reply/reply/test-ctx.js";
import { createHookRunner } from "../plugins/hooks.js";
import { createTestPluginRegistry } from "../plugins/registry-runtime.test-helpers.js";
import {
  readReplyDispatchTyping,
  withReplyDispatchTyping,
} from "../plugins/reply-dispatch-typing.js";
import { createPluginRecord } from "../plugins/status.test-fixtures.js";
import { tryDispatchAcpReplyHook } from "./acp-runtime.js";

const dispatchMock = vi.hoisted(() => vi.fn());
vi.mock("../auto-reply/reply/dispatch-acp.runtime.js", () => ({
  shouldBypassAcpDispatchForCommand: async () => false,
  tryDispatchAcpReply: dispatchMock,
}));

it("retains the internal typing operation through the plugin hook runner", async () => {
  const start = vi.fn();
  const lifecycle = createReplyDispatcherWithTyping({
    deliver: async () => undefined,
    typingStartPolicy: "visible_delivery",
    onReplyStart: start,
  });
  dispatchMock.mockImplementationOnce(async (params) => {
    expect(start).not.toHaveBeenCalled();
    await params.onVisibleDeliveryStart?.();
    return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
  });
  const builder = createTestPluginRegistry();
  const api = builder.createApi(createPluginRecord({ id: "acp", origin: "bundled" }), {
    config: {},
  });
  api.on("reply_dispatch", tryDispatchAcpReplyHook);
  const runner = createHookRunner(builder.registry);
  await runner.runReplyDispatch(
    {
      ctx: buildTestCtx({ SessionKey: "agent:main:whatsapp:group:typing" }),
      sessionKey: "agent:main:whatsapp:group:typing",
      inboundAudio: false,
      shouldRouteToOriginating: false,
      shouldSendToolSummaries: false,
      shouldSendFullToolDetails: false,
      shouldSendToolSummariesAsync: async () => false,
      shouldSendFullToolDetailsAsync: async () => false,
      sendPolicy: "allow",
    },
    withReplyDispatchTyping(
      {
        cfg: {},
        dispatcher: lifecycle.dispatcher,
        recordProcessed: () => {},
        markIdle: () => {},
      },
      readReplyDispatchTyping(lifecycle.replyOptions),
    ),
  );
  expect(start).toHaveBeenCalledOnce();
  lifecycle.dispatcher.markComplete();
  await lifecycle.dispatcher.waitForIdle();
});
