import path from "node:path";
import { afterEach, beforeEach, expect, it, vi, type TestContext } from "vitest";
import { createSolidPngBuffer } from "../../test/helpers/image-fixtures.js";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import type { SessionEventOutcome } from "../auto-reply/reply/session-event-contract.js";
import type * as SessionEventHandoff from "../auto-reply/reply/session-event-handoff.js";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { drainPendingSessionDelivery } from "../infra/session-delivery-queue-recovery.js";
import * as queueStorage from "../infra/session-delivery-queue-storage.js";
import type { QueuedSessionDeliveryPayload } from "../infra/session-delivery-queue.records.js";
import { onInternalSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { StateDatabaseReadAdmissionInvalidatedError } from "../state/openclaw-state-db-async-lifecycle.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import * as managedMedia from "./managed-image-attachments.js";
import { listManagedImageRecordEntries } from "./managed-image-record-store.js";
import * as recoveryRuntime from "./server-recovery-runtime-context.js";
import {
  configureRestartSessionEventMocks,
  createGeneratedMediaDeliveryEntry,
  createRestartSentinelSessionFixture as sessionFixture,
} from "./server-restart-sentinel.test-support.js";
import type { loadSessionEntryAsync } from "./session-entry-load.test-support.js";
import type { resolveGatewaySessionStoreTargetInWorker } from "./session-utils-store-worker.js";

const mocks = vi.hoisted(() => ({
  resolveSessionTarget: vi.fn<typeof resolveGatewaySessionStoreTargetInWorker>(),
  loadSessionEntryAsync: vi.fn<typeof loadSessionEntryAsync>(),
  captureSessionEventTarget: vi.fn<typeof SessionEventHandoff.captureSessionEventTargetForHost>(),
  enqueueSessionEvent: vi.fn<typeof SessionEventHandoff.enqueueSessionEventForHost>(),
}));

// mock-isolation: Queued-owner cases use supplied session rows instead of real store discovery.
vi.mock("./session-utils-store-worker.js", () => ({
  loadGatewaySessionEntryReadOnlyInWorker: async (params: {
    key: string;
    agentId?: string;
    env?: NodeJS.ProcessEnv;
  }) => mocks.loadSessionEntryAsync(params.key, { agentId: params.agentId, env: params.env }),
  resolveGatewaySessionStoreTargetInWorker: mocks.resolveSessionTarget,
}));

// mock-isolation: Drive adoption and settlement gates without admitting an actual session turn.
vi.mock("../auto-reply/reply/session-event-handoff.js", () => ({
  captureSessionEventTargetForHost: mocks.captureSessionEventTarget,
  enqueueSessionEventForHost: mocks.enqueueSessionEvent,
}));

const { deliverQueuedSessionDelivery } = await import("./server-restart-sentinel.js");
const deliveryContext = { channel: "telegram", to: "42", accountId: "work", threadId: "7" };
const agentTurn = {
  kind: "agentTurn",
  sessionKey: "global",
  message: "resume work",
  messageId: "resume-1",
} as const;
const cases = [
  ["legacy system event", { kind: "systemEvent", sessionKey: "global", text: "resume work" }],
  ["agent turn without a route", agentTurn],
  [
    "replaced agent-turn session",
    {
      ...agentTurn,
      expectedSessionId: "old-session",
      route: { ...deliveryContext, chatType: "direct" },
    },
  ],
] satisfies Array<[string, QueuedSessionDeliveryPayload]>;

let state: OpenClawTestState;
let queueContext: ReturnType<typeof captureOpenClawStateWorkerContext>;
beforeEach(() => {
  vi.clearAllMocks();
  configureRestartSessionEventMocks(mocks, "current-session");
});
afterEach(() => vi.restoreAllMocks());
function withFixture<Args extends unknown[]>(run: (...args: Args) => Promise<void>) {
  return (...args: Args) =>
    withOpenClawTestState(
      { label: "restart-event-owner", layout: "state-only" },
      async (fixture) => {
        state = fixture;
        setRuntimeConfigSnapshot({});
        mockEventSession();
        queueContext = captureOpenClawStateWorkerContext();
        await run(...args);
      },
    );
}

function mockEventSession(agentId = "main", sessionKey = "agent:main:main") {
  mocks.loadSessionEntryAsync.mockResolvedValue({
    ...sessionFixture(
      sessionKey,
      { sessionId: "current-session", updatedAt: 1 },
      { storePath: "/tmp/restart-owner/openclaw-agent.sqlite" },
    ),
    agentId,
  });
}

const eventPayload = {
  kind: "systemEvent",
  sessionKey: "agent:main:main",
  text: "resume work",
} as const;
const deliver = (entry: Parameters<typeof deliverQueuedSessionDelivery>[0]["entry"]) =>
  deliverQueuedSessionDelivery({ deps: {}, entry, queueContext });
const enqueue = (payload: QueuedSessionDeliveryPayload = eventPayload) =>
  queueStorage.enqueueSessionDelivery(payload, queueContext);
const pending = (id: string) => queueStorage.loadPendingSessionDelivery(id, queueContext);
async function enqueueEntry(payload: QueuedSessionDeliveryPayload) {
  const entry = await pending(await enqueue(payload));
  if (!entry) {
    throw new Error("Expected queued delivery");
  }
  return entry;
}
const drainEvent = (
  id: string,
  onSettled?: Parameters<typeof drainPendingSessionDelivery>[0]["onSettled"],
) =>
  drainPendingSessionDelivery({
    id,
    queueContext,
    onSettled,
    bypassBackoff: true,
    logLabel: "restart custody",
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    deliver,
  });
function expectResearchEvent(expectedTarget: object) {
  expect(mocks.enqueueSessionEvent).toHaveBeenCalledExactlyOnceWith(
    "resume work",
    expect.objectContaining({
      agentId: "research",
      sessionKey: "global",
      deliveryContext,
      source: "restart",
      expectedTarget: expect.objectContaining(expectedTarget),
    }),
  );
}

it.each(cases)(
  "binds %s to its destination without rewriting its queued key",
  withFixture(async (_name: string, payload: QueuedSessionDeliveryPayload) => {
    mockEventSession("research", "global");
    const entry = await enqueueEntry({ ...payload, deliveryContext });
    const original = structuredClone(entry);

    await deliver(entry);

    expect(mocks.captureSessionEventTarget).toHaveBeenCalledExactlyOnceWith(
      "research",
      "global",
      expect.objectContaining({ env: queueContext.environment }),
    );
    expectResearchEvent({ agentId: "research", sessionKey: "global" });
    expect(entry).toEqual(original);
  }),
);

it(
  "carries a persisted owner through global session lookup in an explicit roster",
  withFixture(async () => {
    const actual = await vi.importActual<typeof import("./session-utils-store-worker.js")>(
      "./session-utils-store-worker.js",
    );
    mocks.resolveSessionTarget.mockImplementation(actual.resolveGatewaySessionStoreTargetInWorker);
    const handoff = await vi.importActual<
      typeof import("../auto-reply/reply/session-event-handoff.js")
    >("../auto-reply/reply/session-event-handoff.js");
    mocks.captureSessionEventTarget.mockImplementation(handoff.captureSessionEventTargetForHost);
    const config = {
      agents: { ownership: "explicit" as const, entries: { main: {}, research: {} } },
      session: {
        scope: "global" as const,
        store: path.join(state.stateDir, "agents", "{agentId}", "sessions", "sessions.json"),
      },
    };
    setRuntimeConfigSnapshot(config, config);
    for (const agentId of ["main", "research"]) {
      await replaceSessionEntry(
        { agentId, sessionKey: "global" },
        { sessionId: `${agentId}-session`, updatedAt: 1 },
      );
    }
    queueContext = captureOpenClawStateWorkerContext();
    const entry = await enqueueEntry({
      kind: "systemEvent",
      sessionKey: "global",
      agentId: "research",
      text: "resume work",
      deliveryContext,
    });
    await deliver(entry);

    expectResearchEvent({ sessionId: "research-session" });
  }),
);

it.each(["completed", "failed", "cancelled"] as const)(
  "retains durable custody until an adopted session event is %s",
  withFixture(async (status: "completed" | "failed" | "cancelled") => {
    const id = await enqueue();
    const adopted = createDeferred();
    const outcome = createDeferred<SessionEventOutcome>();
    mocks.enqueueSessionEvent.mockImplementationOnce((_text, options) => ({
      id: "sentinel-event",
      accepted: Promise.resolve({ ok: true }),
      cancel: () => true,
      settled: Promise.resolve().then(async () => {
        await options.onAdopted?.();
        adopted.resolve();
        return outcome.promise;
      }),
    }));
    const onSettled = vi.fn();
    const drain = drainEvent(id, onSettled);
    try {
      await awaitGateBeforeSettlement(
        adopted.promise,
        drain,
        "Restart custody settled before adoption",
      );
      expect(await pending(id)).toMatchObject({
        id,
        deliveryStartedAt: expect.any(Number),
      });
    } finally {
      outcome.resolve({
        status,
        executionStarted: true,
        delivered: status === "completed",
        error: status === "failed" ? "model failed" : undefined,
      });
      await drain;
    }
    expect(onSettled).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id }),
      status === "completed" ? "recovered" : "moved-to-failed",
      queueContext,
    );
    expect(await pending(id)).toBeNull();
    expect(mocks.enqueueSessionEvent).toHaveBeenCalledOnce();
  }),
);

it.each([undefined, true, false])(
  "settles an admission refusal with retryable=%s",
  withFixture(async (retryable: boolean | undefined) => {
    const id = await enqueue();
    mocks.enqueueSessionEvent.mockReturnValueOnce({
      id: "refused-event",
      accepted: Promise.resolve({ ok: false, error: "session is busy" }),
      cancel: () => true,
      settled: Promise.resolve({
        status: "failed",
        executionStarted: false,
        delivered: false,
        error: "session is busy",
        retryable,
      }),
    });
    await drainEvent(id);
    const entry = await pending(id);
    if (retryable === false) {
      expect(entry).toBeNull();
    } else {
      expect(entry).toMatchObject({ id, retryCount: 1, lastError: "session is busy" });
      expect(entry?.deliveryStartedAt).toBeUndefined();
    }
  }),
);

it(
  "does not hand off an event after its queue admission retires during the session read",
  withFixture(async () => {
    const resolveTarget = mocks.resolveSessionTarget.getMockImplementation()!;
    mocks.resolveSessionTarget.mockImplementationOnce(async (params) => {
      const target = await resolveTarget(params);
      await closeOpenClawStateDatabaseByPathAsync(queueContext.admission.databasePath);
      return target;
    });
    await expect(
      deliver({
        ...eventPayload,
        id: "retired-read",
        enqueuedAt: 1,
        retryCount: 0,
      }),
    ).rejects.toThrow(StateDatabaseReadAdmissionInvalidatedError);
    expect(mocks.enqueueSessionEvent).not.toHaveBeenCalled();
  }),
);

it(
  "joins managed media promotion before publishing an internal restart delivery",
  withFixture(async (test: TestContext) => {
    const sessionKey = "agent:main:media-completion";
    const sessionId = "media-completion-session";
    const storePath = state.statePath("agents", "main", "sessions", "sessions.json");
    const entry = { sessionId, updatedAt: 1 };
    await replaceSessionEntry({ agentId: "main", sessionKey, storePath }, entry);
    mocks.loadSessionEntryAsync.mockResolvedValue({
      ...sessionFixture(sessionKey, entry, { storePath }),
      agentId: "main",
    });
    const mediaUrl = `data:image/png;base64,${createSolidPngBuffer(1, 1, { r: 17, g: 34, b: 51 }).toString("base64")}`;
    const blocks = await managedMedia.createManagedOutgoingMediaBlocks({
      sessionKey,
      agentId: "main",
      stateDir: state.stateDir,
      items: [{ url: mediaUrl, trustedLocal: false }],
    });
    const promoting = createDeferred();
    const release = createDeferred();
    const attach = managedMedia.attachManagedOutgoingMediaToMessage;
    const promotion = vi
      .spyOn(managedMedia, "attachManagedOutgoingMediaToMessage")
      .mockImplementationOnce(async (params) => {
        promoting.resolve();
        await release.promise;
        return attach(params);
      });
    const admission = vi
      .spyOn(queueStorage, "markSessionDeliveryAttemptStarted")
      .mockResolvedValue(undefined);
    const dispatch = vi.spyOn(recoveryRuntime, "dispatchGatewayLifecycleMethod").mockResolvedValue({
      status: "ok",
      result: { payloads: [{ mediaUrls: [mediaUrl] }], deliveryStatus: { status: "sent" } },
    });
    const updates: unknown[] = [];
    const unsubscribe = onInternalSessionTranscriptUpdate((update) => {
      if (update.target?.sessionId === sessionId) {
        updates.push(update);
      }
    });
    let settled = false;
    queueContext = captureOpenClawStateWorkerContext();
    const {
      id: _id,
      enqueuedAt: _enqueuedAt,
      retryCount: _retryCount,
      ...payload
    } = createGeneratedMediaDeliveryEntry({
      id: "unused",
      sessionKey,
      messageId: "image:media-completion:agent-loop",
      idempotencyKey: "image:media-completion:agent-loop",
      route: { channel: "webchat", to: sessionKey, chatType: "direct" },
      expectedMediaUrls: [mediaUrl],
      preparedMediaBlocks: { [mediaUrl]: blocks },
    });
    const outcome = deliver(await enqueueEntry(payload)).finally(() => {
      settled = true;
    });
    void outcome.catch(() => {});
    try {
      await racePromiseWithAbortSignal(
        awaitGateBeforeSettlement(
          promoting.promise,
          outcome,
          "Delivery never entered media promotion",
        ),
        test.signal,
      );
      expect(settled).toBe(false);
      expect(updates).toEqual([]);
      expect(await listManagedImageRecordEntries({ stateDir: state.stateDir })).toMatchObject([
        { record: { messageId: null, retentionClass: "transient" } },
      ]);
      release.resolve();
      // The host message is published before the completion turn is scheduled.
      await expect(outcome).rejects.toThrow("its completion turn follows");
      expect(dispatch).not.toHaveBeenCalled();
      expect(updates).toEqual([expect.objectContaining({ messageId: expect.any(String) })]);
      expect(await listManagedImageRecordEntries({ stateDir: state.stateDir })).toMatchObject([
        { record: { messageId: expect.any(String), retentionClass: "history" } },
      ]);
    } finally {
      release.resolve();
      await Promise.allSettled([outcome]);
      unsubscribe();
      promotion.mockRestore();
      admission.mockRestore();
      dispatch.mockRestore();
    }
  }),
);
