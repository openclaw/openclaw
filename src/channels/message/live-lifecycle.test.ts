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

  it("delivers a separate final without promoting the preview", async () => {
    const { posts, draft, send } = createPreviewHarness();
    const editFinal = vi.fn(async (id: string, text: string) => {
      posts.set(id, text);
    });
    const lifecycle = createLivePreviewLifecycle<Payload, string>({
      draft,
      finalDelivery: "separate",
    });
    const result = await lifecycle.deliver({
      kind: "final",
      payload: { text: "answer" },
      adapter: { buildFinalEdit: (payload) => payload.text, editFinal },
      deliverNormally: send,
    });
    expect(result.kind).toBe("normal-delivered");
    expect(editFinal).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledOnce();
    expect([...posts.values()]).toEqual(["answer"]);
  });

  it("continues separate final delivery after a partial progress settlement", async () => {
    const { posts, draft, send } = createPreviewHarness();
    const progressError = createChannelPartialDeliveryError(new Error("progress receipt missing"), {
      visibleReplySent: true,
      messageIds: [],
    });
    draft.discardPending.mockRejectedValueOnce(progressError);
    const onDiscardPendingPartialFailure = vi.fn();
    const lifecycle = createLivePreviewLifecycle<Payload, string>({
      draft,
      finalDelivery: "separate",
      onDiscardPendingPartialFailure,
    });
    await lifecycle.deliver({
      kind: "final",
      payload: { text: "answer" },
      deliverNormally: send,
    });
    expect(send).toHaveBeenCalledOnce();
    expect(posts.get("final")).toBe("answer");
    expect(onDiscardPendingPartialFailure).toHaveBeenCalledWith(progressError);
  });

  it.each(["rejected", "empty", "observed"] as const)(
    "settles the final failure presenter for a %s failure",
    async (outcome) => {
      const { draft, send } = createPreviewHarness();
      const onFinalFailure = vi.fn(async () => {});
      const lifecycle = createLivePreviewLifecycle<Payload, string>({ draft, onFinalFailure });
      if (outcome === "rejected") {
        send.mockRejectedValueOnce(new Error("send rejected"));
        await expect(
          lifecycle.deliver({ kind: "final", payload: { text: "answer" }, deliverNormally: send }),
        ).rejects.toThrow("send rejected");
      } else if (outcome === "empty") {
        send.mockResolvedValueOnce({ visibleReplySent: false });
        await lifecycle.deliver({
          kind: "final",
          payload: { text: "answer" },
          deliverNormally: send,
        });
      } else {
        lifecycle.observeFailure();
      }
      await lifecycle.cleanup();
      expect(onFinalFailure).toHaveBeenCalledOnce();
      expect(lifecycle.finalFailed).toBe(true);
    },
  );

  it("does not present failure for an intentionally suppressed final", async () => {
    const { draft, send } = createPreviewHarness();
    const onFinalFailure = vi.fn(async () => {});
    send.mockResolvedValueOnce({
      visibleReplySent: false,
      suppression: { reason: "no_visible_result" },
    });
    const lifecycle = createLivePreviewLifecycle<Payload, string>({ draft, onFinalFailure });
    await lifecycle.deliver({
      kind: "final",
      payload: { text: "reasoning only" },
      deliverNormally: send,
    });
    await lifecycle.cleanup();
    expect(onFinalFailure).not.toHaveBeenCalled();
    expect(lifecycle.finalFailed).toBe(false);
  });

  it("surfaces a failed failure presentation when no final became visible", async () => {
    const { draft, send } = createPreviewHarness();
    const presentationError = new Error("terminal progress was not retained");
    const onFinalFailureError = vi.fn();
    send.mockResolvedValueOnce({ visibleReplySent: false });
    const lifecycle = createLivePreviewLifecycle<Payload, string>({
      draft,
      onFinalFailure: async () => {
        throw presentationError;
      },
      onFinalFailureError,
    });
    await expect(
      lifecycle.deliver({
        kind: "final",
        payload: { text: "answer" },
        deliverNormally: send,
      }),
    ).rejects.toBe(presentationError);
    expect(onFinalFailureError).toHaveBeenCalledExactlyOnceWith(presentationError);
  });

  it("settles one failure presentation across error delivery and later observers", async () => {
    const { draft, send } = createPreviewHarness();
    const onFinalFailure = vi.fn(async () => {});
    const lifecycle = createLivePreviewLifecycle<Payload, string>({
      draft,
      retainOnError: true,
      onFinalFailure,
    });
    await lifecycle.deliver({
      kind: "final",
      payload: { text: "error" },
      isError: true,
      deliverNormally: send,
    });
    lifecycle.observeFailure();
    await lifecycle.cleanup({ failed: true });
    expect(onFinalFailure).toHaveBeenCalledOnce();
  });

  it("retries a failed failure presentation at a later settlement boundary", async () => {
    const { draft, send } = createPreviewHarness();
    const onFinalFailure = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("status update rejected"))
      .mockResolvedValueOnce();
    send.mockRejectedValueOnce(new Error("final rejected"));
    const lifecycle = createLivePreviewLifecycle<Payload, string>({
      draft,
      onFinalFailure,
      onFinalFailureError: vi.fn(),
    });
    await expect(
      lifecycle.deliver({ kind: "final", payload: { text: "answer" }, deliverNormally: send }),
    ).rejects.toThrow("final rejected");
    await lifecycle.cleanup();
    expect(onFinalFailure).toHaveBeenCalledTimes(2);
  });

  it("does not present failure for a stale rejected generation", async () => {
    const { draft } = createPreviewHarness();
    const oldSend = createDeferred<LivePreviewDeliveryResult>();
    const started = createDeferred();
    const onFinalFailure = vi.fn(async () => {});
    const lifecycle = createLivePreviewLifecycle<Payload, string>({ draft, onFinalFailure });
    const delivery = lifecycle.deliver({
      kind: "final",
      payload: { text: "old answer" },
      deliverNormally: async () => {
        started.resolve();
        return await oldSend.promise;
      },
    });
    await started.promise;
    lifecycle.reset();
    oldSend.reject(new Error("old final rejected"));
    await expect(delivery).rejects.toThrow("old final rejected");
    expect(onFinalFailure).not.toHaveBeenCalled();
  });

  it("does not present a queued failure after the generation resets", async () => {
    const { draft } = createPreviewHarness();
    const onFinalFailure = vi.fn(async () => {});
    const lifecycle = createLivePreviewLifecycle<Payload, string>({ draft, onFinalFailure });

    lifecycle.observeFailure();
    lifecycle.reset();
    await Promise.resolve();

    expect(onFinalFailure).not.toHaveBeenCalled();
  });

  it("does not present a queued failure after a final becomes accepted", async () => {
    const { draft } = createPreviewHarness();
    const onFinalFailure = vi.fn(async () => {});
    const lifecycle = createLivePreviewLifecycle<Payload, string>({ draft, onFinalFailure });

    lifecycle.observeFailure();
    await lifecycle.observeDelivery({
      visibleReplySent: true,
      receipt: createPreviewMessageReceipt({ id: "final" }),
    });

    expect(onFinalFailure).not.toHaveBeenCalled();
  });

  it("does not let failed cleanup cross into a replacement generation", async () => {
    const { draft } = createPreviewHarness();
    const failureStarted = createDeferred();
    const releaseFailure = createDeferred();
    const lifecycle = createLivePreviewLifecycle<Payload, string>({
      draft,
      onFinalFailure: async () => {
        failureStarted.resolve();
        await releaseFailure.promise;
      },
    });

    lifecycle.observeFailure();
    const cleanup = lifecycle.cleanup({ failed: true });
    await failureStarted.promise;
    lifecycle.reset();
    releaseFailure.resolve();
    await cleanup;

    expect(draft.discardPending).not.toHaveBeenCalled();
    expect(draft.clear).not.toHaveBeenCalled();
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

  it.each([
    {
      name: "visible final",
      result: { visibleReplySent: true, messageIds: ["final"] },
      delivered: true,
      failed: false,
      suppressed: false,
      previewRetained: false,
    },
    {
      name: "intentional suppression",
      result: {
        visibleReplySent: false,
        suppression: { reason: "channel_transform" as const },
      },
      delivered: false,
      failed: false,
      suppressed: true,
      previewRetained: false,
    },
    {
      name: "no-visible failure",
      result: { visibleReplySent: false },
      delivered: false,
      failed: true,
      suppressed: false,
      previewRetained: true,
    },
  ])(
    "classifies an actual provider $name settlement",
    async ({ result, delivered, failed, suppressed, previewRetained }) => {
      const { posts, draft } = createPreviewHarness();
      const onFinalStarted = vi.fn();
      const onFinalFailure = vi.fn(async () => {});
      const lifecycle = createLivePreviewLifecycle<Payload, string>({
        draft,
        cleanupUndelivered: true,
        onFinalStarted,
        onFinalFailure,
      });

      await lifecycle.observeSettlement(result);
      await lifecycle.cleanup();

      expect(lifecycle.finalDelivered).toBe(delivered);
      expect(lifecycle.finalFailed).toBe(failed);
      expect(lifecycle.finalSuppressed).toBe(suppressed);
      expect(posts.has("preview")).toBe(previewRetained);
      expect(onFinalStarted).toHaveBeenCalledOnce();
      expect(onFinalFailure).toHaveBeenCalledTimes(failed ? 1 : 0);
    },
  );

  it("keeps legacy void settlement as accepted delivery", async () => {
    const { posts, draft } = createPreviewHarness();
    const lifecycle = createLivePreviewLifecycle<Payload, string>({
      draft,
      cleanupUndelivered: true,
    });

    await lifecycle.observeSettlement(undefined);

    expect(lifecycle.finalSucceeded).toBe(true);
    expect(posts.has("preview")).toBe(false);
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
