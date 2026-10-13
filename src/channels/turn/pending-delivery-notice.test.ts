import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { deliverPendingDeliveryNotice } from "./pending-delivery-notice.js";

const PENDING_DELIVERY_NOTICE =
  "I couldn’t confirm whether my previous reply reached this chat, so I won’t resend it automatically. Please ask for any missing remainder.";

const sendRecoveryNotice = vi.hoisted(() => vi.fn());
const appendAssistantMessageToSessionTranscript = vi.hoisted(() => vi.fn());
const findDeliveryIntentOwner = vi.hoisted(() => vi.fn());

vi.mock("../../gateway/server-recovery-runtime-context.js", () => ({
  getGatewayRecoveryRuntime: () => ({ sendRecoveryNotice }),
}));
vi.mock("../../config/sessions/transcript.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/sessions/transcript.js")>();
  return { ...actual, appendAssistantMessageToSessionTranscript };
});
vi.mock("../../infra/outbound/delivery-queue-storage.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../infra/outbound/delivery-queue-storage.js")>();
  return { ...actual, findDeliveryIntentOwner };
});

describe("pending delivery notice", () => {
  const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-pending-notice-");
  let storePath: string;
  const sessionKey = "agent:main:telegram:direct:chat-1";

  beforeEach(async () => {
    vi.clearAllMocks();
    sendRecoveryNotice.mockReset().mockResolvedValue({ suppressed: false });
    findDeliveryIntentOwner.mockReturnValue(null);
    appendAssistantMessageToSessionTranscript.mockResolvedValue({ ok: true });
    storePath = path.join(sessionDirs.make(), "sessions.json");
    await replaceSessionEntry(
      { sessionKey, storePath },
      {
        sessionId: "session-1",
        status: "done",
        updatedAt: Date.now(),
        delivery: {
          kind: "external",
          route: { channel: "telegram", accountId: "default" },
          context: { channel: "telegram", to: "chat-1", accountId: "default", threadId: 42 },
          origin: {},
        },
        pendingDeliveryNotice: {
          createdAt: Date.now(),
          context: { channel: "telegram", to: "chat-1", accountId: "default", threadId: 42 },
          intentId: "intent-1",
          state: "owed",
        },
      },
    );
  });

  it("retains acknowledgment after the stable notice is recorded", async () => {
    await deliverPendingDeliveryNotice(sessionKey, storePath);

    expect(sendRecoveryNotice).toHaveBeenCalledWith({
      channel: "telegram",
      to: "chat-1",
      accountId: "default",
      threadId: 42,
      text: PENDING_DELIVERY_NOTICE,
      idempotencyKey: "main-session-restart-recovery:pending-final:intent-1",
    });
    expect(appendAssistantMessageToSessionTranscript).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedSessionId: "session-1",
        text: PENDING_DELIVERY_NOTICE,
      }),
    );
    expect(loadSessionEntry({ sessionKey, storePath })?.pendingDeliveryNotice).toMatchObject({
      state: "acknowledged",
      intentId: "intent-1",
    });
  });

  it("does not cross an account or thread route", async () => {
    const entry = loadSessionEntry({ sessionKey, storePath })!;
    await replaceSessionEntry(
      { sessionKey, storePath },
      {
        ...entry,
        delivery: {
          kind: "external",
          route: { channel: "telegram", accountId: "default" },
          context: { channel: "telegram", to: "chat-1", accountId: "other", threadId: 42 },
          origin: {},
        },
      },
    );

    await deliverPendingDeliveryNotice(sessionKey, storePath);

    expect(sendRecoveryNotice).not.toHaveBeenCalled();
    expect(loadSessionEntry({ sessionKey, storePath })?.pendingDeliveryNotice).toMatchObject({
      intentId: "intent-1",
      state: "owed",
    });
  });

  it("retains debt terminally when the notice send is suppressed", async () => {
    sendRecoveryNotice.mockResolvedValue({ suppressed: true });

    await deliverPendingDeliveryNotice(sessionKey, storePath);

    // A suppressed send is not user-visible: no transcript entry may claim it
    // was delivered, and the debt stays recorded instead of clearing silently.
    expect(appendAssistantMessageToSessionTranscript).not.toHaveBeenCalled();
    expect(loadSessionEntry({ sessionKey, storePath })?.pendingDeliveryNotice).toMatchObject({
      intentId: "intent-1",
      state: "unresolved",
    });
  });

  it("retains unresolved debt after a terminal notice delivery failure", async () => {
    sendRecoveryNotice.mockRejectedValue(new Error("delivery failed"));
    findDeliveryIntentOwner.mockReturnValue({ status: "failed" });

    await deliverPendingDeliveryNotice(sessionKey, storePath);

    expect(loadSessionEntry({ sessionKey, storePath })?.pendingDeliveryNotice).toMatchObject({
      intentId: "intent-1",
      state: "unresolved",
    });
  });

  it("records acknowledgment when the stable notice receipt completed before an error", async () => {
    sendRecoveryNotice.mockRejectedValue(new Error("post-ack failure"));
    findDeliveryIntentOwner.mockReturnValue({ status: "completed" });

    await deliverPendingDeliveryNotice(sessionKey, storePath);

    expect(appendAssistantMessageToSessionTranscript).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedSessionId: "session-1",
        text: PENDING_DELIVERY_NOTICE,
      }),
    );
    expect(loadSessionEntry({ sessionKey, storePath })?.pendingDeliveryNotice).toMatchObject({
      state: "acknowledged",
      intentId: "intent-1",
    });
  });

  it("retains owed debt while the durable notice remains pending", async () => {
    sendRecoveryNotice.mockRejectedValue(new Error("delivery pending"));
    findDeliveryIntentOwner.mockReturnValue({ status: "pending" });

    await deliverPendingDeliveryNotice(sessionKey, storePath);

    expect(loadSessionEntry({ sessionKey, storePath })?.pendingDeliveryNotice).toMatchObject({
      intentId: "intent-1",
      state: "owed",
    });
  });
  it.each([false, true])(
    "keeps acknowledgment when suppression finishes first=%s",
    async (suppressedFirst) => {
      const first = createDeferred<{ suppressed: boolean }>();
      const second = createDeferred<{ suppressed: boolean }>();
      const firstStarted = createDeferred();
      const secondStarted = createDeferred();
      sendRecoveryNotice
        .mockImplementationOnce(() => {
          firstStarted.resolve();
          return first.promise;
        })
        .mockImplementationOnce(() => {
          secondStarted.resolve();
          return second.promise;
        });
      const attempts = [
        deliverPendingDeliveryNotice(sessionKey, storePath),
        deliverPendingDeliveryNotice(sessionKey, storePath),
      ];
      await Promise.all([firstStarted.promise, secondStarted.promise]);
      first.resolve({ suppressed: suppressedFirst });
      await Promise.race(attempts);
      second.resolve({ suppressed: !suppressedFirst });
      await Promise.all(attempts);
      expect(loadSessionEntry({ sessionKey, storePath })?.pendingDeliveryNotice?.state).toBe(
        "acknowledged",
      );
      expect(appendAssistantMessageToSessionTranscript).toHaveBeenCalledTimes(1);
    },
  );

  it("leaves a replacement notice owed when an earlier send finishes", async () => {
    const sent = createDeferred<{ suppressed: boolean }>();
    const sendStarted = createDeferred();
    sendRecoveryNotice.mockImplementationOnce(() => {
      sendStarted.resolve();
      return sent.promise;
    });
    const attempt = deliverPendingDeliveryNotice(sessionKey, storePath);
    await sendStarted.promise;
    const entry = loadSessionEntry({ sessionKey, storePath })!;
    const replacement = { ...entry.pendingDeliveryNotice!, intentId: "intent-2" };
    await replaceSessionEntry(
      { sessionKey, storePath },
      { ...entry, pendingDeliveryNotice: replacement },
    );
    sent.resolve({ suppressed: false });
    await attempt;
    expect(loadSessionEntry({ sessionKey, storePath })?.pendingDeliveryNotice).toEqual(replacement);
  });
});
