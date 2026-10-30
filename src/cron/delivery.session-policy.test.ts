import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as deliveryQueue from "../infra/delivery-queue-sqlite.js";
import { sendCronAnnouncePayloadStrict } from "./delivery.js";
import { makeJob } from "./isolated-agent.test-harness.js";

const mocks = vi.hoisted(() => ({
  bindOutboundSessionEntry: vi.fn(),
  loadSessionEntryReadOnly: vi.fn(),
  warn: vi.fn(),
}));
// mock-isolation: Notifications must not create or read model conversation state.
vi.mock("../infra/outbound/outbound-session.js", () => ({
  bindOutboundSessionEntry: mocks.bindOutboundSessionEntry,
}));
// mock-isolation: Keep session storage outside the notification transport boundary.
vi.mock("../config/sessions/session-accessor.js", () => ({
  loadSessionEntryReadOnly: mocks.loadSessionEntryReadOnly,
}));
// mock-isolation: Capture policy warnings without process-global log files.
vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    warn: mocks.warn,
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  }),
}));
// mock-isolation: Confirm transport success without queue custody or a network channel.
vi.mock("../channels/message/runtime.js", () => ({
  sendDurableMessageBatchCore: vi.fn(async () => ({ status: "sent" })),
  durableMessageBatchMayHaveReachedRecipient: () => true,
}));
// mock-isolation: Announcement identity must not read an agent workspace.
vi.mock("../infra/outbound/identity.js", () => ({ resolveAgentOutboundIdentity: () => undefined }));
// mock-isolation: Delivery context must not load unrelated source-session metadata.
vi.mock("../infra/outbound/session-context.js", () => ({
  buildOutboundSessionContext: () => ({}),
}));
// mock-isolation: No live channel dependencies are needed behind the transport boundary.
vi.mock("../cli/outbound-send-deps.js", () => ({ createOutboundSendDeps: () => ({}) }));

describe("command announcement session policy", () => {
  afterEach(() => vi.restoreAllMocks());

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(deliveryQueue, "inspectDeliveryQueueReceipt").mockResolvedValue({
      status: undefined,
      pendingEntry: null,
    });
  });

  it.each([undefined, "agent:other:main"])(
    "sends a prepared notification without owning conversation state (source=%s)",
    async (sessionKey) => {
      const job = makeJob({ kind: "command", argv: ["echo", "report"] });
      const result = await sendCronAnnouncePayloadStrict({
        cfg: { session: { dmScope: "per-channel-peer" } },
        deps: {},
        agentId: "main",
        jobId: job.id,
        target: { channel: "fallbackchat", to: "user:recipient", sessionKey },
        payload: { text: "report" },
        abortSignal: new AbortController().signal,
        completion: { job, runStartedAt: 1000, deliveryAttemptFence: null },
      });
      expect(result).toEqual({ status: "sent", payloads: [] });
      expect(mocks.loadSessionEntryReadOnly).not.toHaveBeenCalled();
      expect(mocks.warn).not.toHaveBeenCalled();
      expect(mocks.bindOutboundSessionEntry).not.toHaveBeenCalled();
    },
  );
});
