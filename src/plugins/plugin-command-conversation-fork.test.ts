import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  conversation,
  createPluginCommandConversationForkHostFixture as createPluginCommandConversationForkHost,
  host,
  mocks,
} from "./plugin-command-conversation-fork.test-fixture.js";

describe("plugin command conversation fork host", () => {
  beforeEach(() => {
    mocks.current = null;
    mocks.pendingChildren.clear();
    mocks.transcriptEvents = [];
    vi.clearAllMocks();
  });

  it("prepares and places a tip fork in a child conversation", async () => {
    const runtime = host();
    const plan = await runtime.prepare({ title: "Tangent" });
    expect(plan).toMatchObject({ status: "ready", child: true, current: true, source: "tip" });
    if (plan.status !== "ready") {
      throw new Error("expected ready plan");
    }
    await expect(
      runtime.execute({ ticket: plan.ticket, placement: "child" }),
    ).resolves.toMatchObject({
      status: "placed",
      placement: "child",
      replay: "none",
      conversationId: "-1001234567890:topic:99",
    });
    expect(mocks.createGatewaySession).toHaveBeenCalledWith(
      expect.objectContaining({
        parentSessionKey: "agent:main:source",
        fork: true,
        forkFrom: "last-completed",
      }),
    );
    const createCall = mocks.createGatewaySession.mock.calls[0] as unknown as [object];
    expect(createCall[0]).not.toHaveProperty("emitCommandHooks");
    expect(createCall[0]).not.toHaveProperty("succeedsParent");
    expect(mocks.pendingChildren.size).toBe(0);
  });

  it("retains uncertain native child placement across tickets and invocations", async () => {
    const runtime = host();
    const plan = await runtime.prepare();
    if (plan.status !== "ready") {
      throw new Error("expected ready plan");
    }
    mocks.service.bind.mockRejectedValueOnce(new Error("Telegram child topic response lost"));
    await expect(runtime.execute({ ticket: plan.ticket, placement: "child" })).resolves.toEqual({
      status: "pending",
    });
    expect(mocks.pendingChildren.size).toBe(1);
    await expect(runtime.execute({ ticket: plan.ticket, placement: "current" })).resolves.toEqual({
      status: "pending",
    });
    await expect(host().prepare()).resolves.toEqual({ status: "pending" });
    await expect(host().status()).resolves.toEqual({ status: "pending" });
    expect(mocks.service.bind).toHaveBeenCalledTimes(1);
  });

  it("clears a durable child marker only for a proven no-effect binding failure", async () => {
    const runtime = host();
    const plan = await runtime.prepare();
    if (plan.status !== "ready") {
      throw new Error("expected ready plan");
    }
    mocks.service.bind.mockRejectedValueOnce(
      Object.assign(new Error("no topic created"), {
        code: "BINDING_CREATE_FAILED",
      }),
    );
    await expect(runtime.execute({ ticket: plan.ticket, placement: "child" })).resolves.toEqual({
      status: "not_placed",
      effect: "session_only",
      reason: "creation_failed",
    });
    expect(mocks.pendingChildren.size).toBe(0);
    await expect(
      runtime.execute({ ticket: plan.ticket, placement: "current" }),
    ).resolves.toMatchObject({
      status: "placed",
      placement: "current",
    });
  });

  it.each([
    { channel: "discord", conversationId: "guild:thread:42" },
    { channel: "telegram", conversationId: "-1001234567890" },
  ])(
    "does not create a child without a verifiable Back destination for $channel",
    async (source) => {
      const runtime = host({ ...conversation, ...source });
      const plan = await runtime.prepare();
      expect(plan).toMatchObject({ status: "ready", child: false, current: true });
      if (plan.status !== "ready") {
        throw new Error("expected ready plan");
      }
      await expect(runtime.execute({ ticket: plan.ticket, placement: "child" })).resolves.toEqual({
        status: "not_placed",
        effect: "none",
        reason: "unsupported",
      });
      expect(mocks.createGatewaySession).not.toHaveBeenCalled();
      expect(mocks.service.bind).not.toHaveBeenCalled();
    },
  );

  it("restores an unbound route when the fork replaced an unbound conversation", async () => {
    const runtime = host();
    const plan = await runtime.prepare();
    if (plan.status !== "ready") {
      throw new Error("expected ready plan");
    }
    await runtime.execute({ ticket: plan.ticket, placement: "current" });
    await expect(host().back()).resolves.toEqual({
      status: "returned",
      mode: "restored",
      shared: true,
    });
    expect(mocks.service.unbind).toHaveBeenCalledWith(
      expect.objectContaining({ bindingId: "binding-1", reason: "conversation-fork-back" }),
    );
    expect(mocks.current).toBeNull();
  });

  it("allows an activity touch while Back removes a fork from an unbound route", async () => {
    const runtime = host();
    const plan = await runtime.prepare();
    if (plan.status !== "ready") {
      throw new Error("expected ready plan");
    }
    await runtime.execute({ ticket: plan.ticket, placement: "current" });
    mocks.service.unbind.mockImplementationOnce(async (input: { assertCurrent?: () => void }) => {
      mocks.current = { ...mocks.current, lastActivityAt: Date.now() };
      input.assertCurrent?.();
      const removed = mocks.current;
      mocks.current = null;
      return removed ? [removed] : [];
    });
    await expect(host().back()).resolves.toMatchObject({ status: "returned", mode: "restored" });
  });

  it("allows an activity touch while Back restores the previous bound route", async () => {
    mocks.current = {
      bindingId: "source-binding",
      generation: crypto.randomUUID(),
      targetSessionKey: "agent:main:source",
      targetKind: "session",
      conversation,
      status: "active",
      boundAt: Date.now(),
    };
    const runtime = host();
    const plan = await runtime.prepare();
    if (plan.status !== "ready") {
      throw new Error("expected ready plan");
    }
    await runtime.execute({ ticket: plan.ticket, placement: "current" });
    const defaultBind = mocks.service.bind.getMockImplementation();
    if (!defaultBind) {
      throw new Error("expected a default bind implementation");
    }
    mocks.service.bind.mockImplementationOnce(async (input: Record<string, unknown>) => {
      mocks.current = { ...mocks.current, lastActivityAt: Date.now() };
      (input.assertCurrent as (() => void) | undefined)?.();
      return defaultBind(input);
    });
    await expect(host().back()).resolves.toMatchObject({ status: "returned", mode: "restored" });
    expect(mocks.service.bind.mock.lastCall?.[0]).toMatchObject({
      targetSessionKey: "agent:main:source",
    });
  });

  it.each([50, 101])("preserves or refuses the saved deadline at +%ims", async (offset) => {
    const now = Date.now();
    mocks.current = {
      bindingId: "source-binding",
      generation: crypto.randomUUID(),
      targetSessionKey: "agent:main:source",
      targetKind: "session",
      conversation,
      status: "active",
      boundAt: now,
      expiresAt: now + 100,
    };
    const runtime = host();
    const plan = await runtime.prepare();
    if (plan.status !== "ready") {
      throw new Error("expected ready plan");
    }
    await runtime.execute({ ticket: plan.ticket, placement: "current" });
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + offset);
    try {
      await expect(host().back()).resolves.toMatchObject({
        status: offset < 100 ? "returned" : "conflict",
      });
      if (offset < 100) {
        expect(mocks.service.bind.mock.lastCall?.[0]).toMatchObject({ expiresAt: now + 100 });
      }
    } finally {
      clock.mockRestore();
    }
  });

  it("refuses Back if the fork binding is reassigned before removal", async () => {
    const runtime = host();
    const plan = await runtime.prepare();
    if (plan.status !== "ready") {
      throw new Error("expected ready plan");
    }
    await runtime.execute({ ticket: plan.ticket, placement: "current" });
    mocks.service.unbind.mockImplementationOnce(async (input: { assertCurrent?: () => void }) => {
      mocks.current = {
        bindingId: "binding-1",
        generation: crypto.randomUUID(),
        targetSessionKey: "agent:main:other",
        targetKind: "session",
        conversation,
        status: "active",
        boundAt: Date.now(),
      };
      input.assertCurrent?.();
      return [];
    });
    await expect(host().back()).resolves.toEqual({ status: "conflict" });
    expect(mocks.current).toMatchObject({ targetSessionKey: "agent:main:other" });
  });

  it("restores a flat group when the adapter omits a redundant self-parent", async () => {
    const flatConversation = { ...conversation, conversationId: "-100999001" };
    const withSelfParent = {
      ...flatConversation,
      parentConversationId: flatConversation.conversationId,
    };
    mocks.current = {
      bindingId: "source-binding",
      generation: crypto.randomUUID(),
      targetSessionKey: "agent:main:source",
      targetKind: "session",
      conversation: flatConversation,
      status: "active",
      boundAt: Date.now(),
      metadata: {},
    };
    const runtime = host(withSelfParent);
    const plan = await runtime.prepare();
    if (plan.status !== "ready") {
      throw new Error("expected ready plan");
    }
    await expect(
      runtime.execute({ ticket: plan.ticket, placement: "current" }),
    ).resolves.toMatchObject({
      status: "placed",
    });
    const placed = mocks.current as Record<string, unknown>;
    mocks.current = { ...placed, conversation: flatConversation };
    await expect(host(withSelfParent).back()).resolves.toMatchObject({ status: "returned" });
  });

  it("refuses forged persisted Back targets without writing a binding", async () => {
    const runtime = host();
    const plan = await runtime.prepare();
    if (plan.status !== "ready") {
      throw new Error("expected ready plan");
    }
    await runtime.execute({ ticket: plan.ticket, placement: "current" });
    const placed = mocks.current as Record<string, unknown> & {
      metadata: { conversationFork: Record<string, unknown> };
    };
    const metadata = placed.metadata.conversationFork;
    for (const forged of [
      { forkSessionKey: "agent:other:fork" },
      { sourceSessionKey: "agent:other:source" },
      { sourceConversation: { ...conversation, conversationId: "other-room" } },
      { sourceConversation: { ...conversation, parentConversationId: "other-parent" } },
      { previous: { targetSessionKey: "agent:other:source", conversation } },
      { previous: { targetSessionKey: "agent:main:another-session", conversation } },
      { previous: "not-a-binding" },
    ]) {
      mocks.current = {
        ...placed,
        metadata: { ...placed.metadata, conversationFork: { ...metadata, ...forged } },
      };
      mocks.service.bind.mockClear();
      await expect(host().back()).resolves.toEqual({ status: "no_previous" });
      await expect(host().status()).resolves.toEqual({ status: "idle" });
      expect(mocks.service.bind).not.toHaveBeenCalled();
    }
  });

  it("fences a pre-upgrade source binding before preparing the fork", async () => {
    mocks.current = {
      bindingId: "legacy-binding",
      targetSessionKey: "agent:main:source",
      targetKind: "session",
      conversation,
      status: "active",
      boundAt: Date.now(),
    };
    await expect(host().prepare()).resolves.toMatchObject({ status: "ready" });
    expect(mocks.current).toMatchObject({ generation: expect.any(String) });
    expect(mocks.createGatewaySession).not.toHaveBeenCalled();
  });

  it("refuses a source conversation already rebound to another session", async () => {
    mocks.current = {
      bindingId: "new-owner",
      generation: crypto.randomUUID(),
      targetSessionKey: "agent:main:other",
      targetKind: "session",
      conversation,
      status: "active",
      boundAt: Date.now(),
    };
    await expect(host().prepare()).resolves.toEqual({
      status: "blocked",
      reason: "binding_changed",
    });
    expect(mocks.createGatewaySession).not.toHaveBeenCalled();
  });

  it("reuses a prepared session when child placement fails before current fallback", async () => {
    mocks.service.bind
      .mockRejectedValueOnce({ code: "BINDING_CREATE_FAILED" })
      .mockImplementationOnce(async (input: Record<string, unknown>) => {
        // SAFETY: the production bind contract always supplies a normalized conversation record.
        const boundConversation = input.conversation as Record<string, unknown>;
        const record = {
          bindingId: "binding-current",
          generation: crypto.randomUUID(),
          targetSessionKey: input.targetSessionKey,
          targetKind: input.targetKind,
          conversation: boundConversation,
          status: "active",
          boundAt: Date.now(),
          metadata: input.metadata,
        };
        mocks.current = record;
        return record;
      });
    const runtime = host();
    const plan = await runtime.prepare();
    if (plan.status !== "ready") {
      throw new Error("expected ready plan");
    }
    await expect(
      runtime.execute({ ticket: plan.ticket, placement: "child" }),
    ).resolves.toMatchObject({ status: "not_placed", effect: "session_only" });
    await expect(
      runtime.execute({ ticket: plan.ticket, placement: "current" }),
    ).resolves.toMatchObject({ status: "placed", placement: "current" });
    expect(mocks.createGatewaySession).toHaveBeenCalledTimes(1);
  });

  it("rejects a retained host after invocation closure", async () => {
    const controller = new AbortController();
    const runtime = createPluginCommandConversationForkHost({
      config: {},
      agentId: "main",
      sessionKey: "agent:main:source",
      conversation,
      signal: controller.signal,
    });
    controller.abort();
    await expect(runtime.prepare()).rejects.toThrow();
    await expect(runtime.status()).rejects.toThrow();
  });

  it("maps a native reply id, forks before that prompt, and submits it once", async () => {
    mocks.transcriptEvents = [
      {
        id: "entry-user-1",
        message: {
          role: "user",
          content: [{ type: "text", text: "Take the other path" }],
          __openclaw: { transport: { messageId: "telegram-41", conversation } },
        },
      },
    ];
    mocks.dispatchReplay.mockImplementationOnce(async (input: unknown) => {
      const replay = input as {
        dispatcherOptions: {
          deliver: (payload: unknown, info: { kind: string }) => Promise<unknown>;
        };
      };
      await replay.dispatcherOptions.deliver({ text: "fork answer" }, { kind: "final" });
      return { queuedFinal: true, counts: {} };
    });
    const runtime = createPluginCommandConversationForkHost({
      config: {},
      agentId: "main",
      sessionKey: "agent:main:source",
      conversation,
      replyToId: "telegram-41",
      signal: new AbortController().signal,
    });
    const plan = await runtime.prepare();
    expect(plan).toMatchObject({ status: "ready", source: "reply" });
    if (plan.status !== "ready") {
      throw new Error("expected reply plan");
    }
    await expect(
      runtime.execute({ ticket: plan.ticket, placement: "current" }),
    ).resolves.toMatchObject({ status: "placed", source: "reply", replay: "submitted" });
    expect(mocks.forkSessionAtMessage).toHaveBeenCalledWith(
      expect.objectContaining({ entryId: "entry-user-1" }),
      expect.any(Object),
    );
    expect(mocks.dispatchReplay).toHaveBeenCalledTimes(1);
    expect(mocks.dispatchReplay.mock.calls[0]?.[0]).toMatchObject({
      ctx: {
        Body: "Take the other path",
        SessionKey: "agent:main:dashboard:reply-fork",
      },
    });
    expect(mocks.routeReply).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        to: conversation.conversationId,
        sessionKey: "agent:main:dashboard:reply-fork",
      }),
    );
  });

  it("does not trust top-level transport fields as persisted reply provenance", async () => {
    mocks.transcriptEvents = [
      {
        id: "unprotected",
        message: {
          role: "user",
          content: "untrusted",
          transport: { messageId: "telegram-41", conversation },
        },
      },
    ];
    await expect(
      createPluginCommandConversationForkHost({
        config: {},
        agentId: "main",
        sessionKey: "agent:main:source",
        conversation,
        replyToId: "telegram-41",
        signal: new AbortController().signal,
      }).prepare(),
    ).resolves.toEqual({ status: "blocked", reason: "reply_unavailable" });
  });

  it("does not fall back to an older duplicate ID when the newest exact reply is blank", async () => {
    mocks.transcriptEvents = [
      {
        id: "older",
        message: {
          role: "user",
          content: "old prompt",
          __openclaw: { transport: { messageId: "telegram-41", conversation } },
        },
      },
      {
        id: "newer",
        message: {
          role: "user",
          content: " ",
          __openclaw: { transport: { messageId: "telegram-41", conversation } },
        },
      },
    ];
    await expect(
      createPluginCommandConversationForkHost({
        config: {},
        agentId: "main",
        sessionKey: "agent:main:source",
        conversation,
        replyToId: "telegram-41",
        signal: new AbortController().signal,
      }).prepare(),
    ).resolves.toEqual({ status: "blocked", reason: "reply_unavailable" });
    expect(mocks.forkSessionAtMessage).not.toHaveBeenCalled();
  });

  it("refuses media reply replay until the host can preserve media exactly once", async () => {
    mocks.transcriptEvents = [
      {
        id: "entry-user-media",
        message: {
          role: "user",
          content: "Describe this",
          __openclaw: {
            transport: { messageId: "telegram-media-1", conversation },
            media: [{ type: "image", url: "file:///tmp/example.png" }],
          },
        },
      },
    ];
    const runtime = createPluginCommandConversationForkHost({
      config: {},
      agentId: "main",
      sessionKey: "agent:main:source",
      conversation,
      replyToId: "telegram-media-1",
      signal: new AbortController().signal,
    });
    await expect(runtime.prepare()).resolves.toEqual({
      status: "blocked",
      reason: "media_unavailable",
    });
    expect(mocks.forkSessionAtMessage).not.toHaveBeenCalled();
    expect(mocks.dispatchReplay).not.toHaveBeenCalled();
  });

  it("refuses a mixed text-and-image content reply without dropping the image", async () => {
    mocks.transcriptEvents = [
      {
        id: "entry-mixed",
        message: {
          role: "user",
          content: [
            { type: "text", text: "Describe this" },
            { type: "image", source: { type: "url", url: "https://example.invalid/image.png" } },
          ],
          __openclaw: { transport: { messageId: "telegram-mixed-1", conversation } },
        },
      },
    ];
    const runtime = createPluginCommandConversationForkHost({
      config: {},
      agentId: "main",
      sessionKey: "agent:main:source",
      conversation,
      replyToId: "telegram-mixed-1",
      signal: new AbortController().signal,
    });
    await expect(runtime.prepare()).resolves.toEqual({
      status: "blocked",
      reason: "media_unavailable",
    });
    expect(mocks.forkSessionAtMessage).not.toHaveBeenCalled();
  });

  it.each(["telegram", "discord"])(
    "rejects a %s same-ID cross-chat or unproven reply origin",
    async (channel) => {
      const scopedConversation = { ...conversation, channel };
      mocks.transcriptEvents = [
        {
          id: "other-chat",
          message: {
            role: "user",
            content: "private",
            __openclaw: {
              transport: {
                messageId: "91",
                conversation: { ...scopedConversation, conversationId: "other-chat" },
              },
            },
          },
        },
        {
          id: "other-channel",
          message: {
            role: "user",
            content: "other channel",
            __openclaw: {
              transport: {
                messageId: "91",
                conversation: { ...scopedConversation, channel: "different-provider" },
              },
            },
          },
        },
        {
          id: "unknown",
          message: {
            role: "user",
            content: "unscoped",
            __openclaw: { transport: { messageId: "91" } },
          },
        },
      ];
      const runtime = createPluginCommandConversationForkHost({
        config: {},
        agentId: "main",
        sessionKey: "agent:main:source",
        conversation: scopedConversation,
        replyToId: "91",
        signal: new AbortController().signal,
      });
      await expect(runtime.prepare()).resolves.toEqual({
        status: "blocked",
        reason: "reply_unavailable",
      });
      expect(mocks.forkSessionAtMessage).not.toHaveBeenCalled();
    },
  );

  it("rejects binding changes between preparation and child placement", async () => {
    const runtime = host();
    const plan = await runtime.prepare();
    if (plan.status !== "ready") {
      throw new Error("expected plan");
    }
    mocks.current = { bindingId: "foreign", targetSessionKey: "agent:other", conversation };
    await expect(runtime.execute({ ticket: plan.ticket, placement: "child" })).resolves.toEqual({
      status: "blocked",
      reason: "binding_changed",
    });
    expect(mocks.service.bind).not.toHaveBeenCalled();
  });

  it("rejects binding changes inside the adapter before its placement commit", async () => {
    const runtime = host();
    const plan = await runtime.prepare();
    if (plan.status !== "ready") {
      throw new Error("expected plan");
    }
    mocks.service.bind.mockImplementationOnce(async (input: Record<string, unknown>) => {
      mocks.current = { bindingId: "interloper", targetSessionKey: "agent:other", conversation };
      (input.assertCurrent as () => void)();
      throw new Error("must not reach placement");
    });
    await expect(runtime.execute({ ticket: plan.ticket, placement: "child" })).resolves.toEqual({
      status: "blocked",
      reason: "binding_changed",
    });
  });

  it("never retries ambiguous reply replay after committed placement", async () => {
    mocks.transcriptEvents = [
      {
        id: "entry",
        message: {
          role: "user",
          content: "branch",
          __openclaw: { transport: { messageId: "telegram-41", conversation } },
        },
      },
    ];
    const runtime = createPluginCommandConversationForkHost({
      config: {},
      agentId: "main",
      sessionKey: "agent:main:source",
      conversation,
      replyToId: "telegram-41",
      signal: new AbortController().signal,
    });
    const plan = await runtime.prepare();
    if (plan.status !== "ready") {
      throw new Error("expected plan");
    }
    mocks.dispatchReplay.mockRejectedValueOnce(new Error("possibly accepted"));
    await expect(
      runtime.execute({ ticket: plan.ticket, placement: "child" }),
    ).resolves.toMatchObject({
      status: "placed",
      replay: "ambiguous",
    });
    await expect(runtime.execute({ ticket: plan.ticket, placement: "child" })).resolves.toEqual({
      status: "blocked",
      reason: "unauthorized",
    });
    expect(mocks.dispatchReplay).toHaveBeenCalledTimes(1);
    expect(mocks.service.bind).toHaveBeenCalledTimes(1);
    await expect(runtime.status()).resolves.toEqual({ status: "idle" });
    const childRuntime = createPluginCommandConversationForkHost({
      config: {},
      agentId: "main",
      sessionKey: "agent:main:dashboard:reply-fork",
      conversation: { ...conversation, conversationId: "-1001234567890:topic:99" },
      signal: new AbortController().signal,
    });
    await expect(childRuntime.status()).resolves.toMatchObject({
      status: "placed",
      replay: "unknown",
    });
  });

  it("does not deliver a replay after its conversation is rebound", async () => {
    mocks.transcriptEvents = [
      {
        id: "entry",
        message: {
          role: "user",
          content: "branch",
          __openclaw: { transport: { messageId: "telegram-41", conversation } },
        },
      },
    ];
    mocks.dispatchReplay.mockImplementationOnce(async (input: unknown) => {
      const replay = input as {
        dispatcherOptions: {
          deliver: (payload: unknown, info: { kind: string }) => Promise<unknown>;
        };
      };
      mocks.current = {
        bindingId: "binding-1",
        generation: crypto.randomUUID(),
        targetSessionKey: "agent:main:other",
        targetKind: "session",
        conversation,
        status: "active",
        boundAt: Date.now(),
      };
      await replay.dispatcherOptions.deliver({ text: "must not send" }, { kind: "final" });
      return { queuedFinal: true, counts: {} };
    });
    const runtime = createPluginCommandConversationForkHost({
      config: {},
      agentId: "main",
      sessionKey: "agent:main:source",
      conversation,
      replyToId: "telegram-41",
      signal: new AbortController().signal,
    });
    const plan = await runtime.prepare();
    if (plan.status !== "ready") {
      throw new Error("expected plan");
    }
    await expect(
      runtime.execute({ ticket: plan.ticket, placement: "current" }),
    ).resolves.toMatchObject({
      status: "placed",
      replay: "ambiguous",
    });
    expect(mocks.routeReply).not.toHaveBeenCalled();
  });

  it("does not deliver a replay after owner authority is revoked", async () => {
    let authorized = true;
    mocks.transcriptEvents = [
      {
        id: "entry",
        message: {
          role: "user",
          content: "branch",
          __openclaw: { transport: { messageId: "telegram-41", conversation } },
        },
      },
    ];
    mocks.dispatchReplay.mockImplementationOnce(async (input: unknown) => {
      const replay = input as {
        dispatcherOptions: {
          deliver: (payload: unknown, info: { kind: string }) => Promise<unknown>;
        };
      };
      authorized = false;
      await replay.dispatcherOptions.deliver({ text: "must not send" }, { kind: "final" });
      return { queuedFinal: true, counts: {} };
    });
    const runtime = createPluginCommandConversationForkHost({
      config: {},
      agentId: "main",
      sessionKey: "agent:main:source",
      conversation,
      replyToId: "telegram-41",
      signal: new AbortController().signal,
      assertOwnerCurrent: () => {
        if (!authorized) {
          throw new Error("owner revoked");
        }
      },
    });
    const plan = await runtime.prepare();
    if (plan.status !== "ready") {
      throw new Error("expected plan");
    }
    await expect(
      runtime.execute({ ticket: plan.ticket, placement: "current" }),
    ).resolves.toMatchObject({
      status: "placed",
      replay: "ambiguous",
    });
    expect(mocks.routeReply).not.toHaveBeenCalled();
  });

  it.each(["owner", "binding"] as const)(
    "rechecks %s authority when a queued replay reaches model admission",
    async (change) => {
      let authorized = true;
      mocks.transcriptEvents = [
        {
          id: "entry",
          message: {
            role: "user",
            content: "branch",
            __openclaw: { transport: { messageId: "telegram-41", conversation } },
          },
        },
      ];
      mocks.dispatchReplay.mockImplementationOnce(async (input: unknown) => {
        const replay = input as { replyResolver: () => Promise<unknown> };
        await Promise.resolve(); // Dispatch may queue before admitting the model run.
        if (change === "owner") {
          authorized = false;
        } else {
          mocks.current = { ...mocks.current, generation: crypto.randomUUID() };
        }
        await replay.replyResolver();
        return { queuedFinal: true, counts: {} };
      });
      const runtime = createPluginCommandConversationForkHost({
        config: {},
        agentId: "main",
        sessionKey: "agent:main:source",
        conversation,
        replyToId: "telegram-41",
        signal: new AbortController().signal,
        assertOwnerCurrent: () => {
          if (!authorized) {
            throw new Error("owner revoked");
          }
        },
      });
      const plan = await runtime.prepare();
      if (plan.status !== "ready") {
        throw new Error("expected ready plan");
      }
      await expect(
        runtime.execute({ ticket: plan.ticket, placement: "current" }),
      ).resolves.toMatchObject({
        status: "placed",
        replay: "ambiguous",
      });
      expect(mocks.getReplyFromConfig).not.toHaveBeenCalled();
      expect(mocks.routeReply).not.toHaveBeenCalled();
    },
  );

  it.each(["owner", "binding"] as const)(
    "blocks a %s change at the final replay adapter handoff",
    async (change) => {
      let authorized = true;
      let physicalSend = false;
      mocks.transcriptEvents = [
        {
          id: "entry",
          message: {
            role: "user",
            content: "branch",
            __openclaw: { transport: { messageId: "telegram-41", conversation } },
          },
        },
      ];
      mocks.dispatchReplay.mockImplementationOnce(async (input: unknown) => {
        const replay = input as {
          dispatcherOptions: {
            deliver: (payload: unknown, info: { kind: string }) => Promise<unknown>;
          };
        };
        await replay.dispatcherOptions.deliver({ text: "must not send" }, { kind: "final" });
        return { queuedFinal: true, counts: {} };
      });
      mocks.routeReply.mockImplementationOnce(async (input: unknown) => {
        const route = input as { assertDirectAdapterHandoff?: () => void };
        await Promise.resolve();
        if (change === "owner") {
          authorized = false;
        } else {
          mocks.current = { ...mocks.current, generation: crypto.randomUUID() };
        }
        route.assertDirectAdapterHandoff?.();
        physicalSend = true;
        return { ok: true, delivered: true };
      });
      const runtime = createPluginCommandConversationForkHost({
        config: {},
        agentId: "main",
        sessionKey: "agent:main:source",
        conversation,
        replyToId: "telegram-41",
        signal: new AbortController().signal,
        assertOwnerCurrent: () => {
          if (!authorized) {
            throw new Error("owner revoked");
          }
        },
      });
      const plan = await runtime.prepare();
      if (plan.status !== "ready") {
        throw new Error("expected ready plan");
      }
      await expect(
        runtime.execute({ ticket: plan.ticket, placement: "current" }),
      ).resolves.toMatchObject({
        status: "placed",
        replay: "ambiguous",
      });
      expect(mocks.routeReply).toHaveBeenCalledTimes(1);
      expect(physicalSend).toBe(false);
    },
  );

  it("does not dispatch concurrent executions of the same ticket", async () => {
    const runtime = host();
    const plan = await runtime.prepare();
    if (plan.status !== "ready") {
      throw new Error("expected plan");
    }
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = mocks.service.bind.getMockImplementation()!;
    mocks.service.bind.mockImplementationOnce(async (input: Record<string, unknown>) => {
      await gate;
      return original(input);
    });
    const first = runtime.execute({ ticket: plan.ticket, placement: "child" });
    await expect(runtime.execute({ ticket: plan.ticket, placement: "child" })).resolves.toEqual({
      status: "blocked",
      reason: "unauthorized",
    });
    release();
    await expect(first).resolves.toMatchObject({ status: "placed" });
    expect(mocks.service.bind).toHaveBeenCalledTimes(1);
  });
});
