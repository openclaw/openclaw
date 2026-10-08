import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HandleCommandsParams } from "./commands-types.js";

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  identity: vi.fn(),
  prepare: vi.fn(),
  execute: vi.fn(),
  back: vi.fn(),
  create: vi.fn(),
}));
// mock-isolation: Keep command routing and host effects synthetic while testing command semantics.
vi.mock("../../channels/conversation-resolution.js", () => ({
  resolveCommandConversationResolution: mocks.resolve,
}));
// mock-isolation: Keep command routing and host effects synthetic while testing command semantics.
vi.mock("../../config/sessions/conversation-identity.js", () => ({
  conversationIdentityFromMsgContext: mocks.identity,
}));
// mock-isolation: Keep command routing and host effects synthetic while testing command semantics.
vi.mock("./commands-fork-host.js", () => ({
  createNativeConversationForkHost: mocks.create,
}));
import { handleForkCommand } from "./commands-fork.js";

const conversation = {
  channel: "telegram",
  accountId: "default",
  conversationId: "-100123:topic:1",
};
function input(body: string, overrides: Record<string, unknown> = {}): HandleCommandsParams {
  return {
    cfg: {},
    agentId: "main",
    sessionKey: "agent:main:chat",
    command: {
      commandBodyNormalized: body,
      isAuthorizedSender: true,
      senderIsOwner: true,
      assertOwnerCurrent: vi.fn(),
      channel: "telegram",
      ...overrides,
    },
    ctx: {
      AccountId: "default",
      From: "telegram:123",
      To: "telegram:123",
      ReplyToIdFull: "reply-7",
      MessageThreadId: "1",
      IsForum: true,
    },
  } as unknown as HandleCommandsParams;
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolve.mockReturnValue(conversation);
  mocks.identity.mockReturnValue({
    channel: "telegram",
    accountId: "default",
    conversationRef: "ref:source",
  });
  mocks.create.mockReturnValue({
    prepare: mocks.prepare,
    execute: mocks.execute,
    back: mocks.back,
  });
  mocks.prepare.mockResolvedValue({
    status: "ready",
    ticket: "ticket",
    child: true,
    current: true,
    source: "reply",
  });
  mocks.execute.mockResolvedValue({ status: "placed" });
  mocks.back.mockResolvedValue({ status: "returned" });
});
describe("native /fork", () => {
  it("does not intercept unrelated text or disabled text commands", async () => {
    expect(await handleForkCommand(input("/status"), true)).toBeNull();
    expect(await handleForkCommand(input("/fork"), false)).toBeNull();
  });
  it("blocks unauthorized and non-owner senders before any fork capability", async () => {
    for (const override of [{ isAuthorizedSender: false }, { senderIsOwner: false }]) {
      expect((await handleForkCommand(input("/fork", override), true))?.reply?.text).toContain(
        "authorized owner",
      );
    }
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("requires a live owner assertion before creating a fork host", async () => {
    const params = input("/fork");
    params.command.assertOwnerCurrent = undefined;
    expect((await handleForkCommand(params, true))?.reply?.text).toContain("live owner authority");
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("fails closed without a safe conversation route", async () => {
    mocks.resolve.mockReturnValue(null);
    expect((await handleForkCommand(input("/fork"), true))?.reply?.text).toContain("no safe route");
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("uses exact reply ID and child-first placement", async () => {
    const result = await handleForkCommand(input("/fork Harbor"), true);
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        replyToId: "reply-7",
        replyConversationRef: "ref:source",
        conversation,
      }),
    );
    expect(mocks.prepare).toHaveBeenCalledWith({ title: "Harbor" });
    expect(mocks.execute).toHaveBeenCalledWith({ ticket: "ticket", placement: "child" });
    expect(result?.reply?.text).toContain("Forked into");
  });
  it("treats Telegram forum topic-root ancestry as a tip fork", async () => {
    const params = input("/fork Harbor");
    params.ctx.ReplyToIdFull = "1";
    await handleForkCommand(params, true);
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({ replyToId: undefined, replyConversationRef: undefined }),
    );
    expect(mocks.execute).toHaveBeenCalledWith({ ticket: "ticket", placement: "child" });
  });
  it("passes the command cancellation signal to the fork host", async () => {
    const controller = new AbortController();
    const params = input("/fork");
    params.opts = { abortSignal: controller.signal };
    await handleForkCommand(params, true);
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({ signal: controller.signal }),
    );
  });
  it("preserves channel/account/thread identity for another channel", async () => {
    const discord = {
      channel: "discord",
      accountId: "team",
      conversationId: "room:thread:7",
      parentConversationId: "room",
    };
    mocks.resolve.mockReturnValue(discord);
    mocks.identity.mockReturnValue({
      channel: "discord",
      accountId: "team",
      conversationRef: "ref:discord:team:7",
    });
    const params = input("/fork");
    params.command.channel = "discord";
    params.ctx.AccountId = "team";
    await handleForkCommand(params, true);
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        conversation: discord,
        replyConversationRef: "ref:discord:team:7",
      }),
    );
    expect(mocks.execute).toHaveBeenCalledWith({ ticket: "ticket", placement: "current" });
  });
  it("keeps Discord direct forks in the current conversation", async () => {
    mocks.resolve.mockReturnValue({
      channel: "discord",
      accountId: "team",
      conversationId: "user:123",
    });
    const params = input("/fork");
    params.command.channel = "discord";
    params.ctx.ReplyToIdFull = undefined;
    await handleForkCommand(params, true);
    expect(mocks.execute).toHaveBeenCalledWith({ ticket: "ticket", placement: "current" });
  });
  it("routes a Telegram direct chat in place before attempting a forum-topic write", async () => {
    const direct = { channel: "telegram", accountId: "default", conversationId: "123456" };
    mocks.resolve.mockReturnValue(direct);
    const result = await handleForkCommand(input("/fork"), true);
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    expect(mocks.execute).toHaveBeenCalledWith({ ticket: "ticket", placement: "current" });
    expect(result?.reply?.text).toContain("this conversation");
  });

  it("routes a non-forum Telegram group in place", async () => {
    mocks.resolve.mockReturnValue({
      channel: "telegram",
      accountId: "default",
      conversationId: "-100123",
    });
    const params = input("/split");
    params.ctx.IsForum = false;
    const result = await handleForkCommand(params, true);
    expect(mocks.execute).toHaveBeenCalledOnce();
    expect(mocks.execute).toHaveBeenCalledWith({ ticket: "ticket", placement: "current" });
    expect(result?.reply?.text).toContain("this conversation");
  });

  it("selects current directly for Telegram DMs without creating a forum topic", async () => {
    mocks.resolve.mockReturnValue({
      channel: "telegram",
      accountId: "default",
      conversationId: "123456",
    });
    const result = await handleForkCommand(input("/fork"), true);
    expect(mocks.execute).toHaveBeenCalledOnce();
    expect(mocks.execute).toHaveBeenCalledWith({ ticket: "ticket", placement: "current" });
    expect(result?.reply?.text).toContain("this conversation");
  });
  it("uses honest same-conversation fallback if child unsupported", async () => {
    mocks.prepare.mockResolvedValue({
      status: "ready",
      ticket: "ticket",
      child: false,
      current: true,
    });
    const result = await handleForkCommand(input("/fork"), true);
    expect(mocks.execute).toHaveBeenCalledWith({ ticket: "ticket", placement: "current" });
    expect(result?.reply?.text).toContain("this conversation");
  });
  it("falls back to current after a child adapter rejects placement without retrying the fork", async () => {
    mocks.execute
      .mockResolvedValueOnce({
        status: "not_placed",
        effect: "session_only",
        reason: "unsupported",
      })
      .mockResolvedValueOnce({ status: "placed", placement: "current" });
    const result = await handleForkCommand(input("/fork"), true);
    expect(mocks.execute).toHaveBeenNthCalledWith(1, { ticket: "ticket", placement: "child" });
    expect(mocks.execute).toHaveBeenNthCalledWith(2, { ticket: "ticket", placement: "current" });
    expect(result?.reply?.text).toContain("child placement unavailable");
  });
  it("does not retry current placement after a child topic creation failure", async () => {
    mocks.execute.mockResolvedValueOnce({
      status: "not_placed",
      effect: "session_only",
      reason: "creation_failed",
      forkSessionKey: "agent:main:dashboard:forked",
    });
    const result = await handleForkCommand(input("/fork"), true);
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    expect(mocks.execute).toHaveBeenCalledWith({ ticket: "ticket", placement: "child" });
    expect(result?.reply?.text).toContain("agent:main:dashboard:forked");
    expect(result?.reply?.text).not.toContain("Forked in this conversation");
  });

  it("reports an ambiguous placement without retrying or claiming route success", async () => {
    mocks.execute.mockResolvedValue({
      status: "ambiguous",
      forkSessionKey: "agent:main:dashboard:forked",
    });
    const result = await handleForkCommand(input("/fork"), true);
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    expect(result?.reply?.text).toContain("do not retry blindly");
    expect(result?.reply?.text).toContain("agent:main:dashboard:forked");
  });

  it("reports ambiguous replay without claiming a retry-safe failure", async () => {
    mocks.execute.mockResolvedValue({
      status: "placed",
      replay: "ambiguous",
      conversationId: "room:topic:child",
    });
    const result = await handleForkCommand(input("/fork"), true);
    expect(result?.reply?.text).toContain("unconfirmed");
    expect(result?.reply?.text).toContain("room:topic:child");
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });
  it("refuses an unverifiable reply origin", async () => {
    mocks.identity.mockReturnValue(null);
    expect((await handleForkCommand(input("/fork"), true))?.reply?.text).toContain("cannot verify");
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("returns via persisted binding and refuses unknown switches", async () => {
    expect((await handleForkCommand(input("/fork --back"), true))?.reply?.text).toContain(
      "Restored",
    );
    expect(mocks.back).toHaveBeenCalledTimes(1);
    expect((await handleForkCommand(input("/fork --force"), true))?.reply?.text).toContain("Usage");
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});
