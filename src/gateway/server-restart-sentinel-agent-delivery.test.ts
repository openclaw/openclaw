// Ownership backoff at the two production defer sites for queued generated-media delivery.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions/types.js";
import { SessionDeliveryDeferredError } from "../infra/session-delivery-queue.records.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { deliverQueuedGeneratedMediaCompletion } from "./server-restart-sentinel-agent-delivery.js";

const mocks = vi.hoisted(() => ({
  deferSessionDelivery: vi.fn(async (): Promise<void> => undefined),
  inspectDeliveryQueueReceipt: vi.fn(async () => ({ status: "pending" as const })),
  isSessionControllerWorkActive: vi.fn(() => false),
}));

vi.mock("../infra/session-delivery-queue-storage.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  deferSessionDelivery: mocks.deferSessionDelivery,
}));

vi.mock("../infra/delivery-queue-sqlite.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  inspectDeliveryQueueReceipt: mocks.inspectDeliveryQueueReceipt,
}));

vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getRuntimeConfig: () => ({}),
}));

vi.mock("../sessions/session-controller.lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isSessionControllerWorkActive: mocks.isSessionControllerWorkActive,
}));

const queueContext = {
  environment: { OPENCLAW_STATE_DIR: "C:/openclaw-state" },
  admission: { assertCurrent: () => undefined },
} as unknown as OpenClawStateWorkerContext;

const sessionEntry = {
  sessionId: "session-1",
  lifecycleRevision: "revision-1",
  updatedAt: 1,
} as SessionEntry;

const MINUTE = 60_000;

function agedEntry(ageMs: number, channel: string) {
  return {
    id: "entry-1",
    kind: "agentTurn" as const,
    sessionKey: "agent:main:main",
    messageId: "message-1",
    enqueuedAt: Date.now() - ageMs,
    retryCount: 0,
    deliveryStartedAt: Date.now() - 1_000,
    expectedMediaUrls: ["file:///tmp/generated.png"],
    inputProvenance: { kind: "inter_session" as const },
    sourceReplyDeliveryMode: "automatic" as const,
    route: { channel, to: "conversation-1", chatType: "direct" as const },
  };
}

function deliver(entry: ReturnType<typeof agedEntry>) {
  return deliverQueuedGeneratedMediaCompletion({
    canonicalKey: "agent:main:main",
    agentId: "main",
    storePath: "C:/openclaw-state/sessions.json",
    entry,
    deps: {},
    sessionEntry,
    queueContext,
  });
}

beforeEach(() => {
  mocks.deferSessionDelivery.mockClear();
  mocks.inspectDeliveryQueueReceipt.mockClear();
  mocks.inspectDeliveryQueueReceipt.mockResolvedValue({ status: "pending" });
  mocks.isSessionControllerWorkActive.mockReset();
  mocks.isSessionControllerWorkActive.mockReturnValue(false);
});

describe("generated-media ownership defer delay", () => {
  // Both sites must reuse the age-based delay; returning the fixed 1 s constant
  // re-arms the row rewrite once per second for a permanently stuck entry.
  it.each([
    ["a fresh", 0, 1_000],
    ["a two-minute-old", 2 * MINUTE, 4_000],
    ["a ten-minute-old", 10 * MINUTE, 60_000],
    ["an hours-old", 6 * 60 * MINUTE, 60_000],
  ])("backs off %s transcript write wait", async (_label, ageMs, expected) => {
    mocks.isSessionControllerWorkActive.mockReturnValue(true);

    await expect(deliver(agedEntry(ageMs, "webchat"))).rejects.toBeInstanceOf(
      SessionDeliveryDeferredError,
    );

    expect(mocks.deferSessionDelivery).toHaveBeenCalledTimes(1);
    expect(mocks.deferSessionDelivery).toHaveBeenCalledWith("entry-1", expected, queueContext);
  });

  it.each([
    ["a fresh", 0, 1_000],
    ["a ten-minute-old", 10 * MINUTE, 60_000],
  ])("backs off %s outbound-owner wait", async (_label, ageMs, expected) => {
    await expect(deliver(agedEntry(ageMs, "telegram"))).rejects.toBeInstanceOf(
      SessionDeliveryDeferredError,
    );

    expect(mocks.inspectDeliveryQueueReceipt).toHaveBeenCalledTimes(1);
    expect(mocks.deferSessionDelivery).toHaveBeenCalledWith("entry-1", expected, queueContext);
  });
});
