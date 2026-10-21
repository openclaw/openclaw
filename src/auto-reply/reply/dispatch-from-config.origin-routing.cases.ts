import { expect, it } from "vitest";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import type { ReplyPayload } from "../types.js";
import {
  createDispatcher,
  emptyConfig,
  hookMocks,
  mocks,
  replyMediaPathMocks,
  sessionStoreMocks,
} from "./dispatch-from-config.shared.test-harness.js";
import {
  dispatchReplyFromConfig,
  firstMockCall,
  firstRouteReplyCall,
  installThreadingTestPlugin,
  setNoAbort,
} from "./dispatch-from-config.test-support.js";
import { buildTestCtx } from "./test-ctx.js";

export function registerOriginRoutingCases() {
  it("routes when OriginatingChannel differs from Provider", async () => {
    setNoAbort();
    mocks.routeReply.mockClear();
    installThreadingTestPlugin({ id: "telegram" });
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "slack",
      AccountId: "acc-1",
      MessageThreadId: 123,
      GroupChannel: "ops-room",
      OriginatingChannel: "telegram",
      OriginatingTo: "telegram:999",
    });

    const replyResolver = async () => ({ text: "hi" }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    const routeCall = firstRouteReplyCall();
    expect(routeCall?.channel).toBe("telegram");
    expect(routeCall?.to).toBe("telegram:999");
    expect(routeCall?.accountId).toBe("acc-1");
    expect(routeCall?.threadId).toBe(123);
    expect(routeCall?.isGroup).toBe(true);
    expect(routeCall?.groupId).toBe("telegram:999");
  });

  it("routes exec-event replies using persisted session delivery context when current turn has no originating route", async () => {
    setNoAbort();
    mocks.routeReply.mockClear();
    installThreadingTestPlugin({ id: "telegram" });
    sessionStoreMocks.currentEntry = {
      delivery: normalizeSessionDeliveryState({
        context: { channel: "telegram", to: "telegram:999", accountId: "acc-1" },
      }),
    };
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "exec-event",
      Surface: "exec-event",
      SessionKey: "agent:main:main",
      AccountId: undefined,
      OriginatingChannel: undefined,
      OriginatingTo: undefined,
    });

    const replyResolver = async () =>
      ({ text: "hi", mediaUrl: "https://example.test/reply.png" }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    const routeCall = firstRouteReplyCall();
    expect(routeCall?.channel).toBe("telegram");
    expect(routeCall?.to).toBe("telegram:999");
    expect(routeCall?.accountId).toBe("acc-1");
    expect(replyMediaPathMocks.createReplyMediaPathNormalizer.mock.calls[0]?.[0]).toMatchObject({
      messageProvider: "telegram",
      accountId: "acc-1",
    });
    expect(firstMockCall(hookMocks.runner.runReplyDispatch, "reply dispatch")).toEqual([
      expect.objectContaining({
        shouldRouteToOriginating: true,
        originatingChannel: "telegram",
        originatingTo: "telegram:999",
      }),
      expect.any(Object),
      expect.any(Function),
    ]);
  });

  it("routes sessions_send internal webchat handoffs through persisted external delivery context", async () => {
    setNoAbort();
    mocks.routeReply.mockClear();
    installThreadingTestPlugin({ id: "feishu" });
    sessionStoreMocks.currentEntry = {
      chatType: "channel",
      delivery: normalizeSessionDeliveryState({
        route: {
          channel: "feishu",
          accountId: "work",
          target: { to: "user:ou_123", chatType: "channel" },
          thread: { id: "thread:om_123", source: "explicit" },
        },
        context: {
          channel: "feishu",
          to: "user:ou_123",
          accountId: "work",
          threadId: "thread:om_123",
        },
      }),
    };
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "webchat",
      Surface: "webchat",
      SessionKey: "agent:main:feishu:direct:ou_123",
      AccountId: undefined,
      OriginatingChannel: "webchat",
      OriginatingTo: "session:dashboard",
      ChatType: "direct",
      InputProvenance: {
        kind: "inter_session",
        sourceTool: "sessions_send",
        sourceChannel: "webchat",
      },
    });

    const replyResolver = async () => ({ text: "hi" }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    const routeCall = firstRouteReplyCall();
    expect(routeCall?.channel).toBe("feishu");
    expect(routeCall?.to).toBe("user:ou_123");
    expect(routeCall?.accountId).toBe("work");
    expect(routeCall?.threadId).toBe("thread:om_123");
    expect(routeCall?.replyDelivery).toEqual({
      chatType: "channel",
      replyToMode: "all",
    });
    expect(firstMockCall(hookMocks.runner.runReplyDispatch, "reply dispatch")).toEqual([
      expect.objectContaining({
        shouldRouteToOriginating: true,
        originatingChannel: "feishu",
        originatingTo: "user:ou_123",
        originatingAccountId: "work",
        originatingThreadId: "thread:om_123",
        originatingChatType: "channel",
      }),
      expect.any(Object),
      expect.any(Function),
    ]);
  });
}
