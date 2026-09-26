import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
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
  let tmpDir: string;
  let storePath: string;
  const sessionKey = "agent:main:telegram:direct:chat-1";

  beforeEach(async () => {
    vi.clearAllMocks();
    sendRecoveryNotice.mockResolvedValue({ suppressed: false });
    findDeliveryIntentOwner.mockReturnValue(null);
    appendAssistantMessageToSessionTranscript.mockResolvedValue({ ok: true });
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pending-notice-"));
    storePath = path.join(tmpDir, "sessions.json");
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

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
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
      sendRecoveryNotice.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
      const attempts = [
        deliverPendingDeliveryNotice(sessionKey, storePath),
        deliverPendingDeliveryNotice(sessionKey, storePath),
      ];
      first.resolve({ suppressed: suppressedFirst });
      await attempts[0];
      second.resolve({ suppressed: !suppressedFirst });
      await attempts[1];
      expect(loadSessionEntry({ sessionKey, storePath })?.pendingDeliveryNotice?.state).toBe(
        "acknowledged",
      );
      expect(appendAssistantMessageToSessionTranscript).toHaveBeenCalledTimes(1);
    },
  );

  it("leaves a replacement notice owed when an earlier send finishes", async () => {
    const sent = createDeferred<{ suppressed: boolean }>();
    sendRecoveryNotice.mockReturnValueOnce(sent.promise);
    const attempt = deliverPendingDeliveryNotice(sessionKey, storePath);
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

  describe("while the durable queue still owns the noticed final", () => {
    const pendingFinalDelivery = {
      kind: "replayable" as const,
      text: "the final answer",
      createdAt: Date.now(),
      context: { channel: "telegram", to: "chat-1", accountId: "default", threadId: 42 },
      intentId: "intent-1",
      deliveries: [{ id: "delivery-1", state: "unknown" as const }],
    };

    beforeEach(async () => {
      const entry = loadSessionEntry({ sessionKey, storePath })!;
      await replaceSessionEntry({ sessionKey, storePath }, { ...entry, pendingFinalDelivery });
    });

    // The dispatch-time "unknown" claim owes the notice before platform I/O; a
    // message arriving during that send must not announce a loss that has not
    // happened yet.
    it.each([{ status: "pending" }, { status: "failed", settlementPending: true }])(
      "defers the notice while the queued send is unsettled (%o)",
      async (owner) => {
        findDeliveryIntentOwner.mockImplementation((id: string) =>
          id === "delivery-1" ? owner : null,
        );

        await deliverPendingDeliveryNotice(sessionKey, storePath);

        expect(sendRecoveryNotice).not.toHaveBeenCalled();
        expect(appendAssistantMessageToSessionTranscript).not.toHaveBeenCalled();
        expect(loadSessionEntry({ sessionKey, storePath })?.pendingDeliveryNotice).toMatchObject({
          intentId: "intent-1",
          state: "owed",
        });
      },
    );

    it.each([null, { status: "failed" }, { status: "completed" }])(
      "announces once the queue has settled the send (%o)",
      async (owner) => {
        findDeliveryIntentOwner.mockImplementation((id: string) =>
          id === "delivery-1" ? owner : null,
        );

        await deliverPendingDeliveryNotice(sessionKey, storePath);

        expect(sendRecoveryNotice).toHaveBeenCalledTimes(1);
        expect(loadSessionEntry({ sessionKey, storePath })?.pendingDeliveryNotice).toMatchObject({
          intentId: "intent-1",
          state: "acknowledged",
        });
      },
    );

    it("does not defer behind a later intent's queued send", async () => {
      const entry = loadSessionEntry({ sessionKey, storePath })!;
      await replaceSessionEntry(
        { sessionKey, storePath },
        {
          ...entry,
          pendingFinalDelivery: {
            ...pendingFinalDelivery,
            intentId: "intent-2",
            deliveries: [{ id: "delivery-2", state: "queued" }],
          },
        },
      );
      findDeliveryIntentOwner.mockReturnValue({ status: "pending" });

      await deliverPendingDeliveryNotice(sessionKey, storePath);

      expect(sendRecoveryNotice).toHaveBeenCalledTimes(1);
      expect(loadSessionEntry({ sessionKey, storePath })?.pendingDeliveryNotice).toMatchObject({
        intentId: "intent-1",
        state: "acknowledged",
      });
    });
  });
});
