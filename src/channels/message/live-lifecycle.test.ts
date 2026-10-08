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
  const adapter = {
    draft,
    buildFinalEdit: (payload: Payload) => payload.text,
    editFinal: vi.fn(async (messageId: string, text: string) => {
      posts.set(messageId, text);
    }),
  };
  return { posts, draft, send, adapter };
}

describe("live preview delivery ownership", () => {
  it("protects a promoted answer when the published adapter receives a later final", async () => {
    const { posts, draft, send, adapter } = createPreviewHarness();
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

  it.each(["send", "observe"] as const)(
    "preserves %s acceptance through failed cleanup and later failure",
    async (source) => {
      const { posts, draft, send, adapter } = createPreviewHarness();
      const cleanupError = new Error("delete rejected");
      draft.clear.mockRejectedValueOnce(cleanupError);
      const onCleanupFailure = vi.fn();
      const lifecycle = createLivePreviewLifecycle<Payload, string>({ draft, onCleanupFailure });
      if (source === "observe") {
        await lifecycle.observeDelivery({ visibleReplySent: false });
        expect(posts.has("preview")).toBe(true);
        posts.set("source-final", "tool-delivered answer");
        await lifecycle.observeDelivery({ visibleReplySent: true, messageIds: ["source-final"] });
        await lifecycle.deliver({
          kind: "final",
          payload: { text: "later warning" },
          adapter,
          deliverNormally: send,
        });
      } else {
        const result = await lifecycle.deliver({
          kind: "final",
          payload: { text: "answer" },
          deliverNormally: send,
        });
        expect(lifecycle.previewFinalized).toBe(true);
        expect(result.deliveryResult?.receipt?.platformMessageIds).toEqual(["final"]);
        expect([...posts.values()]).toEqual(["Working", "answer"]);
      }
      expect(lifecycle.finalDelivered).toBe(true);
      expect(lifecycle.finalSucceeded).toBe(true);
      lifecycle.observeFailure();
      await lifecycle.cleanup({ failed: true });
      expect([...posts.values()]).toEqual(
        source === "send" ? ["answer"] : ["tool-delivered answer", "later warning"],
      );
      expect(send).toHaveBeenCalledTimes(1);
      expect(onCleanupFailure).toHaveBeenCalledWith(cleanupError);
      expect(lifecycle.finalDelivered).toBe(true);
      expect(lifecycle.finalFailed).toBe(false);
    },
  );

  it.each(["rejected", "suppressed", "partial", "progress-receipt"] as const)(
    "does not delete progress for a %s final",
    async (outcome) => {
      const { posts, draft, send } = createPreviewHarness();
      const lifecycle = createLivePreviewLifecycle<Payload, string>({ draft });
      if (outcome === "progress-receipt") {
        draft.discardPending.mockRejectedValueOnce(
          createChannelPartialDeliveryError(new Error("progress receipt missing"), {
            visibleReplySent: true,
            messageIds: [],
          }),
        );
      } else if (outcome === "rejected") {
        send.mockRejectedValueOnce(new Error("final rejected"));
      } else if (outcome === "suppressed") {
        send.mockResolvedValueOnce({
          visibleReplySent: false,
          suppression: { reason: "no_visible_result" },
        });
      } else if (outcome === "partial") {
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
      } else if (outcome === "progress-receipt") {
        await expect(delivery).rejects.toMatchObject({ code: "CHANNEL_PARTIAL_DELIVERY" });
      } else {
        await expect(delivery).rejects.toBeInstanceOf(Error);
      }
      await lifecycle.cleanup();
      expect(posts.get("preview")).toBe("Working");
      expect(lifecycle.finalDelivered).toBe(outcome === "partial");
      expect(lifecycle.finalFailed).toBe(outcome !== "suppressed");
      expect(send).toHaveBeenCalledTimes(outcome === "progress-receipt" ? 0 : 1);
      expect(draft.clear).not.toHaveBeenCalled();
      expect(draft.discardPending).toHaveBeenCalled();
      expect(lifecycle.finalSucceeded).toBe(false);
    },
  );

  it.each(["rejected", "suppressed"] as const)(
    "preserves promoted text and receipt when supplemental delivery is %s",
    async (outcome) => {
      const { posts, draft, send, adapter } = createPreviewHarness();
      const lifecycle = createLivePreviewLifecycle<Payload, string>({ draft });
      if (outcome === "rejected") {
        send.mockRejectedValueOnce(new Error("media rejected"));
      } else {
        send.mockResolvedValueOnce({
          visibleReplySent: false,
          suppression: { reason: "channel_transform" },
        });
      }
      const delivery = lifecycle.deliver({
        kind: "final",
        payload: { text: "answer" },
        adapter: {
          ...adapter,
          buildSupplementalPayload: () => ({ text: "media" }),
        },
        deliverNormally: send,
      });
      if (outcome === "rejected") {
        await expect(delivery).rejects.toMatchObject({
          code: "CHANNEL_PARTIAL_DELIVERY",
          deliveryResult: { receipt: { platformMessageIds: ["preview"] } },
        });
        await lifecycle.cleanup({ failed: true });
        expect(lifecycle.finalDelivered).toBe(true);
        expect(lifecycle.finalFailed).toBe(true);
      } else {
        expect((await delivery).deliveryResult?.receipt?.platformMessageIds).toEqual(["preview"]);
      }
      expect(posts.get("preview")).toBe("answer");
      expect(send).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["error", "failed", "partial", "suppressed"] as const)(
    "keeps native final facts and cleanup consistent for %s delivery",
    async (outcome) => {
      const { posts, draft } = createPreviewHarness();
      const onFinalDelivered = vi.fn();
      const lifecycle = createLivePreviewLifecycle<Payload, string>({
        draft,
        cleanupUndelivered: true,
        retainOnError: outcome === "error",
        onFinalDelivered,
      });
      lifecycle.beginFinalDelivery();
      if (outcome === "error") {
        await lifecycle.cleanup();
        expect([...posts.values()]).toEqual(["Working"]);
        posts.set("native-final", "The task failed.");
        await lifecycle.observeDelivery(
          { visibleReplySent: true, messageIds: ["native-final"] },
          { isError: true },
        );
        lifecycle.observeFailure();
      } else {
        if (outcome === "partial") {
          posts.set("native-prefix", "Accepted answer prefix");
        }
        if (outcome !== "suppressed") {
          lifecycle.observeFailure(
            outcome === "partial"
              ? { visibleReplySent: true, messageIds: ["native-prefix"] }
              : undefined,
          );
        }
        lifecycle.observeSuppression();
      }
      await lifecycle.cleanup();
      expect([...posts.values()]).toEqual(
        outcome === "suppressed"
          ? []
          : outcome === "error"
            ? ["Working", "The task failed."]
            : outcome === "partial"
              ? ["Working", "Accepted answer prefix"]
              : ["Working"],
      );
      expect(lifecycle.finalDelivered).toBe(outcome === "error" || outcome === "partial");
      expect(lifecycle.finalSucceeded).toBe(false);
      expect(lifecycle.finalFailed).toBe(outcome === "failed" || outcome === "partial");
      expect(lifecycle.finalSuppressed).toBe(outcome === "suppressed");
      expect(onFinalDelivered).not.toHaveBeenCalled();
      if (outcome === "failed" || outcome === "partial") {
        expect(posts.get("preview")).toBe("Working");
        expect(posts.get("native-prefix")).toBe(
          outcome === "partial" ? "Accepted answer prefix" : undefined,
        );
      }
      if (outcome === "suppressed") {
        lifecycle.reset();
        expect(lifecycle.finalStarted).toBe(false);
        expect(lifecycle.finalSuppressed).toBe(false);
      }
    },
  );

  it.each(["send", "edit", "flush", "rejected-edit"] as const)(
    "fences a stale %s completion from the next admitted turn",
    async (operation) => {
      const { posts, draft, send, adapter } = createPreviewHarness();
      const finish = createDeferred<LivePreviewDeliveryResult>();
      const started = createDeferred();
      const onFinalDelivered = vi.fn();
      const acceptsReceipt = operation === "send" || operation === "edit";
      let writable = true;
      if (operation === "rejected-edit") {
        draft.discardPending.mockImplementation(async () => {
          writable = false;
        });
      }
      const lifecycle = createLivePreviewLifecycle<Payload, string>({
        draft,
        onFinalDelivered,
        cleanupUndelivered: acceptsReceipt,
      });
      const acceptOld = async () => {
        started.resolve();
        return finish.promise;
      };
      if (operation === "flush") {
        draft.flush.mockImplementationOnce(async () => {
          await acceptOld();
        });
      }
      const terminalize = () => {
        posts.set("preview", "old turn complete");
      };
      const delivery = lifecycle.deliver({
        kind: "final",
        payload: { text: "old answer" },
        adapter:
          operation === "send"
            ? undefined
            : {
                ...adapter,
                ...(operation === "flush" ? {} : { editFinal: acceptOld }),
                onPreviewFinalized: terminalize,
              },
        deliverNormally: operation === "send" ? acceptOld : send,
        onNormalDelivered: terminalize,
      });
      await started.promise;
      if (acceptsReceipt) {
        await lifecycle.cleanup();
        expect(posts.get("preview")).toBe("Working");
      }
      lifecycle.reset();
      posts.set("preview", "new turn progress");
      if (operation === "rejected-edit") {
        finish.reject(new Error("old edit rejected"));
      } else {
        finish.resolve({ visibleReplySent: true, messageIds: ["old-final"] });
      }
      const result = await delivery;
      if (acceptsReceipt) {
        expect(result.deliveryResult?.messageIds).toEqual(["old-final"]);
      } else {
        expect(result.kind).toBe("normal-skipped");
      }
      if (operation === "rejected-edit" && writable) {
        posts.set("preview", "new turn updated");
      }
      expect(posts.get("preview")).toBe(
        operation === "rejected-edit" ? "new turn updated" : "new turn progress",
      );
      expect(lifecycle.finalDelivered).toBe(false);
      expect(onFinalDelivered).not.toHaveBeenCalled();
      expect(draft.clear).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
      if (operation === "flush") {
        expect(draft.seal).not.toHaveBeenCalled();
        expect(adapter.editFinal).not.toHaveBeenCalled();
      }
    },
  );

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
