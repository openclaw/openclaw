import { expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { canReloadControlUiDocument } from "../../app/document-reload-guard.ts";
import {
  retryStaleChunkReloadWhenReachable,
  scheduleStaleChunkReload,
} from "../../app/stale-chunk-reload.ts";
import { listStoredChatOutboxes } from "../../lib/chat/outbox-store-projection.ts";
import { showToast } from "../../lib/toast.ts";
import {
  createApplicationGateway,
  createApplicationGatewaySnapshot,
} from "../../test-helpers/application-context-fixtures.ts";
import {
  getChatAttachmentDataUrl,
  registerChatAttachmentPayload,
} from "./attachment-payload-store.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { chatOutboxOwner } from "./chat-outbox-owner.ts";
import { removeQueuedMessage } from "./chat-queue.ts";
import { handleSendChat } from "./chat-send-submit.ts";
import { reviewPrivateComposerDraft } from "./components/private-composer-recovery-dialog.tsx";
import { useChatSendBrowserFixture } from "./outbox-browser.test-support.ts";
import { beginQueuedMessageEdit, cancelQueuedMessageEdit } from "./queued-message-edit.ts";

vi.mock("./components/private-composer-recovery-dialog.tsx", async (original) => ({
  ...(await original<typeof import("./components/private-composer-recovery-dialog.tsx")>()),
  reviewPrivateComposerDraft: vi.fn(),
  preloadPrivateComposerRecovery: vi.fn(async () => undefined),
}));
vi.mock("../../lib/toast.ts", async (original) => ({
  ...(await original<typeof import("../../lib/toast.ts")>()),
  showToast: vi.fn(() => true),
}));
vi.mock("../../app/stale-chunk-reload.ts", async (original) => ({
  ...(await original<typeof import("../../app/stale-chunk-reload.ts")>()),
  retryStaleChunkReloadWhenReachable: vi.fn(async () => true),
}));

useChatSendBrowserFixture();

it("retains memory-only pending input across automatic reloads after its pane and account retire", async () => {
  // Only message persistence fails: the reload-loop guard can still be stored.
  const write = sessionStorage.setItem.bind(sessionStorage);
  vi.spyOn(sessionStorage, "setItem").mockImplementation((key, value) => {
    if (key.startsWith("openclaw.control.chatComposer.v4:")) {
      throw new DOMException("Synthetic outbox quota", "QuotaExceededError");
    }
    write(key, value);
  });
  const host = makeChatHost({
    chatMessage: "Keep the only copy of this pending message",
    requestHandlers: {
      "chat.send": () => {
        throw new Error("gateway closed (1006)");
      },
    },
  });
  let account = "reload-original-account";
  vi.spyOn(host.client!, "recoveryScope", "get").mockImplementation(() => account);
  const owner = chatOutboxOwner(host);
  const stop = owner.subscribe(host);
  onTestFinished(stop);
  await handleSendChat(host);
  const pending = host.chatQueue[0]!;
  expect(pending).toMatchObject({
    text: "Keep the only copy of this pending message",
    sendState: "waiting-reconnect",
  });
  expect(host.chatMessage).toBe("");
  expect(listStoredChatOutboxes(host)).toEqual([]);
  stop();
  account = "reload-other-account";
  chatOutboxOwner(host).syncHost(host);
  expect(host.chatQueue).toEqual([]);
  const reload = vi.fn();
  const probe = vi.fn(async () => new Response(null, { status: 200 }));
  vi.stubGlobal("fetch", probe);
  expect(await scheduleStaleChunkReload({ reload })).toBe(false);
  expect(reload).not.toHaveBeenCalled();
  expect(probe).not.toHaveBeenCalled();
  account = "reload-original-account";
  owner.syncHost(host);
  expect(host.chatQueue[0]).toMatchObject({
    id: pending.id,
    text: pending.text,
    sendRunId: pending.sendRunId,
  });
  removeQueuedMessage(host, pending.id, { discard: true });
  expect(await scheduleStaleChunkReload({ reload })).toBe(true);
  expect(reload).toHaveBeenCalledOnce();
});

it("reviews retired-pane custody without discarding a changed row, an edit, or another account", async () => {
  const host = makeChatHost({ requestHandlers: {} });
  let account = "review-original-account";
  vi.spyOn(host.client!, "recoveryScope", "get").mockImplementation(() => account);
  const events = createApplicationGateway(
    createApplicationGatewaySnapshot({ client: host.client, phase: "connected" }),
  );
  host.settings.gatewayUrl = events.gateway.connection.gatewayUrl;
  host.outboxRecovery = { gateway: events.gateway, retainedAttachmentIds: () => new Set() };
  const owner = chatOutboxOwner(host);
  const onDiscard = vi.fn();
  const stop = owner.subscribe(host, onDiscard);
  onTestFinished(stop);
  const attachment = registerChatAttachmentPayload({
    attachment: { id: "shared-recovery-payload", mimeType: "text/plain" },
    dataUrl: "data:text/plain;base64,a2VlcA==",
    file: new File(["keep"], "keep.txt", { type: "text/plain" }),
  });
  const item = owner.keep(
    host,
    { sessionKey: host.sessionKey },
    {
      id: "recovery-unsubmitted-row",
      text: "retained recovery text",
      attachments: [attachment],
      createdAt: 1,
    },
    true,
  );
  events.publish({ ...events.gateway.snapshot, phase: "reload-required" });
  const open = async () => {
    expect(canReloadControlUiDocument(true)).toBe(false);
    const action = vi.mocked(showToast).mock.calls.at(-1)?.[0].onAction;
    expect(action).toBeTypeOf("function");
    action!();
    await Promise.resolve();
    await Promise.resolve();
  };
  const review = vi.mocked(reviewPrivateComposerDraft);
  review.mockResolvedValueOnce(false);
  await open();
  expect(owner.hasVolatile(host, item.id)).toBe(true);
  expect(retryStaleChunkReloadWhenReachable).not.toHaveBeenCalled();
  const changed = createDeferred<boolean>();
  review.mockReturnValueOnce(changed.promise);
  const oldReview = open();
  owner.change(host, item.id, (current) => ({ ...current, text: "newer text" }));
  changed.resolve(true);
  await oldReview;
  expect(owner.hasVolatile(host, item.id)).toBe(true);
  expect(beginQueuedMessageEdit(host, item.id)).toBe("started");
  review.mockResolvedValueOnce(true);
  await open();
  expect(owner.hasVolatile(host, item.id)).toBe(true);
  cancelQueuedMessageEdit(host);
  const switched = createDeferred<boolean>();
  review.mockReturnValueOnce(switched.promise);
  const otherAccountReview = open();
  account = "review-other-account";
  events.publish({ ...events.gateway.snapshot });
  switched.resolve(true);
  await otherAccountReview;
  expect(owner.hasVolatile(host, item.id)).toBe(true);
  const replacement = makeChatHost({ requestHandlers: {} });
  vi.spyOn(replacement.client!, "recoveryScope", "get").mockReturnValue("review-original-account");
  replacement.outboxRecovery = host.outboxRecovery;
  replacement.settings.gatewayUrl = events.gateway.connection.gatewayUrl;
  stop();
  chatOutboxOwner(host).syncHost(host);
  const otherQueue = host.chatQueue;
  events.publish({ ...events.gateway.snapshot, client: replacement.client });
  chatOutboxOwner(replacement);
  const another = owner.keep(
    replacement,
    { sessionKey: replacement.sessionKey },
    {
      id: "other-retained-row",
      text: "other pending input",
      createdAt: 2,
      attachments: [attachment],
    },
    true,
  );
  review.mockResolvedValueOnce(true);
  await open();
  expect(owner.hasVolatile(host, item.id)).toBe(false);
  expect(retryStaleChunkReloadWhenReachable).toHaveBeenCalledOnce();
  expect(owner.hasVolatile(replacement, another.id)).toBe(true);
  expect(canReloadControlUiDocument()).toBe(false);
  expect(getChatAttachmentDataUrl(attachment)).not.toBeNull();
  review.mockResolvedValueOnce(true);
  await open();
  expect(owner.hasVolatile(replacement, another.id)).toBe(false);
  expect(canReloadControlUiDocument()).toBe(true);
  expect(getChatAttachmentDataUrl(attachment)).toBeNull();
  expect(host.chatQueue).toBe(otherQueue);
});
