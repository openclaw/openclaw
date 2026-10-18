import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
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
    const hasEarlierKeyedUpdate = scenario === "keyed first";
    const committedRevision = scenario === "committed revision";
    const keyedAfterResolution = scenario === "keyed after resolution";
    const differentStore = scenario === "different store";
    const markerAgentId = scenario === "conflicting agent" ? "work" : undefined;
    const storePath = "/tmp/marker-queue-order.sqlite";
    const otherStorePath = "/tmp/marker-queue-other.sqlite";
    const otherEntry = { sessionId: "sess-other", updatedAt: 1 };
    const projection = createSessionRowProjectionFixture({
      cfg: runtimeConfigState.value,
      agentId: "main",
      storePath,
      store: {
        global: { sessionId: "sess-main", lifecycleRevision: "marker-revision", updatedAt: 1 },
        "agent:main:independent": { sessionId: "sess-independent", updatedAt: 1 },
        ...(differentStore ? { "agent:main:global": otherEntry } : {}),
      },
      targetsBySessionKey: differentStore
        ? new Map([
            [
              "agent:main:global",
              {
                agentId: "main",
                storeKey: "global",
                storeTarget: { agentId: "main", storePath: otherStorePath },
                entry: otherEntry,
                readSourceEntry: () => undefined,
                resolveSourceKey: (key) => key,
              },
            ],
          ])
        : undefined,
    });
    const membershipEntered = createDeferred();
    const releaseMembership = createDeferred();
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
      membershipEntered.resolve();
      await releaseMembership.promise;
      markerReady = true;
    });
    const earlierReadEntered = createDeferred();
    const releaseEarlierRead = createDeferred();
    const markerPublicationEntered = createDeferred();
    const releaseMarkerPublication = createDeferred();
    const prepareRows = projection.withPreparedExactRows.bind(projection);
    let earlierQueries: Parameters<typeof prepareRows>[0] | undefined;
    let markerHeld = false;
    vi.spyOn(projection, "withPreparedExactRows").mockImplementation(
      async (queries, consume, options) => {
        const targets = queries(runtimeConfigState.value);
        if (targets.some((target) => target.key === "global" && target.storePath === storePath)) {
          if (hasEarlierKeyedUpdate && !earlierQueries) {
            earlierQueries = queries;
          }
          if (queries !== earlierQueries && !markerHeld) {
            markerHeld = true;
            markerPublicationEntered.resolve();
            await releaseMarkerPublication.promise;
          }
        }
        return prepareRows(() => targets, consume, options);
      },
    );
    readSessionMessageByIdAsyncMock.mockImplementation(async (_scope, id: string) => {
      if (id === "earlier") {
        earlierReadEntered.resolve();
        await releaseEarlierRead.promise;
      }
      return storedMessage(id, 1);
    });
    const broadcastToConnIds = vi.fn();
    const handler = createTranscriptUpdateBroadcastHandler({
      broadcastToConnIds,
      sessionEventSubscribers: { getAll: () => new Set(["conn-1"]) },
      sessionMessageSubscribers: { get: () => new Set<string>() },
      chatAbortControllers: new Map(),
      getSessionRowProjection: () => projection,
    });
    const tasks: ReturnType<typeof handler>[] = [];
    const publications = () =>
      broadcastToConnIds.mock.calls.map(([name, payload]) => [
        name,
        payload?.messageId ?? payload?.sessionKey,
      ]);
    try {
      if (hasEarlierKeyedUpdate) {
        tasks.push(
          handler({
            target: { agentId: "main", sessionId: "sess-main", sessionKey: "global", storePath },
            message: { role: "assistant", content: "earlier" },
            messageId: "earlier",
          }),
        );
        await withinTest(
          awaitGateBeforeSettlement(
            earlierReadEntered.promise,
            tasks[0]!,
            "Earlier read did not start",
          ),
          signal,
        );
      }
      const markerUpdate = handler({
        sessionFile: `sqlite:main:sess-main:${storePath}`,
        ...(markerAgentId ? { agentId: markerAgentId } : {}),
        ...(committedRevision ? { lifecycleRevision: "marker-revision" } : {}),
        message: { role: "assistant", content: "marker" },
        messageId: "marker",
        ...(keyedAfterResolution ? {} : { messageSeq: 2 }),
      });
      tasks.push(markerUpdate);
      await withinTest(
        awaitGateBeforeSettlement(
          membershipEntered.promise,
          markerUpdate,
          "Marker readiness did not start",
        ),
        signal,
      );
      if (keyedAfterResolution) {
        releaseMembership.resolve();
        await withinTest(
          awaitGateBeforeSettlement(
            markerPublicationEntered.promise,
            markerUpdate,
            "Resolved marker publication did not prepare",
          ),
          signal,
        );
      }
      tasks.push(
        handler({
          sessionKey: "agent:main:global",
          ...(differentStore
            ? {
                target: {
                  agentId: "main",
                  sessionKey: "global",
                  sessionId: otherEntry.sessionId,
                  storePath: otherStorePath,
                },
              }
            : {}),
          message: { role: "assistant", content: "later" },
          messageId: "later",
          messageSeq: 3,
        }),
      );
      const independent = handler({
        sessionKey: "agent:main:independent",
        message: { role: "assistant", content: "independent" },
        messageId: "independent",
        messageSeq: 1,
      });
      tasks.push(independent);
      await withinTest(independent, signal);
      expect(publications()).toEqual([["session.message", "independent"]]);
      releaseMembership.resolve();
      await withinTest(
        awaitGateBeforeSettlement(
          markerResolved.promise,
          markerUpdate,
          "Marker key did not resolve",
        ),
        signal,
      );
      if (hasEarlierKeyedUpdate) {
        expect(publications()).toEqual([["session.message", "independent"]]);
      }
      releaseEarlierRead.resolve();
      await withinTest(
        awaitGateBeforeSettlement(
          markerPublicationEntered.promise,
          markerUpdate,
          "Resolved marker publication did not prepare",
        ),
        signal,
      );
      expect(publications()).toEqual([
        ["session.message", "independent"],
        ...(hasEarlierKeyedUpdate ? [["session.message", "earlier"]] : []),
      ]);
      releaseMarkerPublication.resolve();
      await Promise.all(tasks);
      expect(publications()).toEqual([
        ["session.message", "independent"],
        ...(hasEarlierKeyedUpdate ? [["session.message", "earlier"]] : []),
        committedRevision ? ["session.message", "marker"] : ["sessions.changed", "global"],
        ["session.message", "later"],
      ]);
      const marker = broadcastToConnIds.mock.calls[hasEarlierKeyedUpdate ? 2 : 1];
      if (committedRevision) {
        expect(marker?.[1]).toMatchObject({
          sessionKey: "global",
          messageId: "marker",
          messageSeq: 2,
          message: expect.objectContaining({ role: "assistant", content: "marker" }),
        });
      } else {
        expect(marker?.[1]).toMatchObject({
          sessionKey: "global",
          sessionId: "sess-main",
          phase: "message",
        });
        expect(marker?.[1]).not.toHaveProperty("message");
        expect(marker?.[1]).not.toHaveProperty("messageId");
        expect(marker?.[1]).not.toHaveProperty("messageSeq");
      }
      expect(marker?.[3]).toMatchObject({ prepareSessionProjection: expect.any(Function) });
    } finally {
      releaseMembership.resolve();
      releaseEarlierRead.resolve();
      releaseMarkerPublication.resolve();
      await Promise.allSettled(tasks);
      projection.dispose();
    }
  });
}
