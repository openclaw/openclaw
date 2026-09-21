import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import {
  createCoreGatewayMethodDescriptors,
  createGatewayMethodRegistry,
} from "../gateway/methods/registry.js";
import { coreGatewayHandlers, handleGatewayRequest } from "../gateway/server-methods.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  RespondFn,
} from "../gateway/server-methods/types.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import * as taskRuntime from "./runtime-internal.js";
import * as listenerState from "./task-registry-listener-state.js";
import * as taskRead from "./task-registry-read.js";
import { resetReadState, withReadState } from "./task-registry-read.test-support.js";
import * as taskState from "./task-registry-state.js";
import { configureTaskRegistryRuntime } from "./task-registry.store.js";
import { createTaskFixture, prepareTaskFixtureRead } from "./task-registry.test-support.js";
import type { TaskRecord } from "./task-registry.types.js";

afterEach(resetReadState);

function seedChildren() {
  return Array.from({ length: 9 }, (_, index) =>
    createTaskFixture("cli", {
      runId: `metadata-child-${index}`,
      childSessionKey: `agent:main:child:metadata-${index}`,
      requesterSessionKey: "agent:main:metadata-parent",
      ownerKey: "agent:main:metadata-parent",
      task: `Metadata child ${index}`,
      status: index < 8 ? "running" : "queued",
      notifyPolicy: "silent",
      deliveryStatus: "not_applicable",
      lastEventAt: 100 + index,
    }),
  );
}

function createTaskRequests(sessionKey: string) {
  const client: GatewayClient = {
    connId: "metadata-churn-reader",
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: {
        id: "openclaw-control-ui",
        version: "test",
        platform: "test",
        mode: "webchat",
      },
      role: "operator",
      scopes: ["operator.read"],
    },
  };
  const context = { getRuntimeConfig: () => ({}) } as GatewayRequestContext;
  const methodRegistry = createGatewayMethodRegistry(
    createCoreGatewayMethodDescriptors(coreGatewayHandlers),
  );
  return async (params: { limit?: number; cursor?: string } = {}, respond = vi.fn<RespondFn>()) => {
    await handleGatewayRequest({
      req: {
        type: "req",
        id: "metadata-task-read",
        method: "tasks.list",
        params: { sessionKey, limit: 100, ...params },
      },
      client,
      context,
      methodRegistry,
      isWebchatConnect: () => false,
      respond,
    });
    return respond;
  };
}

function emitTool(task: TaskRecord, name: string) {
  emitAgentEvent({
    runId: expectDefined(task.runId, "child run"),
    stream: "tool",
    data: { phase: "start", name },
  });
}

function metadataGate(task: TaskRecord, name: string) {
  return { task, name, entered: createDeferred(), release: createDeferred(), completed: false };
}

it("returns a nine-child capacity page without chasing metadata accepted after its read fence", async () => {
  await withReadState(async () => {
    const children = seedChildren();
    const first = expectDefined(children[0], "first child");
    const store = await prepareTaskFixtureRead(first);
    await taskRead.prepareTaskRegistryRead();
    const request = createTaskRequests(first.ownerKey);
    const prefix = metadataGate(first, "accepted-before-read");
    const later = children.slice(0, 8).map((task, index) => metadataGate(task, `later-${index}`));
    const captured = createDeferred();
    const observations = {
      fences: 0,
      preparationFailures: 0,
      unionSnapshots: 0,
      pageFailures: 0,
      responseRejections: 0,
      finishedLaterWritesAtResponse: 0,
      pendingLaterWritesAtResponse: 0,
    };
    let churning = true;
    let active: ReturnType<typeof metadataGate> | undefined;
    const releaseAll = () => {
      churning = false;
      prefix.release.resolve();
      for (const gate of later) {
        gate.release.resolve();
      }
    };
    const mutate = store.runAgentEventMutationAsync.bind(store);
    vi.spyOn(store, "runAgentEventMutationAsync").mockImplementation(async (...args) => {
      const name = args[1].change.patch.lastToolName;
      const gate = name === prefix.name ? prefix : later.find((entry) => entry.name === name);
      if (gate) {
        active = gate;
        gate.entered.resolve();
        await gate.release.promise;
      }
      const result = await mutate(...args);
      if (gate) {
        gate.completed = true;
      }
      return result;
    });
    const capture = listenerState.captureTaskRegistryReadFence;
    vi.spyOn(listenerState, "captureTaskRegistryReadFence").mockImplementation((admission) => {
      observations.fences += 1;
      if (observations.fences > 1) {
        // A retry must finish its real owners even when this assertion will fail.
        releaseAll();
      }
      const fence = capture(admission);
      if (observations.fences !== 1) {
        return fence;
      }
      captured.resolve();
      // Arrange a later writer at the consuming frame, without joining its completion.
      return fence.then(() => expectDefined(later[0], "first later writer").entered.promise);
    });
    const prepare = taskRead.prepareTaskRegistryRead;
    vi.spyOn(taskRead, "prepareTaskRegistryRead").mockImplementation((...args) => {
      const result = prepare(...args);
      void result.then(
        (read) => {
          if (!read) {
            observations.preparationFailures += 1;
          }
        },
        () => {},
      );
      return result;
    });
    const select = taskRuntime.listTaskRecordPage;
    vi.spyOn(taskRuntime, "listTaskRecordPage").mockImplementation((...args) => {
      const result = select(...args);
      void result.then(
        (page) => {
          if (!page.ok) {
            observations.pageFailures += 1;
            return;
          }
          const current = page.value.isCurrent;
          page.value.isCurrent = () => {
            const valid = current();
            if (!valid) {
              observations.responseRejections += 1;
            }
            return valid;
          };
        },
        () => {},
      );
      return result;
    });
    const load = store.loadMutationSnapshotAsync.bind(store);
    vi.spyOn(store, "loadMutationSnapshotAsync").mockImplementation(async (...args) => {
      const snapshot = await load(...args);
      if (Array.isArray(args[1])) {
        observations.unionSnapshots += 1;
        // Eight initial writers plus nine successors bound all retry-layer interleavings.
        if (churning && active && active !== prefix && later.length < 17) {
          const current = active;
          const followup = metadataGate(current.task, `later-${later.length}`);
          later.push(followup);
          emitTool(followup.task, followup.name);
          const next = expectDefined(later[later.indexOf(current) + 1], "next metadata writer");
          current.release.resolve();
          // The next store entry proves its predecessor completed publication too.
          await withTestTimeout(next.entered.promise, 5_000, "Metadata writer did not advance");
        }
      }
      return snapshot;
    });
    const respond = vi.fn<RespondFn>(() => {
      observations.finishedLaterWritesAtResponse = later.filter((gate) => gate.completed).length;
      observations.pendingLaterWritesAtResponse = later.filter((gate) => !gate.completed).length;
    });
    let reading: ReturnType<typeof request> | undefined;
    let readingSettled:
      | Promise<PromiseSettledResult<Awaited<ReturnType<typeof request>>>[]>
      | undefined;
    try {
      emitTool(first, prefix.name);
      await withTestTimeout(prefix.entered.promise, 5_000, "Accepted prefix did not enter");
      reading = request({}, respond);
      readingSettled = Promise.allSettled([reading]);
      await withTestTimeout(
        captured.promise,
        5_000,
        "Registered task read did not capture a fence",
      );
      expect(respond).not.toHaveBeenCalled();
      for (const gate of later) {
        emitTool(gate.task, gate.name);
      }
      prefix.release.resolve();
      await withTestTimeout(reading, 5_000, "Task read chased later metadata indefinitely");
      const detail = JSON.stringify(observations);
      expect(respond, detail).toHaveBeenCalledOnce();
      expect(respond.mock.calls[0], detail).toMatchObject([
        true,
        {
          tasks: expect.arrayContaining(
            children.map((task) =>
              expect.objectContaining({ id: task.taskId, status: task.status }),
            ),
          ),
        },
      ]);
      expect(respond.mock.calls[0]?.[1], detail).toHaveProperty("tasks.length", 9);
      const payload = respond.mock.calls[0]?.[1];
      if (!isRecord(payload) || !Array.isArray(payload.tasks)) {
        throw new Error(`Expected the registered task page: ${detail}`);
      }
      const firstSummary = payload.tasks.find((task) => isRecord(task) && task.id === first.taskId);
      expect(
        isRecord(firstSummary) ? firstSummary.toolUseCount : undefined,
        detail,
      ).toBeGreaterThanOrEqual(1);
      expect(observations.pendingLaterWritesAtResponse, detail).toBeGreaterThan(0);
      expect(observations.preparationFailures, detail).toBe(0);
      expect(observations.responseRejections, detail).toBe(0);
    } finally {
      releaseAll();
      await readingSettled;
      await taskRead.prepareTaskRegistryReadOwner();
    }
    expect(later.every((gate) => gate.completed)).toBe(true);
    for (const child of children.slice(0, 8)) {
      const expected =
        later.filter((gate) => gate.task === child).length + (child === first ? 1 : 0);
      expect(taskState.tasks.get(child.taskId)?.toolUseCount).toBe(expected);
    }
    const queued = expectDefined(children[8], "queued child");
    expect(taskState.tasks.get(queued.taskId)?.status).toBe("queued");
  });
});

it.each(["broad invalidation", "orphaned publication", "non-preserved mutation"] as const)(
  "refreshes task ownership despite later metadata when there is %s",
  async (change) => {
    await withReadState(async () => {
      const children = seedChildren();
      const first = expectDefined(children[0], "first child");
      const later = metadataGate(expectDefined(children[1], "later child"), "after-read-fence");
      const store = await prepareTaskFixtureRead(first);
      await taskRead.prepareTaskRegistryRead();
      const context = captureOpenClawStateWorkerContext();
      const request = createTaskRequests(first.ownerKey);
      const captured = createDeferred();
      const prepared = createDeferred();
      const releaseMutation = createDeferred();
      const releaseAll = () => {
        prepared.resolve();
        later.release.resolve();
        releaseMutation.resolve();
      };
      const mutate = store.runAgentEventMutationAsync.bind(store);
      vi.spyOn(store, "runAgentEventMutationAsync").mockImplementation(async (...args) => {
        if (args[1].change.patch.lastToolName === later.name) {
          later.entered.resolve();
          await later.release.promise;
          const result = await mutate(...args);
          later.completed = true;
          return result;
        }
        return mutate(...args);
      });
      const capture = listenerState.captureTaskRegistryReadFence;
      let firstFence = true;
      vi.spyOn(listenerState, "captureTaskRegistryReadFence").mockImplementation((admission) => {
        if (!firstFence) {
          // A retry still joins its real writers, even if the first read was unsafe.
          releaseAll();
          return capture(admission);
        }
        firstFence = false;
        const fence = capture(admission);
        captured.resolve();
        return fence.then(() => prepared.promise);
      });
      const fresh = {
        ...first,
        requesterSessionKey: "agent:main:other-parent",
        ownerKey: "agent:main:other-parent",
      };
      const scope = { taskId: first.taskId };
      const failure = new Error("Synthetic publication read failure");
      const publicationError = vi.fn();
      const load = store.loadMutationSnapshotAsync.bind(store);
      const respond = vi.fn<RespondFn>();
      const reading = request({}, respond);
      const readingSettled = Promise.allSettled([reading]);
      let mutation: Promise<void> | undefined;
      try {
        await withTestTimeout(captured.promise, 5_000, "Task read did not capture its prefix");
        emitTool(later.task, later.name);
        await withTestTimeout(later.entered.promise, 5_000, "Later metadata writer did not enter");
        if (change === "broad invalidation") {
          store.upsertTaskWithDeliveryState({ task: fresh });
          taskState.invalidateTaskRegistryProjection();
        } else {
          mutation = taskState.runTaskRegistryWorkerMutation(
            {
              scope,
              admission: context.admission,
              publicationRecords: () => new Map(),
              onPublicationError: publicationError,
            },
            async () => {
              store.upsertTaskWithDeliveryState({ task: fresh });
              if (change === "non-preserved mutation") {
                await releaseMutation.promise;
              }
            },
            () => {
              if (change === "orphaned publication") {
                throw failure;
              }
              return load(context, scope);
            },
          );
          if (change === "orphaned publication") {
            await mutation;
            expect(publicationError).toHaveBeenCalledExactlyOnceWith(failure);
          }
        }
        expect(listenerState.hasPendingTaskRegistryEvents(later.task.taskId)).toBe(true);
        expect(taskState.tasks.get(first.taskId)?.ownerKey).toBe(first.ownerKey);
        expect(respond).not.toHaveBeenCalled();
        prepared.resolve();
        await withTestTimeout(reading, 5_000, "Task read did not settle its changed ownership");
        expect(respond).toHaveBeenCalledOnce();
        expect(respond.mock.calls[0]).toMatchObject([
          true,
          {
            tasks: expect.arrayContaining(
              children.slice(1).map((task) => expect.objectContaining({ id: task.taskId })),
            ),
          },
        ]);
        expect(respond.mock.calls[0]?.[1]).toHaveProperty("tasks.length", 8);
        expect(later.completed).toBe(false);
      } finally {
        releaseAll();
        await Promise.allSettled([readingSettled, mutation]);
        await taskRead.prepareTaskRegistryReadOwner();
      }
      expect(later.completed).toBe(true);
      expect(taskState.tasks.get(first.taskId)?.ownerKey).toBe(fresh.ownerKey);
    });
  },
);

it.each(["metadata update", "retired store"] as const)(
  "retains exact cursor and live-owner rejection after nine-child selection: %s",
  async (change) => {
    await withReadState(async () => {
      const children = seedChildren();
      const first = expectDefined(children[0], "first child");
      const store = await prepareTaskFixtureRead(first);
      const request = createTaskRequests(first.ownerKey);
      const firstPage = await request({ limit: 4 });
      const payload = firstPage.mock.calls[0]?.[1];
      if (!isRecord(payload) || typeof payload.nextCursor !== "string") {
        throw new Error("Expected a cursor bound to the nine-child page");
      }
      if (change === "metadata update") {
        emitTool(first, "after-first-page");
        await taskRead.prepareTaskRegistryReadOwner();
      } else {
        const select = taskRuntime.listTaskRecordPage;
        vi.spyOn(taskRuntime, "listTaskRecordPage").mockImplementationOnce(async (...args) => {
          const page = await select(...args);
          if (page.ok) {
            configureTaskRegistryRuntime({ store: { ...store } });
          }
          return page;
        });
      }
      try {
        const nextPage = await request({ limit: 4, cursor: payload.nextCursor });
        expect(nextPage.mock.calls).toEqual([
          [false, undefined, expect.objectContaining({ code: "INVALID_REQUEST" })],
        ]);
      } finally {
        configureTaskRegistryRuntime({ store });
        await taskRead.prepareTaskRegistryReadOwner();
      }
    });
  },
);
