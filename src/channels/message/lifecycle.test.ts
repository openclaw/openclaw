import { describe, expect, it, vi } from "vitest";
import {
  createLiveMessageState,
  defineFinalizableLivePreviewAdapter,
  deliverFinalizableLivePreview,
  deliverWithFinalizableLivePreviewAdapter,
  markLiveMessagePreviewUpdated,
  type LivePreviewFinalizerDraft,
} from "./live.js";
import { createMessageReceiveContext } from "./receive.js";

type LivePreviewMediaPayload = { text?: string; mediaUrl: string };
type LivePreviewMediaEdit = { text?: string };

function createDraft(
  id: string,
  overrides: Partial<LivePreviewFinalizerDraft<string>> = {},
): LivePreviewFinalizerDraft<string> {
  return {
    flush: vi.fn(async () => undefined),
    id: () => id,
    clear: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("message lifecycle primitives", () => {
  it("tracks live preview rendered batch updates", () => {
    const preview = createLiveMessageState();
    const rendered = {
      payloads: [{ text: "draft" }],
      plan: {
        payloadCount: 1,
        textCount: 1,
        mediaCount: 0,
        voiceCount: 0,
        presentationCount: 0,
        interactiveCount: 0,
        channelDataCount: 0,
        items: [{ index: 0, kinds: ["text"] as const, text: "draft", mediaUrls: [] }],
      },
    };

    const updated = markLiveMessagePreviewUpdated(preview, rendered);
    expect(updated.phase).toBe("previewing");
    expect(updated.lastRendered).toBe(rendered);
  });

  it("finalizes live previews in place with preview receipts", async () => {
    const editFinal = vi.fn(async () => undefined);
    const deliverNormally = vi.fn(async () => undefined);
    const onPreviewFinalized = vi.fn(async () => undefined);

    const result = await deliverFinalizableLivePreview({
      kind: "final",
      payload: { text: "done" },
      draft: createDraft("preview-1", { seal: vi.fn(async () => undefined) }),
      buildFinalEdit: (payload) => ({ text: payload.text }),
      editFinal,
      deliverNormally,
      onPreviewFinalized,
    });

    expect(result.kind).toBe("preview-finalized");
    expect(editFinal).toHaveBeenCalledWith("preview-1", { text: "done" });
    expect(deliverNormally).not.toHaveBeenCalled();
    const liveState = result.liveState;
    if (!liveState) {
      throw new Error("expected finalized live state");
    }
    expect(liveState.phase).toBe("finalized");
    expect(liveState.canFinalizeInPlace).toBe(false);
    expect(liveState.receipt?.primaryPlatformMessageId).toBe("preview-1");
    expect(liveState.receipt?.platformMessageIds).toEqual(["preview-1"]);
    expect(onPreviewFinalized).toHaveBeenCalledExactlyOnceWith(
      "preview-1",
      expect.objectContaining({ primaryPlatformMessageId: "preview-1" }),
      expect.toSatisfy((state: unknown) => state === liveState),
    );
  });

  it("delivers supplemental payloads after finalizing live previews", async () => {
    const editFinal = vi.fn(async () => undefined);
    const deliverNormally = vi.fn(async () => undefined);
    const deliverSupplemental = vi.fn(async () => true);

    const result = await deliverFinalizableLivePreview<
      LivePreviewMediaPayload,
      string,
      LivePreviewMediaEdit
    >({
      kind: "final",
      payload: { text: "done", mediaUrl: "file:///tmp/reply.mp3" },
      draft: createDraft("preview-1", { seal: vi.fn(async () => undefined) }),
      buildFinalEdit: (payload) => ({ text: payload.text }),
      buildSupplementalPayload: (payload) => ({ mediaUrl: payload.mediaUrl }),
      editFinal,
      deliverNormally,
      deliverSupplemental,
    });

    expect(result.kind).toBe("preview-finalized");
    expect(editFinal).toHaveBeenCalledWith("preview-1", { text: "done" });
    expect(deliverNormally).not.toHaveBeenCalled();
    expect(deliverSupplemental).toHaveBeenCalledWith({ mediaUrl: "file:///tmp/reply.mp3" });
  });

  it("falls back to normal supplemental delivery when its dedicated sender reports no send", async () => {
    const deliverNormally = vi.fn(async () => true);
    const deliverSupplemental = vi.fn(async () => false);

    const result = await deliverFinalizableLivePreview<
      LivePreviewMediaPayload,
      string,
      LivePreviewMediaEdit
    >({
      kind: "final",
      payload: { text: "done", mediaUrl: "file:///tmp/reply.mp3" },
      draft: createDraft("preview-supplement-fallback"),
      buildFinalEdit: (payload) => ({ text: payload.text }),
      editFinal: vi.fn(async () => undefined),
      buildSupplementalPayload: (payload) => ({ mediaUrl: payload.mediaUrl }),
      deliverSupplemental,
      deliverNormally,
    });

    expect(result.kind).toBe("preview-finalized");
    expect(deliverSupplemental).toHaveBeenCalledWith({ mediaUrl: "file:///tmp/reply.mp3" });
    expect(deliverNormally).toHaveBeenCalledWith({ mediaUrl: "file:///tmp/reply.mp3" });
  });

  it("uses normal delivery when a finalized preview has no supplemental sender", async () => {
    const deliverNormally = vi.fn(async () => true);

    const result = await deliverFinalizableLivePreview<
      LivePreviewMediaPayload,
      string,
      LivePreviewMediaEdit
    >({
      kind: "final",
      payload: { text: "done", mediaUrl: "file:///tmp/reply.mp3" },
      draft: createDraft("preview-no-supplement-sender"),
      buildFinalEdit: (payload) => ({ text: payload.text }),
      editFinal: vi.fn(async () => undefined),
      buildSupplementalPayload: (payload) => ({ mediaUrl: payload.mediaUrl }),
      deliverNormally,
    });

    expect(result.kind).toBe("preview-finalized");
    expect(deliverNormally).toHaveBeenCalledWith({ mediaUrl: "file:///tmp/reply.mp3" });
  });

  it("surfaces supplemental delivery failure after both sender paths report no send", async () => {
    await expect(
      deliverFinalizableLivePreview<LivePreviewMediaPayload, string, LivePreviewMediaEdit>({
        kind: "final",
        payload: { text: "done", mediaUrl: "file:///tmp/reply.mp3" },
        draft: createDraft("preview-supplement-unsent"),
        buildFinalEdit: (payload) => ({ text: payload.text }),
        editFinal: vi.fn(async () => undefined),
        buildSupplementalPayload: (payload) => ({ mediaUrl: payload.mediaUrl }),
        deliverSupplemental: vi.fn(async () => false),
        deliverNormally: vi.fn(async () => false),
      }),
    ).rejects.toThrow("Live preview supplemental payload was not delivered");
  });

  it("treats live preview fallback delivery as terminal state", async () => {
    const discardPending = vi.fn(async () => undefined);
    const clear = vi.fn(async () => undefined);
    const deliverNormally = vi.fn(async () => true);
    const onNormalDelivered = vi.fn(async () => undefined);

    const result = await deliverFinalizableLivePreview({
      kind: "final",
      payload: { text: "with media" },
      draft: createDraft("preview-2", { discardPending, clear }),
      buildFinalEdit: () => undefined,
      editFinal: vi.fn(async () => undefined),
      deliverNormally,
      onNormalDelivered,
    });

    expect(result.kind).toBe("normal-delivered");
    expect(discardPending).toHaveBeenCalledTimes(1);
    expect(deliverNormally).toHaveBeenCalledWith({ text: "with media" });
    expect(onNormalDelivered).toHaveBeenCalledTimes(1);
    expect(clear).toHaveBeenCalledTimes(1);
    const liveState = result.liveState;
    if (!liveState) {
      throw new Error("expected fallback live state");
    }
    expect(liveState.phase).toBe("cancelled");
    expect(liveState.canFinalizeInPlace).toBe(false);
  });

  it("preserves committed normal delivery when preview cleanup fails through the adapter", async () => {
    const events: string[] = [];
    const cleanupError = new Error("recipient text and fake-secret must stay private");
    const draft = {
      flush: vi.fn(async () => undefined),
      id: () => "preview-cleanup-failure",
      discardPending: vi.fn(async () => {
        events.push("discard");
      }),
      clear: vi.fn(async () => {
        events.push("clear");
        throw cleanupError;
      }),
    };
    const deliverNormally = vi.fn(async () => {
      events.push("deliver");
      return true;
    });
    const onNormalDelivered = vi.fn(async () => {
      events.push("commit");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const result = await deliverWithFinalizableLivePreviewAdapter({
        kind: "final",
        payload: { text: "already delivered" },
        adapter: defineFinalizableLivePreviewAdapter({
          draft,
          buildFinalEdit: () => undefined,
          editFinal: vi.fn(async () => undefined),
        }),
        deliverNormally,
        onNormalDelivered,
      });

      expect(result.kind).toBe("normal-delivered");
      expect(events).toEqual(["discard", "deliver", "commit", "clear"]);
      expect(deliverNormally).toHaveBeenCalledTimes(1);
      expect(onNormalDelivered).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        "Live preview cleanup failed after delivery; a stale preview may remain",
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("keeps intentionally suppressed fallback delivery skipped without post-delivery cleanup", async () => {
    const clear = vi.fn(async () => {
      throw new Error("suppressed reply must not be cleaned up as delivered");
    });
    const onNormalDelivered = vi.fn(async () => undefined);

    const result = await deliverFinalizableLivePreview({
      kind: "final",
      payload: { text: "suppressed" },
      draft: {
        flush: vi.fn(async () => undefined),
        id: () => "suppressed-preview",
        discardPending: vi.fn(async () => undefined),
        clear,
      },
      buildFinalEdit: () => undefined,
      editFinal: vi.fn(async () => undefined),
      deliverNormally: vi.fn(async () => false),
      onNormalDelivered,
    });

    expect(result.kind).toBe("normal-skipped");
    expect(onNormalDelivered).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });

  it("keeps preview cleanup failures fatal before normal delivery starts", async () => {
    const deliverNormally = vi.fn(async () => true);
    const onNormalDelivered = vi.fn(async () => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await expect(
        deliverFinalizableLivePreview({
          kind: "final",
          payload: { text: "not delivered" },
          draft: {
            flush: vi.fn(async () => undefined),
            id: () => "pre-delivery-preview",
            clear: vi.fn(async () => {
              throw new Error("pre-delivery cleanup failed");
            }),
          },
          buildFinalEdit: () => undefined,
          editFinal: vi.fn(async () => undefined),
          deliverNormally,
          onNormalDelivered,
        }),
      ).rejects.toThrow("pre-delivery cleanup failed");

      expect(deliverNormally).not.toHaveBeenCalled();
      expect(onNormalDelivered).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("preserves a delivery-commit failure when later preview cleanup also fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await expect(
        deliverFinalizableLivePreview({
          kind: "final",
          payload: { text: "already accepted" },
          draft: {
            flush: vi.fn(async () => undefined),
            id: () => "commit-failure-preview",
            discardPending: vi.fn(async () => undefined),
            clear: vi.fn(async () => {
              throw new Error("preview cleanup must not replace delivery failure");
            }),
          },
          buildFinalEdit: () => undefined,
          editFinal: vi.fn(async () => undefined),
          deliverNormally: vi.fn(async () => true),
          onNormalDelivered: vi.fn(async () => {
            throw new Error("delivery commit failed");
          }),
        }),
      ).rejects.toThrow("delivery commit failed");

      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("does not complete live preview fallback state when normal delivery throws", async () => {
    const discardPending = vi.fn(async () => undefined);
    const clear = vi.fn(async () => undefined);
    const onNormalDelivered = vi.fn(async () => undefined);

    await expect(
      deliverFinalizableLivePreview({
        kind: "final",
        payload: { text: "with media" },
        draft: createDraft("preview-2", { discardPending, clear }),
        buildFinalEdit: () => undefined,
        editFinal: vi.fn(async () => undefined),
        deliverNormally: vi.fn(async () => {
          throw new Error("send failed");
        }),
        onNormalDelivered,
      }),
    ).rejects.toThrow("send failed");

    expect(discardPending).toHaveBeenCalledTimes(1);
    expect(onNormalDelivered).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });

  it("delivers through finalizable live preview adapters", async () => {
    const editFinal = vi.fn(async () => undefined);
    const adapter = defineFinalizableLivePreviewAdapter({
      draft: createDraft("preview-adapter-1"),
      buildFinalEdit: (payload: { text: string }) => ({ text: payload.text.toUpperCase() }),
      editFinal,
    });

    const result = await deliverWithFinalizableLivePreviewAdapter({
      kind: "final",
      payload: { text: "done" },
      adapter,
      deliverNormally: vi.fn(async () => undefined),
    });

    expect(result.kind).toBe("preview-finalized");
    expect(editFinal).toHaveBeenCalledWith("preview-adapter-1", { text: "DONE" });
  });

  it("lets live preview adapters resolve the committed platform id after final edit", async () => {
    const adapter = defineFinalizableLivePreviewAdapter({
      draft: createDraft("preview-before-edit"),
      buildFinalEdit: (payload: { text: string }) => ({ text: payload.text }),
      editFinal: vi.fn(async () => undefined),
      resolveFinalizedId: () => "message-after-edit",
    });

    const result = await deliverWithFinalizableLivePreviewAdapter({
      kind: "final",
      payload: { text: "done" },
      adapter,
      deliverNormally: vi.fn(async () => undefined),
    });

    expect(result.liveState?.receipt?.primaryPlatformMessageId).toBe("message-after-edit");
  });

  it("falls back to normal delivery when no live preview adapter is available", async () => {
    const deliverNormally = vi.fn(async () => undefined);

    const result = await deliverWithFinalizableLivePreviewAdapter({
      kind: "final",
      payload: { text: "plain" },
      deliverNormally,
    });

    expect(result.kind).toBe("normal-delivered");
    expect(deliverNormally).toHaveBeenCalledWith({ text: "plain" });
  });

  it("lets live preview adapters retain ambiguous failed final edits without fallback send", async () => {
    const deliverNormally = vi.fn(async () => undefined);
    const handlePreviewEditError = vi.fn(() => "retain" as const);
    const editError = new Error("timeout after request");
    const adapter = defineFinalizableLivePreviewAdapter({
      draft: createDraft("preview-maybe-final"),
      buildFinalEdit: (payload: { text: string }) => ({ text: payload.text }),
      editFinal: vi.fn(async () => {
        throw editError;
      }),
      handlePreviewEditError,
    });

    const result = await deliverWithFinalizableLivePreviewAdapter({
      kind: "final",
      payload: { text: "done" },
      adapter,
      deliverNormally,
    });

    expect(result.kind).toBe("preview-retained");
    expect(result.liveState?.phase).toBe("previewing");
    expect(deliverNormally).not.toHaveBeenCalled();
    expect(handlePreviewEditError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        error: expect.toSatisfy((error: unknown) => error === editError),
        id: "preview-maybe-final",
        edit: { text: "done" },
        payload: { text: "done" },
      }),
    );
  });

  it("does not fallback-send after a successful preview edit when finalization hooks fail", async () => {
    const deliverNormally = vi.fn(async () => undefined);
    const onPreviewFinalized = vi.fn(async () => {
      throw new Error("receipt side effect failed");
    });
    const editFinal = vi.fn(async () => undefined);

    await expect(
      deliverFinalizableLivePreview({
        kind: "final",
        payload: { text: "done" },
        draft: createDraft("preview-finalized-before-hook", { seal: vi.fn(async () => undefined) }),
        buildFinalEdit: (payload) => ({ text: payload.text }),
        editFinal,
        deliverNormally,
        onPreviewFinalized,
      }),
    ).rejects.toThrow("receipt side effect failed");

    expect(editFinal).toHaveBeenCalledWith("preview-finalized-before-hook", { text: "done" });
    expect(deliverNormally).not.toHaveBeenCalled();
  });

  it("creates receive contexts with explicit ack policy defaults", () => {
    const ctx = createMessageReceiveContext({
      id: "rx-1",
      channel: "telegram",
      message: { text: "hello" },
      receivedAt: 123,
    });

    expect(ctx.id).toBe("rx-1");
    expect(ctx.channel).toBe("telegram");
    expect(ctx.message).toEqual({ text: "hello" });
    expect(ctx.ackPolicy).toBe("after_receive_record");
    expect(ctx.ackState).toBe("pending");
    expect(ctx.receivedAt).toBe(123);
  });

  it("acks and nacks receive contexts through explicit hooks", async () => {
    const onAck = vi.fn(async () => undefined);
    const onNack = vi.fn(async () => undefined);
    const ctx = createMessageReceiveContext({
      id: "rx-ack",
      channel: "telegram",
      message: { text: "hello" },
      ackPolicy: "after_durable_send",
      onAck,
      onNack,
    });

    expect(ctx.shouldAckAfter("receive_record")).toBe(false);
    expect(ctx.shouldAckAfter("durable_send")).toBe(true);

    const beforeAck = Date.now();
    await ctx.ack();
    await ctx.ack();
    expect(onAck).toHaveBeenCalledTimes(1);
    expect(ctx.ackState).toBe("acked");
    expect(ctx.ackedAt).toBeGreaterThanOrEqual(beforeAck);

    const nackError = new Error("offset failed");
    await ctx.nack(nackError);
    await ctx.nack(new Error("duplicate failure"));
    expect(onNack).toHaveBeenCalledTimes(1);
    expect(onNack).toHaveBeenCalledWith(nackError);
    expect(ctx.ackState).toBe("nacked");
    expect(ctx.nackErrorMessage).toBe("offset failed");
  });

  it("retries nack callbacks after a failed attempt", async () => {
    const onNack = vi
      .fn<(error: unknown) => Promise<void>>()
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce();
    const ctx = createMessageReceiveContext({
      id: "rx-nack-retry",
      channel: "telegram",
      message: { text: "hello" },
      onNack,
    });

    await expect(ctx.nack(new Error("first failure"))).rejects.toThrow("temporary failure");
    expect(ctx.ackState).toBe("pending");

    const retryError = new Error("retry failure");
    await ctx.nack(retryError);

    expect(onNack).toHaveBeenCalledTimes(2);
    expect(ctx.ackState).toBe("nacked");
    expect(ctx.nackErrorMessage).toBe("retry failure");
  });

  it("coalesces overlapping nack callbacks and retains the first error", async () => {
    let resolveNack: (() => void) | undefined;
    const onNack = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveNack = resolve;
        }),
    );
    const ctx = createMessageReceiveContext({
      id: "rx-nack-overlap",
      channel: "telegram",
      message: { text: "hello" },
      onNack,
    });
    const firstError = new Error("first failure");

    const first = ctx.nack(firstError);
    const duplicate = ctx.nack(new Error("duplicate failure"));
    await vi.waitFor(() => expect(onNack).toHaveBeenCalledOnce());
    resolveNack?.();
    await Promise.all([first, duplicate]);

    expect(onNack).toHaveBeenCalledWith(firstError);
    expect(ctx.ackState).toBe("nacked");
    expect(ctx.nackErrorMessage).toBe("first failure");
  });
});
