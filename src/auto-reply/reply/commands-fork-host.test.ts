import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  conversation,
  createNativeConversationForkHostFixture as createNativeConversationForkHost,
  createUnassertedNativeConversationForkHost as createForkHost,
  host,
  mocks,
} from "./commands-fork-host.test-fixture.js";

describe("native conversation fork host", () => {
  beforeEach(() => {
    mocks.current = null;
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
      conversationId: "room:topic:created",
    });
    expect(mocks.createGatewaySession).toHaveBeenCalledWith(
      expect.objectContaining({
        parentSessionKey: "agent:main:source",
        fork: true,
        forkFrom: "last-completed",
        commandSource: "native-command:fork",
      }),
    );
    const createCall = mocks.createGatewaySession.mock.calls[0] as unknown as [object];
    expect(createCall[0]).not.toHaveProperty("emitCommandHooks");
    expect(createCall[0]).not.toHaveProperty("succeedsParent");
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

  it("rejects Feishu placement before creating a session without generation-fenced Back", async () => {
    await expect(host({ ...conversation, channel: "feishu" }).prepare()).resolves.toEqual({
      status: "blocked",
      reason: "unsupported",
    });
    expect(mocks.createGatewaySession).not.toHaveBeenCalled();
    expect(mocks.service.bind).not.toHaveBeenCalled();
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
    const runtime = host();
    const plan = await runtime.prepare();
    expect(plan).toMatchObject({ status: "ready" });
    expect(mocks.service.bind).toHaveBeenCalledWith(
      expect.objectContaining({
        targetSessionKey: "agent:main:source",
        placement: "current",
        assertCurrent: expect.any(Function),
      }),
    );
    expect(mocks.current).toMatchObject({ generation: expect.any(String) });
  });

  it("restores a persisted fork after a new host invocation (upgrade/restart boundary)", async () => {
    const initial = host();
    const plan = await initial.prepare();
    if (plan.status !== "ready") {
      throw new Error("expected ready plan");
    }
    const placed = await initial.execute({ ticket: plan.ticket, placement: "current" });
    expect(placed.status).toBe("placed");
    const reloaded = host();
    await expect(reloaded.back()).resolves.toMatchObject({ status: "returned" });
  });

  it.each([false, true])(
    "returns from a current fork after ordinary activity (source bound: %s)",
    async (sourceBound) => {
      if (sourceBound) {
        mocks.current = {
          bindingId: "source-binding",
          generation: crypto.randomUUID(),
          targetSessionKey: "agent:main:source",
          targetKind: "session",
          conversation,
          status: "active",
          boundAt: Date.now(),
          metadata: {},
        };
      }
      const runtime = host();
      const plan = await runtime.prepare();
      if (plan.status !== "ready") {
        throw new Error("expected ready plan");
      }
      await runtime.execute({ ticket: plan.ticket, placement: "current" });
      const fork = mocks.current;
      if (!fork) {
        throw new Error("expected placed fork");
      }
      mocks.current = {
        ...fork,
        expiresAt: Date.now() + 60_000,
        metadata: { ...(fork.metadata as object), lastActivityAt: Date.now() },
      };
      await expect(host().back()).resolves.toMatchObject({
        status: "returned",
        mode: "restored",
      });
      expect(mocks.current?.targetSessionKey).toBe(sourceBound ? "agent:main:source" : undefined);
    },
  );

  it("does not report Back success after the saved source route expires", async () => {
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
      metadata: {},
    };
    const runtime = host();
    const plan = await runtime.prepare();
    if (plan.status !== "ready") {
      throw new Error("expected ready plan");
    }
    await runtime.execute({ ticket: plan.ticket, placement: "current" });
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 101);
    try {
      await expect(host().back()).resolves.toEqual({ status: "conflict" });
      expect(mocks.current).toMatchObject({ targetSessionKey: "agent:main:dashboard:forked" });
      expect(mocks.service.bind).toHaveBeenCalledTimes(1);
    } finally {
      clock.mockRestore();
    }
  });

  it("passes the saved absolute deadline when restoring a live source route", async () => {
    const deadline = Date.now() + 60_000;
    mocks.current = {
      bindingId: "source-binding",
      generation: crypto.randomUUID(),
      targetSessionKey: "agent:main:source",
      targetKind: "session",
      conversation,
      status: "active",
      boundAt: Date.now(),
      expiresAt: deadline,
      metadata: {},
    };
    const runtime = host();
    const plan = await runtime.prepare();
    if (plan.status !== "ready") {
      throw new Error("expected ready plan");
    }
    await runtime.execute({ ticket: plan.ticket, placement: "current" });
    await expect(host().back()).resolves.toMatchObject({ status: "returned" });
    expect(mocks.service.bind).toHaveBeenLastCalledWith(
      expect.objectContaining({ targetSessionKey: "agent:main:source", expiresAt: deadline }),
    );
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
    const initial = host(withSelfParent);
    const plan = await initial.prepare();
    if (plan.status !== "ready") {
      throw new Error("expected ready plan");
    }
    await expect(
      initial.execute({ ticket: plan.ticket, placement: "current" }),
    ).resolves.toMatchObject({
      status: "placed",
    });
    const placed = mocks.current as Record<string, unknown>;
    mocks.current = { ...placed, conversation: flatConversation };
    await expect(host(withSelfParent).back()).resolves.toMatchObject({ status: "returned" });
  });

  it("rejects tampered persisted Back metadata instead of routing another session", async () => {
    const initial = host();
    const plan = await initial.prepare();
    if (plan.status !== "ready") {
      throw new Error("expected ready plan");
    }
    await initial.execute({ ticket: plan.ticket, placement: "current" });
    const current = mocks.current as Record<string, unknown>;
    const metadata = current.metadata as Record<string, unknown>;
    const fork = metadata.conversationFork as Record<string, unknown>;
    current.metadata = {
      ...metadata,
      conversationFork: { ...fork, forkSessionKey: "agent:other:stolen" },
    };
    mocks.service.bind.mockClear();
    await expect(host().back()).resolves.toEqual({ status: "no_previous" });
    expect(mocks.service.bind).not.toHaveBeenCalled();
  });

  it("rejects a same-agent foreign previous target in persisted Back metadata", async () => {
    mocks.current = {
      bindingId: "source-binding",
      generation: crypto.randomUUID(),
      targetSessionKey: "agent:main:source",
      targetKind: "session",
      conversation,
      status: "active",
      boundAt: Date.now(),
    };
    const initial = host();
    const plan = await initial.prepare();
    if (plan.status !== "ready") {
      throw new Error("expected ready plan");
    }
    await initial.execute({ ticket: plan.ticket, placement: "current" });
    const current = mocks.current as Record<string, unknown>;
    const metadata = current.metadata as Record<string, unknown>;
    const fork = metadata.conversationFork as Record<string, unknown>;
    const previous = fork.previous as Record<string, unknown>;
    current.metadata = {
      ...metadata,
      conversationFork: {
        ...fork,
        previous: { ...previous, targetSessionKey: "agent:main:foreign" },
      },
    };
    mocks.service.bind.mockClear();
    await expect(host().back()).resolves.toEqual({ status: "no_previous" });
    expect(mocks.service.bind).not.toHaveBeenCalled();
  });

  it("restores the source route when the fork replaced an unbound conversation", async () => {
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

  it("refuses Back when an unbound source chat is reassigned before removal", async () => {
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
    ).resolves.toMatchObject({
      status: "not_placed",
      effect: "session_only",
      forkSessionKey: "agent:main:dashboard:forked",
    });
    await expect(
      runtime.execute({ ticket: plan.ticket, placement: "current" }),
    ).resolves.toMatchObject({ status: "placed", placement: "current" });
    expect(mocks.createGatewaySession).toHaveBeenCalledTimes(1);
  });

  it("rejects a retained host after invocation closure", async () => {
    const controller = new AbortController();
    const runtime = createNativeConversationForkHost({
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
          __openclaw: {
            transport: {
              messageId: "telegram-41",
              channel: "telegram",
              conversationRef: "ref:source",
            },
          },
        },
      },
    ];
    const runtime = createNativeConversationForkHost({
      config: {},
      agentId: "main",
      sessionKey: "agent:main:source",
      conversation,
      replyToId: "telegram-41",
      replyConversationRef: "ref:source",
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
  });

  it("refuses reply replay without a live owner assertion", async () => {
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
    await expect(
      createForkHost({
        config: {},
        agentId: "main",
        sessionKey: "agent:main:source",
        conversation,
        replyToId: "telegram-41",
        signal: new AbortController().signal,
      }).prepare(),
    ).resolves.toEqual({ status: "blocked", reason: "owner_authority_unavailable" });
    expect(mocks.service.bind).not.toHaveBeenCalled();
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
      createNativeConversationForkHost({
        config: {},
        agentId: "main",
        sessionKey: "agent:main:source",
        conversation,
        replyToId: "telegram-41",
        signal: new AbortController().signal,
      }).prepare(),
    ).resolves.toEqual({ status: "blocked", reason: "reply_unavailable" });
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
    const runtime = createNativeConversationForkHost({
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
    const runtime = createNativeConversationForkHost({
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

  it("does not misrepresent an assistant reply as an exact user-turn fork", async () => {
    mocks.transcriptEvents = [
      {
        id: "assistant-entry",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Answer" }],
          __openclaw: { transport: { messageId: "telegram-answer", conversation } },
        },
      },
    ];
    const runtime = createNativeConversationForkHost({
      config: {},
      agentId: "main",
      sessionKey: "agent:main:source",
      conversation,
      replyToId: "telegram-answer",
      signal: new AbortController().signal,
    });
    await expect(runtime.prepare()).resolves.toEqual({
      status: "blocked",
      reason: "reply_unavailable",
    });
    expect(mocks.forkSessionAtMessage).not.toHaveBeenCalled();
  });

  it("rejects a colliding reply ID in another conversation or without provenance", async () => {
    mocks.transcriptEvents = [
      {
        id: "other",
        message: {
          role: "user",
          content: "private",
          __openclaw: {
            transport: {
              messageId: "telegram-41",
              channel: "telegram",
              conversationRef: "ref:other",
            },
          },
        },
      },
      {
        id: "unknown",
        message: {
          role: "user",
          content: "unscoped",
          __openclaw: {
            transport: {
              messageId: "telegram-41",
            },
          },
        },
      },
    ];
    const runtime = createNativeConversationForkHost({
      config: {},
      agentId: "main",
      sessionKey: "agent:main:source",
      conversation,
      replyToId: "telegram-41",
      replyConversationRef: "ref:source",
      signal: new AbortController().signal,
    });
    await expect(runtime.prepare()).resolves.toEqual({
      status: "blocked",
      reason: "reply_unavailable",
    });
    expect(mocks.forkSessionAtMessage).not.toHaveBeenCalled();
  });

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

  it("rejects a same-millisecond replacement of the source binding", async () => {
    mocks.current = {
      bindingId: "same-route",
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
      throw new Error("expected plan");
    }
    mocks.current = { ...mocks.current, generation: crypto.randomUUID() };
    await expect(runtime.execute({ ticket: plan.ticket, placement: "current" })).resolves.toEqual({
      status: "blocked",
      reason: "binding_changed",
    });
    expect(mocks.createGatewaySession).not.toHaveBeenCalled();
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
    await expect(
      runtime.execute({ ticket: plan.ticket, placement: "child" }),
    ).resolves.toMatchObject({
      status: "not_placed",
      effect: "session_only",
      forkSessionKey: "agent:main:dashboard:forked",
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
    const runtime = createNativeConversationForkHost({
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
    await expect(runtime.status()).resolves.toMatchObject({ status: "placed", replay: "unknown" });
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
    const runtime = createNativeConversationForkHost({
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

  it.each(["owner", "binding"] as const)(
    "blocks model admission when replay %s authority changes after placement",
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
        // SAFETY: this test controls the dispatcher mock input from the fork host.
        const replay = input as { replyResolver: () => Promise<unknown> };
        if (change === "owner") {
          authorized = false;
        } else {
          mocks.current = { ...mocks.current, generation: crypto.randomUUID() };
        }
        await replay.replyResolver();
        return { queuedFinal: true, counts: {} };
      });
      const runtime = createNativeConversationForkHost({
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
      ).resolves.toMatchObject({ status: "placed", replay: "ambiguous" });
      expect(mocks.resolveModel).not.toHaveBeenCalled();
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
      const runtime = createNativeConversationForkHost({
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
