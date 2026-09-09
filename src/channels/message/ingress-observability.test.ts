import { describe, expect, it, vi } from "vitest";
import {
  CHANNEL_INGRESS_OBSERVABILITY_METADATA_KEY,
  CHANNEL_INGRESS_OBSERVABILITY_OWNER,
} from "./ingress-observability-contract.js";
import {
  createChannelIngressLifecycleObserver,
  observeChannelIngressDedupeWait,
} from "./ingress-observability-lifecycle.js";
import { buildChannelIngressObservabilitySnapshot } from "./ingress-observability-snapshot.js";

describe("channel ingress observability", () => {
  it("keeps same-millisecond live operations distinct and revokes them on lost ownership", async () => {
    const record = vi.fn(async () => true);
    const observer = createChannelIngressLifecycleObserver({
      now: () => 100,
      record,
      context: {
        eventId: "event-1",
        queueName: '["slack","workspace"]',
        channelId: "slack",
        accountId: "workspace",
      },
    });

    const first = observer.begin({ kind: "api", method: "conversations.history" });
    const second = observer.begin({ kind: "api", method: "users.info" });

    expect(observer.getActiveOperations()).toMatchObject([
      { id: "api:100:0", kind: "api", method: "conversations.history", eventId: "event-1" },
      { id: "api:100:1", kind: "api", method: "users.info", eventId: "event-1" },
    ]);
    first.finish();
    expect(observer.getActiveOperations()).toMatchObject([
      { id: "api:100:1", kind: "api", method: "users.info" },
    ]);
    await vi.waitFor(() => expect(record).toHaveBeenCalledTimes(3));

    record.mockResolvedValueOnce(false);
    observer.stage("thread_history", "slack_api");
    await vi.waitFor(() => expect(observer.getActiveOperations()).toEqual([]));
    expect(observer.getActiveOperationSnapshot()).toEqual({
      operations: [],
      unknownProgressEvents: [
        {
          eventId: "event-1",
          queueName: '["slack","workspace"]',
          channelId: "slack",
          accountId: "workspace",
        },
      ],
    });

    second.finish();
    expect(observer.getActiveOperations()).toEqual([]);
  });

  it("wraps pending dedupe waits without changing their result", async () => {
    const calls: string[] = [];
    const observer = createChannelIngressLifecycleObserver({
      now: () => 100,
      record: (update) => {
        if (update.stage) {
          calls.push(`${update.stage}:${update.blocker}`);
        }
        if (update.operation) {
          const value =
            update.operation.phase === "begin" ? update.operation.kind : update.operation.outcome;
          calls.push(`${update.operation.phase}:${value}`);
        }
        return true;
      },
    });

    await expect(
      observeChannelIngressDedupeWait(observer, Promise.resolve("claimed")),
    ).resolves.toBe("claimed");
    await vi.waitFor(() =>
      expect(calls).toEqual(["dedupe_wait:dedupe_owner", "begin:dedupe", "finish:completed"]),
    );
  });

  it("surfaces live operation truncation instead of undercounting silently", () => {
    const observer = createChannelIngressLifecycleObserver({
      now: () => 100,
      record: () => true,
      context: { eventId: "event-1", queueName: "queue", channelId: "slack", accountId: "team" },
    });
    observer.begin({ kind: "api", method: "oldest" });
    let overflowed: { finish: () => void } | undefined;
    for (let index = 0; index < 8; index += 1) {
      overflowed = observer.begin({ kind: "api", method: `method-${index}` });
    }

    const live = observer.getActiveOperationSnapshot();
    expect(live.operations).toHaveLength(8);
    expect(live.overflowByKind).toEqual({ api: 1 });

    const snapshot = buildChannelIngressObservabilitySnapshot({
      rows: [],
      sampledAt: 150,
      activeOperations: live,
    });
    expect(snapshot.operations.api).toMatchObject({
      kind: "api",
      total: 9,
      known: false,
      truncated: true,
      overflowCount: 1,
      oldestAgeMs: 50,
      oldest: { eventId: "event-1", method: "oldest", ageMs: 50 },
    });

    overflowed?.finish();
    expect(observer.getActiveOperationSnapshot().overflowByKind).toBeUndefined();
  });

  it("treats owned progress without lastProgressAt as unknown", () => {
    const metadataJson = JSON.stringify({
      [CHANNEL_INGRESS_OBSERVABILITY_METADATA_KEY]: {
        owner: CHANNEL_INGRESS_OBSERVABILITY_OWNER,
        schemaVersion: 1,
        stage: "thread_history",
        blocker: "slack_api",
        stageStartedAt: 100,
        updatedAt: 100,
      },
    });

    const snapshot = buildChannelIngressObservabilitySnapshot({
      sampledAt: 200,
      rows: [
        {
          event_id: "event-without-progress",
          channel_id: "slack",
          account_id: "workspace",
          queue_name: '["slack","workspace"]',
          status: "pending",
          metadata_json: metadataJson,
          received_at: 50,
          updated_at: 100,
          claimed_at: null,
        },
      ],
    });

    expect(snapshot.stages.thread_history.total).toBe(0);
    expect(snapshot.unknown).toMatchObject({
      total: 1,
      pending: 1,
      unknownProgress: 1,
      oldest: { id: "event-without-progress", progressKnown: false, stage: "unknown" },
    });
  });

  it("marks operation aggregates unknown after an observation write failure", () => {
    const snapshot = buildChannelIngressObservabilitySnapshot({
      sampledAt: 200,
      rows: [
        {
          event_id: "event-1",
          channel_id: "slack",
          account_id: "workspace",
          queue_name: '["slack","workspace"]',
          status: "claimed",
          metadata_json: null,
          received_at: 50,
          updated_at: 100,
          claimed_at: 100,
        },
      ],
      activeOperations: {
        operations: [],
        unknownProgressEvents: [
          {
            eventId: "event-1",
            queueName: '["slack","workspace"]',
            channelId: "slack",
            accountId: "workspace",
          },
        ],
      },
    });

    expect(snapshot.operations.api).toMatchObject({ total: 0, known: false });
    expect(snapshot.operations.dedupe).toMatchObject({ total: 0, known: false });
    expect(snapshot.operations.sleep).toMatchObject({ total: 0, known: false });
  });
});
