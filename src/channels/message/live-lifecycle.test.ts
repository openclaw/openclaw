import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createChannelPartialDeliveryError } from "../turn/partial-delivery-error.js";
import {
  createLivePreviewLifecycle,
  createPreviewMessageReceipt,
  deliverWithFinalizableLivePreviewAdapter,
  type LivePreviewDeliveryResult,
} from "./live.js";

type Payload = { text: string };

function createPreviewHarness() {
  const posts = new Map([["preview", "Working"]]);
  let id: string | undefined = "preview";
  const draft = {
    flush: vi.fn(async () => {}),
    seal: vi.fn(async () => {}),
    discardPending: vi.fn(async () => {}),
    id: () => id,
    clear: vi.fn(async () => {
      if (id) {
        posts.delete(id);
        id = undefined;
      }
    }),
  };
  const send = vi.fn(async (payload: Payload): Promise<LivePreviewDeliveryResult> => {
    posts.set("final", payload.text);
    return {
      visibleReplySent: true,
      content: payload.text,
      receipt: createPreviewMessageReceipt({ id: "final" }),
    };
  });
  return { posts, draft, send };
}

describe("live preview delivery ownership", () => {
  it("protects a promoted answer when the published adapter receives a later final", async () => {
    const { posts, draft, send } = createPreviewHarness();
    const adapter = {
      draft,
      buildFinalEdit: (payload: Payload) => payload.text,
      editFinal: async (id: string, text: string) => {
        posts.set(id, text);
      },
    };
    const first = await deliverWithFinalizableLivePreviewAdapter({
      kind: "final",
      payload: { text: "answer" },
      adapter,
      deliverNormally: async (payload) => (await send(payload)).visibleReplySent,
    });
    await deliverWithFinalizableLivePreviewAdapter({
      kind: "final",
      payload: { text: "late warning" },
      adapter,
      liveState: first.liveState,
      deliverNormally: async (payload) => (await send(payload)).visibleReplySent,
    });
    expect([...posts.values()]).toEqual(["answer", "late warning"]);
    expect(draft.clear).not.toHaveBeenCalled();
  });

  it("records final acceptance before cleanup and never resends because deletion failed", async () => {
    const { posts, draft, send } = createPreviewHarness();
    const cleanupError = new Error("delete rejected");
    draft.clear.mockRejectedValueOnce(cleanupError);
    const onCleanupFailure = vi.fn();
    const lifecycle = createLivePreviewLifecycle<Payload, string>({ draft, onCleanupFailure });
    const result = await lifecycle.deliver({
      kind: "final",
      payload: { text: "answer" },
      deliverNormally: send,
    });
    expect(lifecycle.finalDelivered).toBe(true);
    expect(lifecycle.finalSucceeded).toBe(true);
    expect(lifecycle.previewFinalized).toBe(true);
    expect(result.deliveryResult?.receipt?.platformMessageIds).toEqual(["final"]);
    expect([...posts.values()]).toEqual(["Working", "answer"]);
    lifecycle.observeFailure();
    await lifecycle.cleanup({ failed: true });
    expect([...posts.values()]).toEqual(["answer"]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(onCleanupFailure).toHaveBeenCalledWith(cleanupError);
    expect(lifecycle.finalFailed).toBe(false);
  });

  it.each(["rejected", "suppressed", "partial"] as const)(
    "does not delete progress for a %s final",
    async (outcome) => {
      const { posts, draft, send } = createPreviewHarness();
      const lifecycle = createLivePreviewLifecycle<Payload, string>({ draft });
      if (outcome === "rejected") {
        send.mockRejectedValueOnce(new Error("final rejected"));
      } else if (outcome === "suppressed") {
        send.mockResolvedValueOnce({
          visibleReplySent: false,
          suppression: { reason: "no_visible_result" },
        });
      } else {
        send.mockImplementationOnce(async () => {
          posts.set("final", "accepted prefix");
          throw createChannelPartialDeliveryError(new Error("suffix rejected"), {
            visibleReplySent: true,
            receipt: createPreviewMessageReceipt({ id: "final" }),
          });
        });
      }
      const delivery = lifecycle.deliver({
        kind: "final",
        payload: { text: "answer" },
        deliverNormally: send,
      });
      if (outcome === "suppressed") {
        expect((await delivery).kind).toBe("normal-skipped");
      } else {
        await expect(delivery).rejects.toBeInstanceOf(Error);
      }
      await lifecycle.cleanup();
      expect(posts.get("preview")).toBe("Working");
      expect(lifecycle.finalDelivered).toBe(outcome === "partial");
      expect(lifecycle.finalFailed).toBe(outcome !== "suppressed");
      expect(send).toHaveBeenCalledTimes(1);
      expect(draft.clear).not.toHaveBeenCalled();
      expect(draft.discardPending).toHaveBeenCalled();
      expect(lifecycle.finalSucceeded).toBe(false);
    },
  );

  it("does not mistake an accepted progress receipt for a final-send receipt", async () => {
    const { draft, send } = createPreviewHarness();
    draft.discardPending.mockRejectedValueOnce(
      createChannelPartialDeliveryError(new Error("progress receipt missing"), {
        visibleReplySent: true,
        messageIds: [],
      }),
    );
    const lifecycle = createLivePreviewLifecycle<Payload, string>({ draft });
    await expect(
      lifecycle.deliver({ kind: "final", payload: { text: "answer" }, deliverNormally: send }),
    ).rejects.toMatchObject({ code: "CHANNEL_PARTIAL_DELIVERY" });
    expect(lifecycle.finalDelivered).toBe(false);
    expect(lifecycle.finalFailed).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });

  it("preserves promoted text and receipt when supplemental delivery is rejected", async () => {
    const { posts, draft, send } = createPreviewHarness();
    const lifecycle = createLivePreviewLifecycle<Payload, string>({ draft });
    send.mockRejectedValueOnce(new Error("media rejected"));
    await expect(
      lifecycle.deliver({
        kind: "final",
        payload: { text: "answer" },
        adapter: {
          buildFinalEdit: (payload) => payload.text,
          editFinal: async (id, text) => {
            posts.set(id, text);
          },
          buildSupplementalPayload: () => ({ text: "media" }),
        },
        deliverNormally: send,
      }),
    ).rejects.toMatchObject({
      code: "CHANNEL_PARTIAL_DELIVERY",
      deliveryResult: { receipt: { platformMessageIds: ["preview"] } },
    });
    await lifecycle.cleanup({ failed: true });
    expect(posts.get("preview")).toBe("answer");
    expect(lifecycle.finalDelivered).toBe(true);
    expect(lifecycle.finalFailed).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("does not retry intentionally suppressed supplemental media", async () => {
    const { posts, draft, send } = createPreviewHarness();
    const lifecycle = createLivePreviewLifecycle<Payload, string>({ draft });
    send.mockResolvedValueOnce({
      visibleReplySent: false,
      suppression: { reason: "channel_transform" },
    });
    const result = await lifecycle.deliver({
      kind: "final",
      payload: { text: "answer" },
      adapter: {
        buildFinalEdit: (payload) => payload.text,
        editFinal: async (id, text) => {
          posts.set(id, text);
        },
        buildSupplementalPayload: () => ({ text: "media" }),
      },
      deliverNormally: send,
    });
    expect(result.deliveryResult?.receipt?.platformMessageIds).toEqual(["preview"]);
    expect(posts.get("preview")).toBe("answer");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("settles observed source delivery without reviving a later failure", async () => {
    const { posts, draft, send } = createPreviewHarness();
    draft.clear.mockRejectedValueOnce(new Error("delete rejected"));
    const lifecycle = createLivePreviewLifecycle<Payload, string>({
      draft,
      onCleanupFailure: vi.fn(),
    });
    await lifecycle.observeDelivery({ visibleReplySent: false });
    expect(posts.has("preview")).toBe(true);
    posts.set("source-final", "tool-delivered answer");
    await lifecycle.observeDelivery({ visibleReplySent: true, messageIds: ["source-final"] });
    await lifecycle.deliver({
      kind: "final",
      payload: { text: "later warning" },
      adapter: {
        buildFinalEdit: (payload) => payload.text,
        editFinal: async (id, text) => {
          posts.set(id, text);
        },
      },
      deliverNormally: send,
    });
    lifecycle.observeFailure();
    await lifecycle.cleanup({ failed: true });
    expect([...posts.values()]).toEqual(["tool-delivered answer", "later warning"]);
    expect(lifecycle.finalDelivered).toBe(true);
    expect(lifecycle.finalFailed).toBe(false);
  });

  it("retains native progress until final acceptance, including accepted error policy", async () => {
    const { posts, draft } = createPreviewHarness();
    const onFinalDelivered = vi.fn();
    const lifecycle = createLivePreviewLifecycle<Payload, string>({
      draft,
      cleanupUndelivered: true,
      retainOnError: true,
      onFinalDelivered,
    });
    lifecycle.beginFinalDelivery();
    await lifecycle.cleanup();
    expect([...posts.values()]).toEqual(["Working"]);

    posts.set("native-final", "The task failed.");
    await lifecycle.observeDelivery(
      { visibleReplySent: true, messageIds: ["native-final"] },
      { isError: true },
    );
    lifecycle.observeFailure();
    await lifecycle.cleanup();
    expect([...posts.values()]).toEqual(["Working", "The task failed."]);
    expect(lifecycle.finalDelivered).toBe(true);
    expect(lifecycle.finalSucceeded).toBe(false);
    expect(lifecycle.finalFailed).toBe(false);
    expect(onFinalDelivered).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "does not suppress or clean a failed native final (partial=%s)",
    async (partial) => {
      const { posts, draft } = createPreviewHarness();
      const lifecycle = createLivePreviewLifecycle<Payload, string>({
        draft,
        cleanupUndelivered: true,
      });
      lifecycle.beginFinalDelivery();
      if (partial) {
        posts.set("native-prefix", "Accepted answer prefix");
      }
      lifecycle.observeFailure(
        partial ? { visibleReplySent: true, messageIds: ["native-prefix"] } : undefined,
      );
      lifecycle.observeSuppression();
      await lifecycle.cleanup();
      expect(posts.get("preview")).toBe("Working");
      expect(posts.get("native-prefix")).toBe(partial ? "Accepted answer prefix" : undefined);
      expect(lifecycle.finalDelivered).toBe(partial);
      expect(lifecycle.finalFailed).toBe(true);
      expect(lifecycle.finalSuppressed).toBe(false);
    },
  );

  it("settles explicit native suppression without claiming a visible final", async () => {
    const { posts, draft } = createPreviewHarness();
    const lifecycle = createLivePreviewLifecycle<Payload, string>({
      draft,
      cleanupUndelivered: true,
    });
    lifecycle.beginFinalDelivery();
    lifecycle.observeSuppression();
    await lifecycle.cleanup();
    expect([...posts.values()]).toEqual([]);
    expect(lifecycle.finalDelivered).toBe(false);
    expect(lifecycle.finalSuppressed).toBe(true);
    lifecycle.reset();
    expect(lifecycle.finalStarted).toBe(false);
    expect(lifecycle.finalSuppressed).toBe(false);
  });

  it.each(["send", "edit"] as const)(
    "does not apply a stale final %s receipt or observer to the next admitted turn",
    async (operation) => {
      const { posts, draft } = createPreviewHarness();
      const oldSend = createDeferred<LivePreviewDeliveryResult>();
      const started = createDeferred();
      const onFinalDelivered = vi.fn();
      const lifecycle = createLivePreviewLifecycle<Payload, string>({
        draft,
        onFinalDelivered,
        cleanupUndelivered: true,
      });
      const acceptOld = async () => {
        started.resolve();
        return oldSend.promise;
      };
      const terminalize = () => {
        posts.set("preview", "old turn complete");
      };
      const delivery = lifecycle.deliver({
        kind: "final",
        payload: { text: "old answer" },
        adapter:
          operation === "edit"
            ? {
                buildFinalEdit: (payload) => payload.text,
                editFinal: acceptOld,
                onPreviewFinalized: terminalize,
              }
            : undefined,
        deliverNormally: acceptOld,
        onNormalDelivered: terminalize,
      });
      await started.promise;
      await lifecycle.cleanup();
      expect(posts.get("preview")).toBe("Working");
      lifecycle.reset();
      posts.set("preview", "new turn progress");
      oldSend.resolve({ visibleReplySent: true, messageIds: ["old-final"] });
      expect((await delivery).deliveryResult?.messageIds).toEqual(["old-final"]);
      expect(posts.get("preview")).toBe("new turn progress");
      expect(lifecycle.finalDelivered).toBe(false);
      expect(onFinalDelivered).not.toHaveBeenCalled();
      expect(draft.clear).not.toHaveBeenCalled();
    },
  );

  it("does not seal the next turn after an old preview flush settles", async () => {
    const { posts, draft, send } = createPreviewHarness();
    const flushStarted = createDeferred();
    const finishFlush = createDeferred();
    draft.flush.mockImplementationOnce(async () => {
      flushStarted.resolve();
      await finishFlush.promise;
    });
    const lifecycle = createLivePreviewLifecycle<Payload, string>({ draft });
    const editFinal = vi.fn(async (id: string, text: string) => {
      posts.set(id, text);
    });
    const delivery = lifecycle.deliver({
      kind: "final",
      payload: { text: "old answer" },
      adapter: { buildFinalEdit: (payload) => payload.text, editFinal },
      deliverNormally: send,
    });
    await flushStarted.promise;
    lifecycle.reset();
    posts.set("preview", "new turn progress");
    finishFlush.resolve();
    expect((await delivery).kind).toBe("normal-skipped");
    expect(posts.get("preview")).toBe("new turn progress");
    expect(draft.seal).not.toHaveBeenCalled();
    expect(editFinal).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps the next turn writable when an old final edit is rejected", async () => {
    const { posts, draft, send } = createPreviewHarness();
    const editStarted = createDeferred();
    const finishEdit = createDeferred();
    let writable = true;
    draft.discardPending.mockImplementation(async () => {
      writable = false;
    });
    const lifecycle = createLivePreviewLifecycle<Payload, string>({ draft });
    const delivery = lifecycle.deliver({
      kind: "final",
      payload: { text: "old answer" },
      adapter: {
        buildFinalEdit: (payload) => payload.text,
        editFinal: async () => {
          editStarted.resolve();
          await finishEdit.promise;
        },
      },
      deliverNormally: send,
    });
    await editStarted.promise;
    lifecycle.reset();
    posts.set("preview", "new turn progress");
    finishEdit.reject(new Error("old edit rejected"));
    expect((await delivery).kind).toBe("normal-skipped");
    if (writable) {
      posts.set("preview", "new turn updated");
    }
    expect(posts.get("preview")).toBe("new turn updated");
    expect(send).not.toHaveBeenCalled();
  });

  it("does not infer final delivery when preview custody is transferred", async () => {
    const { posts, draft } = createPreviewHarness();
    const lifecycle = createLivePreviewLifecycle<Payload, string>({
      draft,
      cleanupUndelivered: true,
    });
    lifecycle.retainPreview();
    await lifecycle.cleanup();
    expect(posts.get("preview")).toBe("Working");
    expect(lifecycle.finalDelivered).toBe(false);
    expect(draft.clear).not.toHaveBeenCalled();
  });
});
