import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { createRequestGate } from "./server-methods.request-gate.test-support.js";
import {
  createTranscriptUpdateBroadcastHandler,
  readSessionMessageByIdAsyncMock,
  runtimeConfigState,
  storedMessage,
} from "./server-session-events.test-support.js";
import { createSessionRowProjectionFixture } from "./session-row-projection.test-support.js";

export function registerTranscriptMarkerQueueTests() {
  it.for([
    "marker first",
    "keyed first",
    "keyed after resolution",
    "different store",
    "conflicting agent",
    "committed revision",
  ])("joins an unresolved marker to its keyed lane: %s", async (scenario, { signal }) => {
    const waitForGate = (gate: Promise<void>, task: Promise<unknown>, message: string) =>
      withinTest(awaitGateBeforeSettlement(gate, task, message), signal);
    const keyedFirst = scenario === "keyed first";
    const committedRevision = scenario === "committed revision";
    const keyedResolved = scenario === "keyed after resolution";
    const differentStore = scenario === "different store";
    const markerAgentId = scenario === "conflicting agent" ? "work" : undefined;
    const storePath = "/tmp/marker-queue-order.sqlite";
    const otherEntry = { sessionId: "sess-other", updatedAt: 1 };
    const otherTarget = {
      agentId: "main",
      sessionKey: "global",
      sessionId: otherEntry.sessionId,
      storePath: "/tmp/marker-queue-other.sqlite",
    };
    const otherRow = {
      agentId: "main",
      storeKey: "global",
      storeTarget: otherTarget,
      entry: otherEntry,
      readSourceEntry: () => undefined,
      resolveSourceKey: (key: string) => key,
    };
    const projection = createSessionRowProjectionFixture({
      cfg: runtimeConfigState.value,
      agentId: "main",
      storePath,
      store: {
        global: { sessionId: "sess-main", lifecycleRevision: "marker-revision", updatedAt: 1 },
        "agent:main:independent": { sessionId: "sess-independent", updatedAt: 1 },
        ...(differentStore ? { "agent:main:global": otherEntry } : {}),
      },
      targetsBySessionKey: differentStore ? new Map([["agent:main:global", otherRow]]) : undefined,
    });
    const membership = createRequestGate();
    const markerResolved = createDeferred();
    let markerReady = false;
    const findBySessionId = projection.findBySessionId.bind(projection);
    vi.spyOn(projection, "findBySessionId").mockImplementation((query) => {
      if (!markerReady) {
        return [];
      }
      const rows = findBySessionId(query);
      markerResolved.resolve();
      return rows;
    });
    vi.spyOn(projection, "prepareMembership").mockImplementation(async () => {
      await membership.pause();
      markerReady = true;
    });
    const earlierRead = createRequestGate();
    const publication = createRequestGate();
    const prepareRows = projection.withPreparedExactRows.bind(projection);
    let earlierQueries: Parameters<typeof prepareRows>[0] | undefined;
    let markerHeld = false;
    vi.spyOn(projection, "withPreparedExactRows").mockImplementation(
      async (queries, consume, options) => {
        const targets = queries(runtimeConfigState.value);
        if (targets.some((target) => target.key === "global" && target.storePath === storePath)) {
          if (keyedFirst && !earlierQueries) {
            earlierQueries = queries;
          }
          if (queries !== earlierQueries && !markerHeld) {
            markerHeld = true;
            await publication.pause();
          }
        }
        return prepareRows(() => targets, consume, options);
      },
    );
    readSessionMessageByIdAsyncMock.mockImplementation(async (_scope, id: string) => {
      if (id === "earlier") {
        await earlierRead.pause();
      }
      return storedMessage(id, 1);
    });
    const broadcastToConnIds = vi.fn();
    const handler = createTranscriptUpdateBroadcastHandler({
      broadcastToConnIds,
      sessionEventSubscribers: { getAll: () => new Set(["conn-1"]) },
      sessionMessageSubscribers: { get: () => new Set<string>() },
      getSessionRowProjection: () => projection,
    });
    const tasks: ReturnType<typeof handler>[] = [];
    const enqueue = (id: string, fields: Parameters<typeof handler>[0]) => {
      const task = handler({
        message: { role: "assistant", content: id },
        messageId: id,
        ...fields,
      });
      tasks.push(task);
      return task;
    };
    const publications = () =>
      broadcastToConnIds.mock.calls.map(([name, payload]) => [
        name,
        payload?.messageId ?? payload?.sessionKey,
      ]);
    try {
      if (keyedFirst) {
        void enqueue("earlier", {
          target: { agentId: "main", sessionId: "sess-main", sessionKey: "global", storePath },
        });
        await waitForGate(earlierRead.entered, tasks[0]!, "Earlier read did not start");
      }
      const markerUpdate = enqueue("marker", {
        sessionFile: `sqlite:main:sess-main:${storePath}`,
        ...(markerAgentId ? { agentId: markerAgentId } : {}),
        ...(committedRevision ? { lifecycleRevision: "marker-revision" } : {}),
        ...(keyedResolved ? {} : { messageSeq: 2 }),
      });
      const waitForPublication = () =>
        waitForGate(publication.entered, markerUpdate, "Marker publication did not prepare");
      await waitForGate(membership.entered, markerUpdate, "Marker readiness did not start");
      if (keyedResolved) {
        membership.release();
        await waitForPublication();
      }
      void enqueue("later", {
        sessionKey: "agent:main:global",
        ...(differentStore ? { target: otherTarget } : {}),
        messageSeq: 3,
      });
      const independent = enqueue("independent", {
        sessionKey: "agent:main:independent",
        messageSeq: 1,
      });
      await withinTest(independent, signal);
      expect(publications()).toEqual([["session.message", "independent"]]);
      membership.release();
      await waitForGate(markerResolved.promise, markerUpdate, "Marker key did not resolve");
      if (keyedFirst) {
        expect(publications()).toEqual([["session.message", "independent"]]);
      }
      earlierRead.release();
      await waitForPublication();
      const beforeMarker = [
        ["session.message", "independent"],
        ...(keyedFirst ? [["session.message", "earlier"]] : []),
      ];
      expect(publications()).toEqual(beforeMarker);
      publication.release();
      await Promise.all(tasks);
      expect(publications()).toEqual([
        ...beforeMarker,
        committedRevision ? ["session.message", "marker"] : ["sessions.changed", "global"],
        ["session.message", "later"],
      ]);
      const marker = broadcastToConnIds.mock.calls[keyedFirst ? 2 : 1];
      const expected = committedRevision
        ? {
            messageId: "marker",
            messageSeq: 2,
            message: expect.objectContaining({ role: "assistant", content: "marker" }),
          }
        : { sessionId: "sess-main", phase: "message" };
      expect(marker?.[1]).toMatchObject({ sessionKey: "global", ...expected });
      if (!committedRevision) {
        for (const field of ["message", "messageId", "messageSeq"]) {
          expect(marker?.[1]).not.toHaveProperty(field);
        }
      }
      expect(marker?.[3]).toMatchObject({ prepareSessionProjection: expect.any(Function) });
    } finally {
      membership.release();
      earlierRead.release();
      publication.release();
      await Promise.allSettled(tasks);
      projection.dispose();
    }
  });
}
