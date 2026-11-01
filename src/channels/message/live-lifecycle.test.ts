import { describe, expect, it, vi, type Mock } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createChannelPartialDeliveryError } from "../turn/partial-delivery-error.js";
import {
  createLivePreviewLifecycle,
  createPreviewMessageReceipt,
  deliverWithFinalizableLivePreviewAdapter,
  type LivePreviewDeliveryResult,
} from "./live.js";
import type { LiveMessageState } from "./types.js";

type Payload = { text: string };

function expectUncalled(...mocks: Mock[]) {
  for (const mock of mocks) {
    expect(mock).not.toHaveBeenCalled();
  }
}

const accepted = (id: string) => ({ visibleReplySent: true, messageIds: [id] });

function setup(options: Parameters<typeof createLivePreviewLifecycle<Payload, string>>[0] = {}) {
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
  const lifecycle = createLivePreviewLifecycle<Payload, string>({ draft, ...options });
  const deliver = (
    text = "answer",
    overrides: Partial<Parameters<typeof lifecycle.deliver<string>>[0]> = {},
  ) => lifecycle.deliver({ kind: "final", payload: { text }, deliverNormally: send, ...overrides });
  const publish = (text: string, liveState?: LiveMessageState<Payload>) =>
    deliverWithFinalizableLivePreviewAdapter({
      kind: "final",
      payload: { text },
      adapter,
      liveState,
      deliverNormally: async (payload) => (await send(payload)).visibleReplySent,
    });
  return { posts, draft, send, adapter, lifecycle, deliver, publish };
}

describe("live preview delivery ownership", () => {
  it("protects a promoted answer when the published adapter receives a later final", async () => {
    const { posts, draft, publish } = setup();
    const first = await publish("answer");
    await publish("late warning", first.liveState);
    expect([...posts.values()]).toEqual(["answer", "late warning"]);
    expect(draft.clear).not.toHaveBeenCalled();
  });

  it.each(["send", "observe"] as const)(
    "preserves %s acceptance through failed cleanup and later failure",
    async (source) => {
      const cleanupError = new Error("delete rejected");
      const onCleanupFailure = vi.fn();
      const { posts, draft, send, adapter, lifecycle, deliver } = setup({ onCleanupFailure });
      draft.clear.mockRejectedValueOnce(cleanupError);
      if (source === "observe") {
        await lifecycle.observeDelivery({ visibleReplySent: false });
        expect(posts.has("preview")).toBe(true);
        posts.set("source-final", "tool-delivered answer");
        await lifecycle.observeDelivery(accepted("source-final"));
        await deliver("later warning", { adapter });
      } else {
        const result = await deliver();
        expect(lifecycle.previewFinalized).toBe(true);
        expect(result.deliveryResult?.receipt?.platformMessageIds).toEqual(["final"]);
        expect([...posts.values()]).toEqual(["Working", "answer"]);
      }
      expect(lifecycle).toMatchObject({ finalDelivered: true, finalSucceeded: true });
      lifecycle.observeFailure();
      await lifecycle.cleanup({ failed: true });
      expect([...posts.values()]).toEqual(
        source === "send" ? ["answer"] : ["tool-delivered answer", "later warning"],
      );
      expect(send).toHaveBeenCalledTimes(1);
      expect(onCleanupFailure).toHaveBeenCalledWith(cleanupError);
      expect(lifecycle).toMatchObject({ finalDelivered: true, finalFailed: false });
    },
  );

  it.each([
    ["rejected", false],
    ["suppressed", false],
    ["partial", false],
    ["progress-receipt", false],
    ["rejected", true],
    ["suppressed", true],
  ] as const)(
    "preserves preview custody for %s delivery (promoted: %s)",
    async (outcome, promoted) => {
      const { posts, draft, send, adapter, lifecycle, deliver } = setup();
      if (outcome === "progress-receipt") {
        draft.discardPending.mockRejectedValueOnce(
          createChannelPartialDeliveryError(new Error("progress receipt missing"), {
            visibleReplySent: true,
            messageIds: [],
          }),
        );
      } else if (outcome === "rejected") {
        send.mockRejectedValueOnce(new Error(promoted ? "media rejected" : "final rejected"));
      } else if (outcome === "suppressed") {
        send.mockResolvedValueOnce({
          visibleReplySent: false,
          suppression: { reason: promoted ? "channel_transform" : "no_visible_result" },
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
      const delivery = deliver("answer", {
        adapter: promoted
          ? { ...adapter, buildSupplementalPayload: () => ({ text: "media" }) }
          : undefined,
      });
      if (outcome === "suppressed") {
        const result = await delivery;
        expect(result).toMatchObject(
          promoted
            ? { deliveryResult: { receipt: { platformMessageIds: ["preview"] } } }
            : { kind: "normal-skipped" },
        );
      } else if (promoted) {
        await expect(delivery).rejects.toMatchObject({
          code: "CHANNEL_PARTIAL_DELIVERY",
          deliveryResult: { receipt: { platformMessageIds: ["preview"] } },
        });
        await lifecycle.cleanup({ failed: true });
        expect(lifecycle).toMatchObject({ finalDelivered: true, finalFailed: true });
      } else if (outcome === "progress-receipt") {
        await expect(delivery).rejects.toMatchObject({ code: "CHANNEL_PARTIAL_DELIVERY" });
      } else {
        await expect(delivery).rejects.toBeInstanceOf(Error);
      }
      if (!promoted) {
        await lifecycle.cleanup();
        expect(lifecycle).toMatchObject({
          finalDelivered: outcome === "partial",
          finalFailed: outcome !== "suppressed",
          finalSucceeded: false,
        });
        expect(draft.clear).not.toHaveBeenCalled();
        expect(draft.discardPending).toHaveBeenCalled();
      }
      expect(posts.get("preview")).toBe(promoted ? "answer" : "Working");
      expect(send).toHaveBeenCalledTimes(outcome === "progress-receipt" ? 0 : 1);
    },
  );

  it.each(["error", "failed", "partial", "suppressed"] as const)(
    "keeps native final facts and cleanup consistent for %s delivery",
    async (outcome) => {
      const onFinalDelivered = vi.fn();
      const { posts, lifecycle } = setup({
        cleanupUndelivered: true,
        retainOnError: outcome === "error",
        onFinalDelivered,
      });
      lifecycle.beginFinalDelivery();
      if (outcome === "error") {
        await lifecycle.cleanup();
        expect([...posts.values()]).toEqual(["Working"]);
        posts.set("native-final", "failed");
        await lifecycle.observeDelivery(accepted("native-final"), { isError: true });
        lifecycle.observeFailure();
      } else {
        if (outcome === "partial") {
          posts.set("native-prefix", "prefix");
        }
        if (outcome !== "suppressed") {
          lifecycle.observeFailure(outcome === "partial" ? accepted("native-prefix") : undefined);
        }
        lifecycle.observeSuppression();
      }
      await lifecycle.cleanup();
      const expectedPosts = {
        error: { preview: "Working", "native-final": "failed" },
        failed: { preview: "Working" },
        partial: { preview: "Working", "native-prefix": "prefix" },
        suppressed: {},
      };
      expect([...posts]).toEqual(Object.entries(expectedPosts[outcome]));
      expect(lifecycle).toMatchObject({
        finalDelivered: outcome === "error" || outcome === "partial",
        finalSucceeded: false,
        finalFailed: outcome === "failed" || outcome === "partial",
        finalSuppressed: outcome === "suppressed",
      });
      expect(onFinalDelivered).not.toHaveBeenCalled();
      if (outcome === "suppressed") {
        lifecycle.reset();
        expect(lifecycle).toMatchObject({ finalStarted: false, finalSuppressed: false });
      }
    },
  );

  it.each(["send", "edit", "flush", "rejected-edit"] as const)(
    "fences a stale %s completion from the next admitted turn",
    async (operation) => {
      const finish = createDeferred<LivePreviewDeliveryResult>();
      const started = createDeferred();
      const onFinalDelivered = vi.fn();
      const acceptsReceipt = operation === "send" || operation === "edit";
      const { posts, draft, send, adapter, lifecycle, deliver } = setup({
        cleanupUndelivered: acceptsReceipt,
        onFinalDelivered,
      });
      let writable = true;
      if (operation === "rejected-edit") {
        draft.discardPending.mockImplementation(async () => {
          writable = false;
        });
      }
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
      const delivery = deliver("old answer", {
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
        finish.resolve(accepted("old-final"));
      }
      const result = await delivery;
      expect(result).toMatchObject(
        acceptsReceipt
          ? { deliveryResult: { messageIds: ["old-final"] } }
          : { kind: "normal-skipped" },
      );
      if (operation === "rejected-edit" && writable) {
        posts.set("preview", "new turn updated");
      }
      expect(posts.get("preview")).toBe(
        operation === "rejected-edit" ? "new turn updated" : "new turn progress",
      );
      expect(lifecycle.finalDelivered).toBe(false);
      expectUncalled(onFinalDelivered, draft.clear, send);
      if (operation === "flush") {
        expectUncalled(draft.seal, adapter.editFinal);
      }
    },
  );

  it("does not infer final delivery when preview custody is transferred", async () => {
    const { posts, draft, lifecycle } = setup({ cleanupUndelivered: true });
    lifecycle.retainPreview();
    await lifecycle.cleanup();
    expect(posts.get("preview")).toBe("Working");
    expect(lifecycle.finalDelivered).toBe(false);
    expect(draft.clear).not.toHaveBeenCalled();
  });
});
