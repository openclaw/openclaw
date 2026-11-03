import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveSystemEventQueueKey } from "../../infra/system-event-ownership.js";
import type { SystemEvent } from "../../infra/system-events.js";
import { captureContinuationQueueContext } from "../continuation/queue-context.js";

const MAIN_QUEUE_KEY = resolveSystemEventQueueKey("main", "main");

const RECIPIENT_AUTHORITY_EPOCH = "11111111-1111-4111-8111-111111111111";

const mocks = vi.hoisted(() => ({
  emitContinuationQueueDrainSpan: vi.fn(),
  peekDeliverableSystemEventEntries: vi.fn(),
  adoptSelectedSystemEventEntries: vi.fn(),
  buildChannelSummary: vi.fn(async () => []),
  ackSessionDelivery: vi.fn(async () => undefined),
  refuseContinuationReturnDelivery: vi.fn(async () => undefined),
  loadSessionEntry: vi.fn(),
  loadTranscriptEvents: vi.fn<() => Promise<unknown[]>>(async () => []),
  isSessionRecipientAuthorityCurrent: vi.fn(() => true),
}));

// mock-isolation: Continuation spans are captured without the process-wide tracer.
vi.mock("../../infra/continuation-tracer.js", () => ({
  emitContinuationQueueDrainSpan: mocks.emitContinuationQueueDrainSpan,
}));

vi.mock("../../infra/system-events.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/system-events.js")>();
  return {
    ...actual,
    peekDeliverableSystemEventEntries: mocks.peekDeliverableSystemEventEntries,
    adoptSelectedSystemEventEntries: mocks.adoptSelectedSystemEventEntries,
  };
});

// mock-isolation: Channel summaries come from the test; the real builder inspects channel plugin accounts.
vi.mock("../../infra/channel-summary.js", () => ({
  buildChannelSummary: mocks.buildChannelSummary,
}));
vi.mock("../../infra/session-delivery-queue-storage.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../infra/session-delivery-queue-storage.js")>();
  return {
    ...actual,
    ackSessionDelivery: mocks.ackSessionDelivery,
  };
});
vi.mock("../continuation/return-refusal.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../continuation/return-refusal.js")>()),
  refuseContinuationReturnDelivery: mocks.refuseContinuationReturnDelivery,
}));
// mock-isolation: Transcript events come from the test; the real accessor reads SQLite.
vi.mock("../../config/sessions/session-accessor.js", () => ({
  loadTranscriptEvents: mocks.loadTranscriptEvents,
}));
// Recipient authority is scripted per case at its owner module.
vi.mock("../../config/sessions/session-recipient-authority-current.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../config/sessions/session-recipient-authority-current.js")
  >()),
  withCurrentSessionRecipientAuthority: async <T>(
    checks: readonly unknown[],
    decide: (current: readonly boolean[]) => T,
  ) => decide(checks.map(() => mocks.isSessionRecipientAuthorityCurrent())),
}));
// The current session id is read through the worker-backed session reader.
vi.mock("../../config/sessions/session-entry-read-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/sessions/session-entry-read-runtime.js")>()),
  readSessionEntryReadOnlyInWorker: async (scope: unknown) => mocks.loadSessionEntry(scope),
}));

// mock-isolation: Runtime log lines are dropped instead of writing to the terminal.
vi.mock("../../runtime.js", () => ({
  defaultRuntime: {
    log: vi.fn(),
  },
}));

const { drainFormattedSystemEvents, prepareFormattedSystemEvents } =
  await import("./session-system-events.js");
const { settleManagedSystemEventsAfterTurnAdoption } =
  await import("./session-system-event-adoption.js");

// Route the mocked queue seams to the real in-memory queue for one case.
async function useActualQueue() {
  const actual = await vi.importActual<typeof import("../../infra/system-events.js")>(
    "../../infra/system-events.js",
  );
  actual.resetSystemEventsForTest();
  mocks.peekDeliverableSystemEventEntries.mockImplementation(
    actual.peekDeliverableSystemEventEntries,
  );
  mocks.adoptSelectedSystemEventEntries.mockImplementation(actual.adoptSelectedSystemEventEntries);
  return actual;
}

describe("drainFormattedSystemEvents trace context", () => {
  beforeEach(() => {
    mocks.emitContinuationQueueDrainSpan.mockClear();
    mocks.peekDeliverableSystemEventEntries.mockReset();
    mocks.adoptSelectedSystemEventEntries.mockReset();
    mocks.buildChannelSummary.mockClear();
    mocks.ackSessionDelivery.mockClear();
    mocks.refuseContinuationReturnDelivery.mockReset();
    mocks.loadSessionEntry.mockReset().mockReturnValue({ sessionId: "current-session" });
    mocks.loadTranscriptEvents.mockReset().mockResolvedValue([]);
    mocks.isSessionRecipientAuthorityCurrent.mockReset().mockReturnValue(true);
  });

  it("parents the queue-drain span to the first traced drained entry", async () => {
    const traceparent = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
    const events: SystemEvent[] = [
      { text: "ordinary event", ts: 1 },
      { text: "[continuation:resume] traced event", ts: 2, traceparent },
      {
        text: "[continuation:resume] later traced event",
        ts: 3,
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      },
    ];
    mocks.peekDeliverableSystemEventEntries.mockReturnValue(events);
    mocks.adoptSelectedSystemEventEntries.mockReturnValue(events);

    await drainFormattedSystemEvents({
      cfg: {},
      agentId: "main",
      sessionKey: "main",
      isMainSession: false,
      isNewSession: false,
    });

    expect(mocks.emitContinuationQueueDrainSpan).toHaveBeenCalledWith(
      expect.objectContaining({
        drainedCount: 3,
        drainedContinuationCount: 2,
        traceparent,
      }),
    );
  });

  it("omits traceparent for untraced drained entries", async () => {
    const events: SystemEvent[] = [{ text: "[continuation:resume] untraced", ts: 1 }];
    mocks.peekDeliverableSystemEventEntries.mockReturnValue(events);
    mocks.adoptSelectedSystemEventEntries.mockReturnValue(events);

    await drainFormattedSystemEvents({
      cfg: {},
      agentId: "main",
      sessionKey: "main",
      isMainSession: false,
      isNewSession: false,
    });

    expect(mocks.emitContinuationQueueDrainSpan).toHaveBeenCalledWith(
      expect.not.objectContaining({ traceparent: expect.any(String) }),
    );
  });

  it("preserves a bound logical recipient across a session id rollover", async () => {
    const event: SystemEvent = {
      text: "accepted delegate result",
      ts: 1,
      sessionDeliveryAckId: "delivery-rollover",
      sessionDeliveryAwaitsTurnAdoption: true,
      recipientAuthority: {
        state: "bound",
        epoch: RECIPIENT_AUTHORITY_EPOCH,
      },
    };
    mocks.peekDeliverableSystemEventEntries.mockReturnValue([event]);
    mocks.adoptSelectedSystemEventEntries.mockImplementation(
      (_sessionKey: string, entries: SystemEvent[]) => entries,
    );
    mocks.loadSessionEntry.mockReturnValue({ sessionId: "new-session-incarnation" });

    const prepared = await prepareFormattedSystemEvents({
      cfg: {},
      agentId: "main",
      sessionKey: "main",
      isMainSession: false,
      isNewSession: false,
    });

    expect(prepared.blocks).toEqual([
      expect.objectContaining({
        key: "session-delivery:delivery-rollover",
        text: expect.stringContaining("accepted delegate result"),
      }),
    ]);
    expect(prepared.managedDeliveries).toHaveLength(1);
    expect(mocks.ackSessionDelivery).not.toHaveBeenCalled();
  });

  it("refuses a stale bound recipient before prompt adoption", async () => {
    const event: SystemEvent = {
      text: "stale delegate result",
      ts: 1,
      sessionDeliveryAckId: "delivery-stale-authority",
      sessionDeliveryAwaitsTurnAdoption: true,
      recipientAuthority: {
        state: "bound",
        epoch: RECIPIENT_AUTHORITY_EPOCH,
      },
    };
    mocks.peekDeliverableSystemEventEntries.mockReturnValue([event]);
    mocks.adoptSelectedSystemEventEntries.mockImplementation(
      (_sessionKey: string, entries: SystemEvent[]) => entries,
    );
    mocks.loadSessionEntry.mockReturnValue({ sessionId: "replacement-session" });
    mocks.isSessionRecipientAuthorityCurrent.mockReturnValue(false);

    const prepared = await prepareFormattedSystemEvents({
      cfg: {},
      agentId: "main",
      sessionKey: "main",
      isMainSession: false,
      isNewSession: false,
    });

    expect(prepared).toEqual({ blocks: [], managedDeliveries: [] });
    // No explicit queue state dir on the event: the refusal binds to the process's
    // own default queue context (89be566948 made the context mandatory).
    const processQueue = captureContinuationQueueContext();
    expect(mocks.ackSessionDelivery).not.toHaveBeenCalled();
    expect(mocks.refuseContinuationReturnDelivery).toHaveBeenCalledWith(
      "delivery-stale-authority",
      expect.objectContaining({
        admission: expect.objectContaining({ databasePath: processQueue.admission.databasePath }),
        environment: expect.objectContaining({
          OPENCLAW_STATE_DIR: processQueue.environment.OPENCLAW_STATE_DIR,
        }),
      }),
    );
    expect(mocks.adoptSelectedSystemEventEntries).toHaveBeenCalledWith(MAIN_QUEUE_KEY, [event], {
      deferredEventIds: undefined,
    });
    expect(mocks.emitContinuationQueueDrainSpan).toHaveBeenCalledWith(
      expect.objectContaining({ refusedCount: 1, refusalReason: "recipient-authority-changed" }),
    );
  });

  it("acknowledges only deliveries evidenced by the persisted recipient turn", async () => {
    const delivery1 = vi.fn(async () => undefined);
    const delivery2 = vi.fn(async () => undefined);
    const deliveries = [
      { id: "delivery-1", acknowledge: delivery1 },
      { id: "delivery-2", acknowledge: delivery2 },
    ];

    await settleManagedSystemEventsAfterTurnAdoption({
      deliveries,
      persistedMessage: {
        role: "user",
        content: "older idempotent turn",
      },
    });

    expect(delivery1).not.toHaveBeenCalled();
    expect(delivery2).not.toHaveBeenCalled();

    await settleManagedSystemEventsAfterTurnAdoption({
      deliveries,
      persistedMessage: {
        role: "user",
        content: "adopted managed turn",
        __openclaw: { sessionDeliveryAckIds: ["delivery-2"] },
      },
    });

    expect(delivery1).not.toHaveBeenCalled();
    expect(delivery2).toHaveBeenCalledOnce();
  });

  it("gives consumed entries back to the queue when the session read fails", async () => {
    const actual = await useActualQueue();
    actual.enqueueSystemEvent("queued before a failed read", { sessionKey: MAIN_QUEUE_KEY });
    mocks.loadSessionEntry.mockImplementation(() => {
      throw new Error("session read failed");
    });

    const preparing = prepareFormattedSystemEvents({
      cfg: {},
      agentId: "main",
      sessionKey: "main",
      isMainSession: false,
      isNewSession: false,
    });
    // Consumed before the first await, as upstream's drain does.
    expect(actual.peekSystemEventEntries(MAIN_QUEUE_KEY)).toEqual([]);
    await expect(preparing).rejects.toThrow("session read failed");

    expect(actual.peekSystemEventEntries(MAIN_QUEUE_KEY).map((event) => event.text)).toEqual([
      "queued before a failed read",
    ]);
  });

  it("keeps a settled stale entry out of the queue when a later stale settlement fails", async () => {
    const actual = await useActualQueue();
    for (const id of ["delivery-stale-settled", "delivery-stale-failing"]) {
      actual.enqueueSystemEvent(`stale ${id}`, {
        sessionKey: MAIN_QUEUE_KEY,
        trusted: true,
        sessionDeliveryAckId: id,
        recipientAuthority: { state: "bound", epoch: RECIPIENT_AUTHORITY_EPOCH },
      });
    }
    mocks.isSessionRecipientAuthorityCurrent.mockReturnValue(false);
    // Settlement runs in queue order: the first stale row settles, the second fails.
    mocks.refuseContinuationReturnDelivery
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("stale settlement failed"));

    await expect(
      prepareFormattedSystemEvents({
        cfg: {},
        agentId: "main",
        sessionKey: "main",
        isMainSession: false,
        isNewSession: false,
      }),
    ).rejects.toThrow("stale settlement failed");

    expect(
      actual.peekSystemEventEntries(MAIN_QUEUE_KEY).map((event) => event.sessionDeliveryAckId),
    ).toEqual(["delivery-stale-failing"]);
  });

  it("finalizes ingress adoption before fallible managed delivery settlement", async () => {
    const order: string[] = [];
    const settlementError = new Error("managed settlement failed");
    const onTurnAdopted = vi.fn(async () => {
      order.push("ingress-adopted");
    });
    const acknowledge = vi.fn(async () => {
      order.push("managed-settlement");
      throw settlementError;
    });

    await expect(
      settleManagedSystemEventsAfterTurnAdoption({
        deliveries: [{ id: "delivery-1", acknowledge }],
        persistedMessage: {
          role: "user",
          content: "adopted managed turn",
          __openclaw: { sessionDeliveryAckIds: ["delivery-1"] },
        },
        onTurnAdopted,
      }),
    ).rejects.toBe(settlementError);

    expect(order).toEqual(["ingress-adopted", "managed-settlement"]);
    expect(onTurnAdopted).toHaveBeenCalledOnce();
    expect(acknowledge).toHaveBeenCalledOnce();
  });
});
