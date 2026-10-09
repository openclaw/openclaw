import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createSolidPngBuffer } from "../../test/helpers/image-fixtures.js";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
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
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import * as managedMedia from "./managed-image-attachments.js";
import { listManagedImageRecordEntries } from "./managed-image-record-store.js";
import * as recoveryRuntime from "./server-recovery-runtime-context.js";
import {
  configureRestartSessionEventMocks,
  createGeneratedMediaDeliveryEntry,
} from "./server-restart-sentinel.test-support.js";

const mocks = vi.hoisted(() => ({
  resolveSessionTarget:
    vi.fn<
      typeof import("./session-utils-store-worker.js").resolveGatewaySessionStoreTargetInWorker
    >(),
  loadSessionEntry: vi.fn<(typeof import("./session-utils.js"))["loadSessionEntry"]>(),
  captureSessionEventTarget:
    vi.fn<
      typeof import("../auto-reply/reply/session-event-handoff.js").captureSessionEventTargetForHost
    >(),
  enqueueSessionEvent:
    vi.fn<
      typeof import("../auto-reply/reply/session-event-handoff.js").enqueueSessionEventForHost
    >(),
}));

vi.mock("./session-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-utils.js")>()),
  loadSessionEntry: mocks.loadSessionEntry,
}));
// mock-isolation: Queued-owner cases use supplied session rows instead of real store discovery.
vi.mock("./session-utils-store-worker.js", () => ({
  resolveGatewaySessionStoreTargetInWorker: mocks.resolveSessionTarget,
}));

// mock-isolation: Drive adoption and settlement gates without admitting an actual session turn.
vi.mock("../auto-reply/reply/session-event-handoff.js", () => ({
  captureSessionEventTargetForHost: mocks.captureSessionEventTarget,
  enqueueSessionEventForHost: mocks.enqueueSessionEvent,
}));

const { deliverQueuedSessionDelivery } = await import("./server-restart-sentinel.js");
const deliveryContext = { channel: "telegram", to: "42", accountId: "work", threadId: "7" };
const cases = [
  {
    name: "legacy system event",
    loadedAgentId: "research",
    payload: { kind: "systemEvent", sessionKey: "global", text: "resume work" },
  },
  {
    name: "agent turn without a route",
    loadedAgentId: "research",
    payload: {
      kind: "agentTurn",
      sessionKey: "global",
      message: "resume work",
      messageId: "resume-1",
    },
  },
  {
    name: "replaced agent-turn session",
    loadedAgentId: "research",
    payload: {
      kind: "agentTurn",
      sessionKey: "global",
      message: "resume work",
      messageId: "resume-1",
      expectedSessionId: "old-session",
      route: { ...deliveryContext, chatType: "direct" },
    },
  },
] satisfies Array<{
  name: string;
  loadedAgentId: string;
  payload: QueuedSessionDeliveryPayload;
}>;

beforeEach(() => {
  vi.clearAllMocks();
  configureRestartSessionEventMocks(mocks, "current-session");
});

afterEach(() => vi.restoreAllMocks());

function mockEventSession(agentId = "main", sessionKey = "agent:main:main") {
  mocks.loadSessionEntry.mockReturnValue({
    cfg: {},
    agentId,
    entry: { sessionId: "current-session", updatedAt: 1 },
    store: {},
    storePath: "/tmp/restart-owner/openclaw-agent.sqlite",
    canonicalKey: sessionKey,
    storeKeys: [sessionKey],
    legacyKey: undefined,
  });
}

it.each(cases)(
  "binds $name to its destination without rewriting its queued key",
  async ({ loadedAgentId, payload }) => {
    await withOpenClawTestState(
      { label: "restart-event-owner", layout: "state-only" },
      async () => {
        mockEventSession(loadedAgentId, "global");
        const queueContext = captureOpenClawStateWorkerContext();
        const id = await queueStorage.enqueueSessionDelivery(
          { ...payload, deliveryContext },
          queueContext,
        );
        const entry = (await queueStorage.loadPendingSessionDelivery(id, queueContext))!;
        const original = structuredClone(entry);

        await deliverQueuedSessionDelivery({ deps: {}, entry, queueContext });

        expect(mocks.captureSessionEventTarget).toHaveBeenCalledExactlyOnceWith(
          "research",
          "global",
          expect.objectContaining({ env: queueContext.environment }),
        );
        expect(mocks.enqueueSessionEvent).toHaveBeenCalledExactlyOnceWith(
          "resume work",
          expect.objectContaining({
            agentId: "research",
            sessionKey: "global",
            deliveryContext,
            source: "restart",
            expectedTarget: expect.objectContaining({ agentId: "research", sessionKey: "global" }),
          }),
        );
        expect(entry).toEqual(original);
      },
    );
  },
);

it("carries a persisted owner through global session lookup in an explicit roster", async () => {
  const actual = await vi.importActual<typeof import("./session-utils-store-worker.js")>(
    "./session-utils-store-worker.js",
  );
  mocks.resolveSessionTarget.mockImplementation(actual.resolveGatewaySessionStoreTargetInWorker);
  const handoff = await vi.importActual<
    typeof import("../auto-reply/reply/session-event-handoff.js")
  >("../auto-reply/reply/session-event-handoff.js");
  mocks.captureSessionEventTarget.mockImplementation(handoff.captureSessionEventTargetForHost);
  await withOpenClawTestState(
    { label: "restart-queue-owner", layout: "state-only" },
    async (state) => {
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
      const queueContext = captureOpenClawStateWorkerContext();
      const id = await queueStorage.enqueueSessionDelivery(
        {
          kind: "systemEvent",
          sessionKey: "global",
          agentId: "research",
          text: "resume work",
          deliveryContext,
        },
        queueContext,
      );
      const entry = (await queueStorage.loadPendingSessionDelivery(id, queueContext))!;
      await deliverQueuedSessionDelivery({ deps: {}, queueContext, entry });

      expect(mocks.enqueueSessionEvent).toHaveBeenCalledWith(
        "resume work",
        expect.objectContaining({
          agentId: "research",
          sessionKey: "global",
          expectedTarget: expect.objectContaining({ sessionId: "research-session" }),
        }),
      );
    },
  );
});

it.each(["completed", "failed", "cancelled"] as const)(
  "retains durable custody until an adopted session event is %s",
  async (status) => {
    await withOpenClawTestState(
      { label: "restart-event-custody", layout: "state-only" },
      async () => {
        mockEventSession();
        const queueContext = captureOpenClawStateWorkerContext();
        const id = await queueStorage.enqueueSessionDelivery(
          {
            kind: "systemEvent",
            sessionKey: "agent:main:main",
            text: "resume work",
          },
          queueContext,
        );
        const adopted = createDeferred();
        const outcome =
          createDeferred<
            import("../auto-reply/reply/session-event-contract.js").SessionEventOutcome
          >();
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
        const drain = drainPendingSessionDelivery({
          id,
          queueContext,
          bypassBackoff: true,
          logLabel: "restart custody",
          log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
          deliver: (entry) => deliverQueuedSessionDelivery({ deps: {}, entry, queueContext }),
          onSettled,
        });
        try {
          await awaitGateBeforeSettlement(
            adopted.promise,
            drain,
            "Restart custody settled before adoption",
          );
          expect(await queueStorage.loadPendingSessionDelivery(id, queueContext)).toMatchObject({
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
        expect(await queueStorage.loadPendingSessionDelivery(id, queueContext)).toBeNull();
        expect(mocks.enqueueSessionEvent).toHaveBeenCalledOnce();
      },
    );
  },
);

it("keeps an event retryable when normal admission refuses it before adoption", async () => {
  await withOpenClawTestState({ label: "restart-event-retry", layout: "state-only" }, async () => {
    mockEventSession();
    const queueContext = captureOpenClawStateWorkerContext();
    const id = await queueStorage.enqueueSessionDelivery(
      {
        kind: "systemEvent",
        sessionKey: "agent:main:main",
        text: "resume work",
      },
      queueContext,
    );
    mocks.enqueueSessionEvent.mockReturnValueOnce({
      id: "refused-event",
      accepted: Promise.resolve({ ok: false, error: "session is busy" }),
      cancel: () => true,
      settled: Promise.resolve({
        status: "failed",
        executionStarted: false,
        delivered: false,
        error: "session is busy",
      }),
    });
    await drainPendingSessionDelivery({
      id,
      queueContext,
      bypassBackoff: true,
      logLabel: "restart admission",
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      deliver: (entry) => deliverQueuedSessionDelivery({ deps: {}, entry, queueContext }),
    });
    const pending = await queueStorage.loadPendingSessionDelivery(id, queueContext);
    expect(pending).toMatchObject({ id, retryCount: 1, lastError: "session is busy" });
    expect(pending?.deliveryStartedAt).toBeUndefined();
  });
});

it("does not hand off an event after its queue admission retires during the session read", async () => {
  await withOpenClawTestState(
    { label: "restart-event-read-retired", layout: "state-only" },
    async () => {
      mockEventSession();
      const queueContext = captureOpenClawStateWorkerContext();
      const resolveTarget = mocks.resolveSessionTarget.getMockImplementation()!;
      mocks.resolveSessionTarget.mockImplementationOnce(async (params) => {
        const target = await resolveTarget(params);
        await closeOpenClawStateDatabaseByPathAsync(queueContext.admission.databasePath);
        return target;
      });
      await expect(
        deliverQueuedSessionDelivery({
          deps: {},
          queueContext,
          entry: {
            id: "retired-read",
            kind: "systemEvent",
            sessionKey: "agent:main:main",
            text: "resume work",
            enqueuedAt: 1,
            retryCount: 0,
          },
        }),
      ).rejects.toThrow(StateDatabaseReadAdmissionInvalidatedError);
      expect(mocks.enqueueSessionEvent).not.toHaveBeenCalled();
    },
  );
});

it("joins managed media promotion before publishing an internal restart delivery", async (test) => {
  await withOpenClawTestState(
    { layout: "state-only", label: "restart-media-custody" },
    async (state) => {
      const sessionKey = "agent:main:media-completion";
      const sessionId = "media-completion-session";
      const storePath = state.statePath("agents", "main", "sessions", "sessions.json");
      const entry = { sessionId, updatedAt: 1 };
      await replaceSessionEntry({ agentId: "main", sessionKey, storePath }, entry);
      mocks.loadSessionEntry.mockReturnValue({
        cfg: {},
        agentId: "main",
        entry,
        store: {},
        storePath,
        canonicalKey: sessionKey,
        storeKeys: [sessionKey],
        legacyKey: undefined,
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
      const dispatch = vi
        .spyOn(recoveryRuntime, "dispatchGatewayLifecycleMethod")
        .mockResolvedValue({
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
      const delivery = deliverQueuedSessionDelivery({
        deps: {},
        queueContext: captureOpenClawStateWorkerContext(),
        entry: createGeneratedMediaDeliveryEntry({
          id: "media-completion",
          sessionKey,
          messageId: "image:media-completion:agent-loop",
          route: { channel: "webchat", to: sessionKey, chatType: "direct" },
          expectedMediaUrls: [mediaUrl],
          preparedMediaBlocks: { [mediaUrl]: blocks },
        }),
      });
      const outcome = delivery.then(
        () => {
          settled = true;
        },
        (error: unknown) => {
          settled = true;
          throw error;
        },
      );
      void outcome.catch(() => {});
      try {
        await racePromiseWithAbortSignal(
          Promise.race([
            promoting.promise,
            outcome.then(() => {
              throw new Error("Delivery never entered media promotion");
            }),
          ]),
          test.signal,
        );
        expect(settled).toBe(false);
        expect(updates).toEqual([]);
        expect(await listManagedImageRecordEntries({ stateDir: state.stateDir })).toMatchObject([
          { record: { messageId: null, retentionClass: "transient" } },
        ]);
        release.resolve();
        await outcome;
        expect(updates).toHaveLength(1);
        expect(updates[0]).toMatchObject({ messageId: expect.any(String) });
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
    },
  );
});
