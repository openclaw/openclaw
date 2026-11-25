import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  createLiveMessageState,
  defineFinalizableLivePreviewAdapter,
  deliverWithFinalizableLivePreviewAdapter,
  markLiveMessagePreviewUpdated,
} from "./live.js";
import { createMessageReceiveContext } from "./receive.js";

type MediaPayload = { text?: string; mediaUrl: string };
type PreviewAdapter<TPayload, TEdit> = Parameters<
  typeof defineFinalizableLivePreviewAdapter<TPayload, string, TEdit>
>[0];
type PreviewDraft = NonNullable<
  Parameters<typeof defineFinalizableLivePreviewAdapter<unknown, string, unknown>>[0]["draft"]
>;

afterEach(() => vi.restoreAllMocks());

function mediaAdapter(
  id: string,
  overrides: Partial<PreviewAdapter<MediaPayload, { text?: string }>> = {},
) {
  return {
    draft: createDraft(id),
    buildFinalEdit: (payload: MediaPayload) => ({ text: payload.text }),
    editFinal: vi.fn(async () => undefined),
    buildSupplementalPayload: (payload: MediaPayload) => ({ mediaUrl: payload.mediaUrl }),
    ...overrides,
  };
}

function createDraft(id: string, overrides: Partial<PreviewDraft> = {}): PreviewDraft {
  return {
    flush: vi.fn(async () => undefined),
    id: () => id,
    clear: vi.fn(async () => undefined),
    ...overrides,
  };
}

type TextAdapter = PreviewAdapter<{ text: string }, { text: string }>;
type TextDelivery = Parameters<
  typeof deliverWithFinalizableLivePreviewAdapter<{ text: string }, string, { text: string }>
>[0];

function deliverText(overrides: Partial<TextDelivery> = {}) {
  return deliverWithFinalizableLivePreviewAdapter({
    kind: "final",
    payload: { text: "done" },
    deliverNormally: vi.fn(async () => undefined),
    ...overrides,
  });
}

function fallback(options: Partial<TextDelivery> & { draft?: Partial<PreviewDraft> } = {}) {
  const draft = createDraft("preview", options.draft);
  const deliverNormally = vi.fn(async () => true);
  const onNormalDelivered = vi.fn(async () => undefined);
  return {
    draft,
    deliverNormally,
    onNormalDelivered,
    deliver: () =>
      deliverText({
        adapter: createAdapter(draft, { buildFinalEdit: () => undefined }),
        deliverNormally,
        onNormalDelivered,
        ...options,
      }),
  };
}

function rejects(message: string) {
  return vi.fn(async () => {
    throw new Error(message);
  });
}

function createAdapter(draft: PreviewDraft, overrides: Partial<TextAdapter> = {}): TextAdapter {
  return {
    draft,
    buildFinalEdit: (payload) => ({ text: payload.text }),
    editFinal: vi.fn(async () => undefined),
    ...overrides,
  };
}

function receiveContext(options: Partial<Parameters<typeof createMessageReceiveContext>[0]>) {
  return createMessageReceiveContext({
    id: "rx-test",
    channel: "telegram",
    message: { text: "hello" },
    ...options,
  });
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
    const draft = createDraft("preview-1", { seal: vi.fn(async () => undefined) });
    const result = await deliverText({
      adapter: createAdapter(draft, { editFinal, onPreviewFinalized }),
      deliverNormally,
    });
    expect(result.kind).toBe("preview-finalized");
    expect(draft.flush).toHaveBeenCalledTimes(1);
    expect(draft.seal).toHaveBeenCalledTimes(1);
    expect(editFinal).toHaveBeenCalledWith("preview-1", { text: "done" });
    expect(deliverNormally).not.toHaveBeenCalled();
    expect(draft.clear).not.toHaveBeenCalled();
    expect(result.liveState).toMatchObject({
      phase: "finalized",
      canFinalizeInPlace: false,
      receipt: { primaryPlatformMessageId: "preview-1", platformMessageIds: ["preview-1"] },
    });
    expect(onPreviewFinalized).toHaveBeenCalledExactlyOnceWith(
      "preview-1",
      expect.objectContaining({ primaryPlatformMessageId: "preview-1" }),
      expect.toSatisfy((state: unknown) => state === result.liveState),
    );
  });

  it("delivers supplemental payloads after finalizing live previews", async () => {
    const editFinal = vi.fn(async () => undefined);
    const deliverNormally = vi.fn(async () => undefined);
    const deliverSupplemental = vi.fn(async () => true);

    const result = await deliverWithFinalizableLivePreviewAdapter<
      MediaPayload,
      string,
      { text?: string }
    >({
      kind: "final",
      payload: { text: "done", mediaUrl: "file:///tmp/reply.mp3" },
      adapter: {
        draft: createDraft("preview-1", { seal: vi.fn(async () => undefined) }),
        buildFinalEdit: (payload) => ({ text: payload.text }),
        buildSupplementalPayload: (payload) => ({ mediaUrl: payload.mediaUrl }),
        editFinal,
        deliverSupplemental,
      },
      deliverNormally,
    });

    expect(result.kind).toBe("preview-finalized");
    expect(editFinal).toHaveBeenCalledWith("preview-1", { text: "done" });
    expect(deliverNormally).not.toHaveBeenCalled();
    expect(deliverSupplemental).toHaveBeenCalledWith({ mediaUrl: "file:///tmp/reply.mp3" });
  });

  it("falls back to normal supplemental delivery when its dedicated sender reports no send", async () => {
    const deliverNormally = vi.fn(async () => true);
    const deliverSupplemental = vi.fn(async () => false);

    const result = await deliverWithFinalizableLivePreviewAdapter<
      MediaPayload,
      string,
      { text?: string }
    >({
      kind: "final",
      payload: { text: "done", mediaUrl: "file:///tmp/reply.mp3" },
      adapter: {
        draft: createDraft("preview-supplement-fallback"),
        buildFinalEdit: (payload) => ({ text: payload.text }),
        editFinal: vi.fn(async () => undefined),
        buildSupplementalPayload: (payload) => ({ mediaUrl: payload.mediaUrl }),
        deliverSupplemental,
      },
      deliverNormally,
    });

    expect(result.kind).toBe("preview-finalized");
    expect(deliverSupplemental).toHaveBeenCalledWith({ mediaUrl: "file:///tmp/reply.mp3" });
    expect(deliverNormally).toHaveBeenCalledWith({ mediaUrl: "file:///tmp/reply.mp3" });
  });

  it("uses normal delivery when a finalized preview has no supplemental sender", async () => {
    const deliverNormally = vi.fn(async () => true);
    const result = await deliverWithFinalizableLivePreviewAdapter({
      kind: "final",
      payload: { text: "done", mediaUrl: "file:///tmp/reply.mp3" },
      adapter: mediaAdapter("preview-no-supplement-sender"),
      deliverNormally,
    });
    expect(result.kind).toBe("preview-finalized");
    expect(deliverNormally).toHaveBeenCalledWith({ mediaUrl: "file:///tmp/reply.mp3" });
  });

  it("surfaces supplemental delivery failure after both sender paths report no send", async () => {
    await expect(
      deliverWithFinalizableLivePreviewAdapter({
        kind: "final",
        payload: { text: "done", mediaUrl: "file:///tmp/reply.mp3" },
        adapter: mediaAdapter("preview-supplement-unsent", {
          deliverSupplemental: vi.fn(async () => false),
        }),
        deliverNormally: vi.fn(async () => false),
      }),
    ).rejects.toThrow("Live preview supplemental payload was not delivered");
  });

  it.each(["non-finalizable payload", "failed preview edit"] as const)(
    "treats live preview fallback delivery as terminal state after a %s",
    async (reason) => {
      const discardPending = vi.fn(async () => undefined);
      const clear = vi.fn(async () => undefined);
      const deliverNormally = vi.fn(async () => true);
      const onNormalDelivered = vi.fn(async () => undefined);
      const draft = createDraft("preview-2", { discardPending, clear });
      const editFails = reason === "failed preview edit";
      const editFinal = vi.fn(async () => {
        throw new Error("preview edit failed");
      });

      const result = await deliverWithFinalizableLivePreviewAdapter({
        kind: "final",
        payload: { text: "with media" },
        adapter: {
          draft,
          buildFinalEdit: (payload) => (editFails ? { text: payload.text } : undefined),
          editFinal,
        },
        deliverNormally,
        onNormalDelivered,
      });

      expect(result.kind).toBe("normal-delivered");
      expect(draft.flush).toHaveBeenCalledTimes(editFails ? 1 : 0);
      expect(editFinal).toHaveBeenCalledTimes(editFails ? 1 : 0);
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
    },
  );

  it("preserves committed normal delivery when preview cleanup fails through the adapter", async () => {
    const events: string[] = [];
    const cleanupError = new Error("recipient text and fake-secret must stay private");
    const draft = createDraft("preview-cleanup-failure", {
      discardPending: vi.fn(async () => {
        events.push("discard");
      }),
      clear: vi.fn(async () => {
        events.push("clear");
        throw cleanupError;
      }),
    });
    const deliverNormally = vi.fn(async () => {
      events.push("deliver");
      return true;
    });
    const onNormalDelivered = vi.fn(async () => {
      events.push("commit");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await deliverText({
      adapter: defineFinalizableLivePreviewAdapter(
        createAdapter(draft, { buildFinalEdit: () => undefined }),
      ),
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
  });

  it("keeps intentionally suppressed fallback delivery skipped without post-delivery cleanup", async () => {
    const clear = rejects("suppressed reply must not be cleaned up as delivered");
    const { deliver, onNormalDelivered } = fallback({
      draft: { discardPending: vi.fn(async () => undefined), clear },
      deliverNormally: vi.fn(async () => false),
    });
    const result = await deliver();
    expect(result.kind).toBe("normal-skipped");
    expect(onNormalDelivered).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });

  it("keeps preview cleanup failures fatal before normal delivery starts", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { deliver, deliverNormally, onNormalDelivered } = fallback({
      draft: { clear: rejects("pre-delivery cleanup failed") },
    });
    await expect(deliver()).rejects.toThrow("pre-delivery cleanup failed");
    expect(deliverNormally).not.toHaveBeenCalled();
    expect(onNormalDelivered).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("preserves a delivery-commit failure when later preview cleanup also fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { deliver } = fallback({
      draft: {
        discardPending: vi.fn(async () => undefined),
        clear: rejects("preview cleanup must not replace delivery failure"),
      },
      onNormalDelivered: rejects("delivery commit failed"),
    });
    await expect(deliver()).rejects.toThrow("delivery commit failed");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("does not complete live preview fallback state when normal delivery throws", async () => {
    const { deliver, draft, onNormalDelivered } = fallback({
      draft: { discardPending: vi.fn(async () => undefined) },
      deliverNormally: rejects("send failed"),
    });
    await expect(deliver()).rejects.toThrow("send failed");
    expect(draft.discardPending).toHaveBeenCalledTimes(1);
    expect(onNormalDelivered).not.toHaveBeenCalled();
    expect(draft.clear).not.toHaveBeenCalled();
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
    const adapter = defineFinalizableLivePreviewAdapter(
      createAdapter(createDraft("preview-before-edit"), {
        resolveFinalizedId: () => "message-after-edit",
      }),
    );
    const result = await deliverText({ adapter });
    expect(result.liveState?.receipt?.primaryPlatformMessageId).toBe("message-after-edit");
  });

  it("falls back to normal delivery when no live preview adapter is available", async () => {
    const deliverNormally = vi.fn(async () => undefined);
    const result = await deliverText({ payload: { text: "plain" }, deliverNormally });
    expect(result.kind).toBe("normal-delivered");
    expect(deliverNormally).toHaveBeenCalledWith({ text: "plain" });
  });

  it("lets live preview adapters retain ambiguous failed final edits without fallback send", async () => {
    const deliverNormally = vi.fn(async () => undefined);
    const handlePreviewEditError = vi.fn(() => "retain" as const);
    const editError = new Error("timeout after request");
    const adapter = defineFinalizableLivePreviewAdapter(
      createAdapter(createDraft("preview-maybe-final"), {
        editFinal: vi.fn(async () => {
          throw editError;
        }),
        handlePreviewEditError,
      }),
    );
    const result = await deliverText({ adapter, deliverNormally });
    expect(result).toMatchObject({ kind: "preview-retained", liveState: { phase: "previewing" } });
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
      deliverWithFinalizableLivePreviewAdapter({
        kind: "final",
        payload: { text: "done" },
        adapter: {
          draft: createDraft("preview-finalized-before-hook", {
            seal: vi.fn(async () => undefined),
          }),
          buildFinalEdit: (payload) => ({ text: payload.text }),
          editFinal,
          onPreviewFinalized,
        },
        deliverNormally,
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
    const ctx = receiveContext({ ackPolicy: "after_durable_send", onAck, onNack });
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
    expect(onNack).toHaveBeenCalledExactlyOnceWith(nackError);
    expect(ctx).toMatchObject({ ackState: "nacked", nackErrorMessage: "offset failed" });
  });

  it("retries nack callbacks after a failed attempt", async () => {
    const onNack = vi
      .fn<(error: unknown) => Promise<void>>()
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce();
    const ctx = receiveContext({ onNack });
    await expect(ctx.nack(new Error("first failure"))).rejects.toThrow("temporary failure");
    expect(ctx.ackState).toBe("pending");
    const retryError = new Error("retry failure");
    await ctx.nack(retryError);
    expect(onNack).toHaveBeenCalledTimes(2);
    expect(ctx).toMatchObject({ ackState: "nacked", nackErrorMessage: "retry failure" });
  });

  it("coalesces overlapping nack callbacks and retains the first error", async () => {
    const pendingNack = createDeferred();
    const onNack = vi.fn(() => pendingNack.promise);
    const ctx = receiveContext({ onNack });
    const firstError = new Error("first failure");
    const first = ctx.nack(firstError);
    const duplicate = ctx.nack(new Error("duplicate failure"));
    await vi.waitFor(() => expect(onNack).toHaveBeenCalledOnce());
    pendingNack.resolve();
    await Promise.all([first, duplicate]);
    expect(onNack).toHaveBeenCalledWith(firstError);
    expect(ctx).toMatchObject({ ackState: "nacked", nackErrorMessage: "first failure" });
  });
});
