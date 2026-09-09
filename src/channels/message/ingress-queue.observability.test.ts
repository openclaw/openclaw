import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { getDiagnosticIngressSnapshot } from "./ingress-diagnostic-registry.js";
import {
  CHANNEL_INGRESS_OBSERVABILITY_METADATA_KEY,
  type ChannelIngressActiveOperationsSnapshot,
} from "./ingress-observability-contract.js";
import { createChannelIngressQueue } from "./ingress-queue.js";

type DiagnosticActiveOperations =
  | ChannelIngressActiveOperationsSnapshot
  | ChannelIngressActiveOperationsSnapshot["operations"];

type DiagnosticSourceQueue = {
  registerDiagnosticSource?: (getActiveOperations: () => DiagnosticActiveOperations) => () => void;
};

function createTestIngressQueue<TPayload, TMetadata = unknown, TCompletedMetadata = unknown>(
  stateDir: string,
  options: Omit<
    Parameters<typeof createChannelIngressQueue>[0],
    "channelId" | "accountId" | "stateDir"
  > = {},
) {
  return createChannelIngressQueue<TPayload, TMetadata, TCompletedMetadata>({
    channelId: "test",
    accountId: "account",
    stateDir,
    ...options,
  });
}

async function withTempState<T>(fn: (stateDir: string) => Promise<T>): Promise<T> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ingress-queue-"));
  try {
    return await fn(stateDir);
  } finally {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

function openIngressStateDatabase(stateDir: string) {
  return openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } });
}

async function readDiagnosticIngressSnapshotThroughQueue(
  queue: DiagnosticSourceQueue,
  sampledAt: number,
  activeOperations: DiagnosticActiveOperations = [],
) {
  const unregister = queue.registerDiagnosticSource?.(() => activeOperations);
  if (!unregister) {
    throw new Error("Expected queue diagnostic source registration");
  }
  try {
    return await getDiagnosticIngressSnapshot(sampledAt);
  } finally {
    unregister();
  }
}

describe("channel ingress queue observability", () => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
  });

  it("records claim-fenced progress and reports active operations from live owners only", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue<{ text: string }, { provider: string }>(stateDir, {
        now: () => 10,
      });

      await queue.enqueue("older-row", { text: "before observer" }, { receivedAt: 10 });
      openIngressStateDatabase(stateDir)
        .db.prepare(
          `UPDATE channel_ingress_events
             SET metadata_json = NULL
           WHERE queue_name = ? AND event_id = ?`,
        )
        .run(JSON.stringify(["test", "account"]), "older-row");
      await queue.enqueue(
        "event-1",
        { text: "observed" },
        { metadata: { provider: "slack" }, receivedAt: 20 },
      );
      const claim = await queue.claim("event-1", { ownerId: "worker" });
      if (!claim) {
        throw new Error("Expected observed claim");
      }

      await expect(
        queue.updateProgress?.(claim, {
          stage: "user_channel_lookup",
          blocker: "slack_api",
          observedAt: 100,
          progressAt: 100,
          correlation: {
            providerEventType: "message",
            teamId: "T1",
            channelId: "C1",
            messageTs: "123.456",
          },
        }),
      ).resolves.toBe(true);
      await expect(
        queue.updateProgress?.(
          { id: claim.id, claim: { token: "stale-token" } },
          { stage: "thread_history", observedAt: 110, progressAt: 110 },
        ),
      ).resolves.toBe(false);
      await expect(
        queue.updateProgress?.(claim, {
          correlation: {
            threadTs: "123.456",
            sessionId: "session-1",
          },
          observedAt: 105,
        }),
      ).resolves.toBe(true);
      await expect(
        queue.updateProgress?.(claim, {
          operation: {
            phase: "begin",
            id: "persisted-but-not-live",
            kind: "api",
            method: "conversations.history",
            profile: "read",
            startedAt: 120,
          },
          observedAt: 120,
        }),
      ).resolves.toBe(true);
      await queue.enqueue("previous-turn", { text: "waiting" }, { receivedAt: 30 });
      const waitingClaim = await queue.claim("previous-turn", { ownerId: "worker" });
      if (!waitingClaim) {
        throw new Error("Expected waiting claim");
      }
      await expect(
        queue.updateProgress?.(waitingClaim, {
          stage: "thread_history",
          blocker: "previous_turn",
          observedAt: 80,
          progressAt: 80,
        }),
      ).resolves.toBe(true);

      const snapshot = await readDiagnosticIngressSnapshotThroughQueue(queue, 200, [
        {
          id: "live-api",
          kind: "api",
          startedAt: 150,
          method: "conversations.history",
          profile: "read",
          eventId: "event-1",
        },
      ]);

      expect(snapshot).toMatchObject({
        type: "ingress.snapshot",
        schemaVersion: 1,
        sampledAt: 200,
        status: "known",
        isolationAvailable: false,
        failedCount: 0,
      });
      expect(snapshot.stages.user_channel_lookup).toMatchObject({
        total: 1,
        claimed: 1,
        eligibleNoProgressCount: 1,
        maxEligibleNoProgressAgeMs: 100,
        oldest: {
          id: "event-1",
          blocker: "slack_api",
          progressKnown: true,
          noProgressAgeMs: 100,
          correlation: {
            providerEventType: "message",
            teamId: "T1",
            channelId: "C1",
            messageTs: "123.456",
          },
        },
      });
      expect(snapshot.stages.user_channel_lookup.blockers.slack_api).toMatchObject({
        total: 1,
        claimed: 1,
        oldestReceiptAgeMs: 180,
      });
      expect(snapshot.stages.thread_history).toMatchObject({
        total: 1,
        claimed: 1,
        eligibleNoProgressCount: 0,
      });
      expect(snapshot.stages.thread_history.maxEligibleNoProgressAgeMs).toBeUndefined();
      expect(snapshot.stages.thread_history.blockers.previous_turn).toMatchObject({
        total: 1,
        claimed: 1,
      });
      expect(snapshot.unknown).toMatchObject({
        total: 1,
        pending: 1,
        unknownProgress: 1,
        oldest: { id: "older-row", progressKnown: false, stage: "unknown" },
      });
      expect(snapshot.operations.api).toMatchObject({
        kind: "api",
        total: 1,
        known: true,
        truncated: false,
        overflowCount: 0,
        oldestAgeMs: 50,
        oldest: {
          id: "live-api",
          kind: "api",
          method: "conversations.history",
          profile: "read",
          eventId: "event-1",
          ageMs: 50,
        },
      });

      const failedObserverSnapshot = await readDiagnosticIngressSnapshotThroughQueue(queue, 200, {
        operations: [],
        unknownProgressEvents: [
          {
            eventId: "event-1",
            queueName: '["test","account"]',
            channelId: "test",
            accountId: "account",
          },
        ],
      });
      expect(failedObserverSnapshot.stages.user_channel_lookup.total).toBe(0);
      expect(failedObserverSnapshot.unknown).toMatchObject({
        total: 2,
        pending: 1,
        claimed: 1,
        unknownProgress: 2,
      });
    });
  });

  it("reports unknown without recreating storage when the registered queue database path disappears", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue<{ text: string }>(stateDir);
      await queue.enqueue("event-1", { text: "stored" }, { receivedAt: 10 });
      const databasePath = openIngressStateDatabase(stateDir).path;
      await expect(fs.access(databasePath)).resolves.toBeUndefined();

      const unregister = queue.registerDiagnosticSource?.(() => []);
      if (!unregister) {
        throw new Error("Expected queue diagnostic source registration");
      }
      try {
        await fs.rm(databasePath, { force: true });
        await expect(fs.access(databasePath)).rejects.toMatchObject({ code: "ENOENT" });

        const snapshot = await getDiagnosticIngressSnapshot(200);

        expect(snapshot).toMatchObject({
          type: "ingress.snapshot",
          schemaVersion: 1,
          sampledAt: 200,
          status: "unknown",
          failedCount: 0,
          unknown: {
            total: 0,
            pending: 0,
            claimed: 0,
            unknownProgress: 0,
          },
        });
        expect(
          Object.values(snapshot.stages).every(
            (stage) =>
              stage.total === 0 &&
              stage.pending === 0 &&
              stage.claimed === 0 &&
              stage.unknownProgress === 0,
          ),
        ).toBe(true);
        expect(Object.values(snapshot.operations).every((operation) => operation.total === 0)).toBe(
          true,
        );
        await expect(fs.access(databasePath)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        unregister();
      }
    });
  });

  it("reports unknown when a registered queue owner is closed before sampling", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue<{ text: string }>(stateDir);
      await queue.enqueue("event-1", { text: "stored" }, { receivedAt: 10 });

      const unregister = queue.registerDiagnosticSource?.(() => []);
      if (!unregister) {
        throw new Error("Expected queue diagnostic source registration");
      }
      try {
        closeOpenClawStateDatabaseForTest();

        const snapshot = await getDiagnosticIngressSnapshot(200);

        expect(snapshot).toMatchObject({
          type: "ingress.snapshot",
          sampledAt: 200,
          status: "unknown",
          unknown: {
            total: 0,
            pending: 0,
            claimed: 0,
            unknownProgress: 0,
          },
        });
      } finally {
        unregister();
      }
    });
  });

  it("reports unknown instead of reading dirty rows from a registered queue transaction", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue<{ text: string }>(stateDir);
      await queue.enqueue("event-1", { text: "stored" }, { receivedAt: 10 });
      const database = openIngressStateDatabase(stateDir);

      const unregister = queue.registerDiagnosticSource?.(() => []);
      if (!unregister) {
        throw new Error("Expected queue diagnostic source registration");
      }
      try {
        database.db.exec("BEGIN;");
        database.db
          .prepare(
            `UPDATE channel_ingress_events
                SET received_at = ?, updated_at = ?
              WHERE queue_name = ? AND event_id = ?`,
          )
          .run(20, 20, JSON.stringify(["test", "account"]), "event-1");

        const snapshot = await getDiagnosticIngressSnapshot(200);

        expect(snapshot).toMatchObject({
          status: "unknown",
          unknown: {
            total: 0,
            pending: 0,
            claimed: 0,
            unknownProgress: 0,
          },
        });
      } finally {
        if (database.db.isTransaction) {
          database.db.exec("ROLLBACK;");
        }
        unregister();
      }
    });
  });

  it("preserves non-object provider metadata byte-for-byte as unknown ingress progress", async () => {
    await withTempState(async (stateDir) => {
      const primitiveQueue = createTestIngressQueue<{ text: string }, string>(stateDir);
      const arrayQueue = createChannelIngressQueue<{ text: string }, unknown[]>({
        channelId: "test",
        accountId: "array",
        stateDir,
      });

      await primitiveQueue.enqueue(
        "primitive",
        { text: "primitive" },
        {
          metadata: "provider-token",
          receivedAt: 10,
        },
      );
      await arrayQueue.enqueue(
        "array",
        { text: "array" },
        {
          metadata: ["provider", "tuple"],
          receivedAt: 20,
        },
      );

      await expect(primitiveQueue.listPending()).resolves.toMatchObject([
        { id: "primitive", metadata: "provider-token" },
      ]);
      await expect(arrayQueue.listPending()).resolves.toMatchObject([
        { id: "array", metadata: ["provider", "tuple"] },
      ]);

      const snapshot = await readDiagnosticIngressSnapshotThroughQueue(primitiveQueue, 100);
      expect(snapshot.unknown).toMatchObject({
        total: 2,
        pending: 2,
        unknownProgress: 2,
      });
    });
  });

  it("preserves provider-owned ingressProgress collisions without changing claim behavior", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue<
        { text: string },
        Record<string, unknown>,
        Record<string, unknown>
      >(stateDir);
      const objectCollision = { provider: "slack", ingressProgress: { providerOwned: true } };
      const stringCollision = { provider: "slack", ingressProgress: "provider-owned" };
      const schemaShapedCollision = {
        provider: "slack",
        ingressProgress: {
          schemaVersion: 1,
          stage: "queued",
          blocker: "none",
          stageStartedAt: 1,
          updatedAt: 1,
        },
      };

      await queue.enqueue(
        "object-collision",
        { text: "fail" },
        { metadata: objectCollision, receivedAt: 10 },
      );
      await queue.enqueue(
        "string-collision",
        { text: "complete" },
        { metadata: stringCollision, receivedAt: 20 },
      );
      await queue.enqueue(
        "schema-shaped",
        { text: "pending" },
        { metadata: schemaShapedCollision, receivedAt: 30 },
      );

      const objectClaim = await queue.claim("object-collision", { ownerId: "worker" });
      const stringClaim = await queue.claim("string-collision", { ownerId: "worker" });
      if (!objectClaim || !stringClaim) {
        throw new Error("Expected claims for colliding metadata rows");
      }
      await expect(
        queue.updateProgress?.(objectClaim, {
          stage: "thread_history",
          observedAt: 40,
          progressAt: 40,
        }),
      ).resolves.toBe(false);
      await expect(
        queue.updateProgress?.(stringClaim, {
          stage: "thread_history",
          observedAt: 45,
          progressAt: 45,
        }),
      ).resolves.toBe(false);
      await expect(
        queue.fail(objectClaim, { reason: "poison", message: "bad", failedAt: 50 }),
      ).resolves.toBe(true);
      await expect(
        queue.complete(stringClaim, {
          completedAt: 60,
          metadata: { handledBy: "worker", ingressProgress: "provider-complete" },
        }),
      ).resolves.toBe(true);

      await expect(queue.listFailed?.()).resolves.toMatchObject([
        { id: "object-collision", metadata: objectCollision },
      ]);
      const completed = await queue.enqueue("string-collision", { text: "duplicate" });
      expect(completed.kind).toBe("completed");
      if (completed.kind !== "completed") {
        throw new Error(`Expected completed duplicate, got ${completed.kind}`);
      }
      expect(completed.record.metadata).toMatchObject({
        handledBy: "worker",
        ingressProgress: "provider-complete",
      });

      const resubmitted = await queue.resubmit?.("object-collision", { resubmittedAt: 70 });
      expect(resubmitted?.kind).toBe("resubmitted");
      await expect(queue.listPending({ orderBy: "id" })).resolves.toMatchObject([
        { id: "object-collision", metadata: objectCollision },
        { id: "schema-shaped", metadata: schemaShapedCollision },
      ]);
      const snapshot = await readDiagnosticIngressSnapshotThroughQueue(queue, 100);
      expect(snapshot.unknown).toMatchObject({ total: 2, pending: 2, unknownProgress: 2 });
    });
  });

  it("preserves progress across automatic retry without resetting no-progress age", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue<{ text: string }>(stateDir);
      await queue.enqueue("event-1", { text: "retry" }, { receivedAt: 10 });
      const firstClaim = await queue.claim("event-1", { ownerId: "first" });
      if (!firstClaim) {
        throw new Error("Expected first claim");
      }

      await expect(
        queue.updateProgress?.(firstClaim, {
          stage: "thread_history",
          blocker: "slack_api",
          observedAt: 100,
          progressAt: 100,
        }),
      ).resolves.toBe(true);
      await expect(
        queue.release(firstClaim, { lastError: "retry", releasedAt: 120 }),
      ).resolves.toBe(true);
      const secondClaim = await queue.claim("event-1", { ownerId: "second" });
      if (!secondClaim) {
        throw new Error("Expected second claim");
      }
      await expect(
        queue.updateProgress?.(secondClaim, {
          stage: "thread_history",
          blocker: "slack_api",
          observedAt: 130,
        }),
      ).resolves.toBe(true);

      const snapshot = await queue.getDiagnosticSnapshot?.(200);
      expect(snapshot?.stages.thread_history).toMatchObject({
        total: 1,
        claimed: 1,
        eligibleNoProgressCount: 1,
        maxEligibleNoProgressAgeMs: 100,
      });
    });
  });

  it("freezes completion progress and rejects late callbacks for the settled claim", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue<{ text: string }>(stateDir);
      await queue.enqueue("event-1", { text: "complete" }, { receivedAt: 10 });
      const claim = await queue.claim("event-1", { ownerId: "worker" });
      if (!claim) {
        throw new Error("Expected claim");
      }
      await queue.updateProgress?.(claim, {
        stage: "thread_history",
        blocker: "slack_api",
        observedAt: 40,
        progressAt: 40,
      });
      await queue.updateProgress?.(claim, {
        stage: "adoption",
        blocker: "none",
        observedAt: 70,
      });
      await expect(queue.complete(claim, { completedAt: 80 })).resolves.toBe(true);
      await expect(
        queue.updateProgress?.(claim, { stage: "delivery", observedAt: 90, progressAt: 90 }),
      ).resolves.toBe(false);

      const completed = await queue.enqueue("event-1", { text: "duplicate" });
      expect(completed.kind).toBe("completed");
      if (completed.kind !== "completed") {
        throw new Error(`Expected completed duplicate, got ${completed.kind}`);
      }
      expect(completed.record.metadata).toMatchObject({
        [CHANNEL_INGRESS_OBSERVABILITY_METADATA_KEY]: {
          stage: "adoption",
          blocker: "none",
          lastProgressAt: 80,
          lastPreparation: {
            stage: "thread_history",
            blocker: "slack_api",
            stageStartedAt: 40,
            completedAt: 70,
            elapsedMs: 30,
          },
          terminal: { disposition: "completed", recordedAt: 80 },
        },
      });
    });
  });

  it("keeps terminal operation evidence without copying raw failure text into progress", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue<{ text: string }, { provider: string }>(stateDir);
      await queue.enqueue(
        "event-raw-failure",
        { text: "payload secret xoxb-body" },
        { metadata: { provider: "slack" }, receivedAt: 10 },
      );
      const claim = await queue.claim("event-raw-failure", { ownerId: "worker" });
      if (!claim) {
        throw new Error("Expected claim");
      }
      await queue.updateProgress?.(claim, {
        operation: {
          phase: "begin",
          id: "api-call",
          kind: "api",
          method: "conversations.history",
          profile: "slack-read",
          startedAt: 20,
        },
        observedAt: 20,
      });
      await queue.fail(claim, {
        reason: "handler failed with xoxb-secret",
        message: "raw response body xoxb-secret",
        failedAt: 30,
      });

      const failed = await queue.listFailed?.();
      const metadata = failed?.[0]?.metadata as Record<string, unknown> | undefined;
      const progress = metadata?.[CHANNEL_INGRESS_OBSERVABILITY_METADATA_KEY] as
        | Record<string, unknown>
        | undefined;
      expect(progress).toMatchObject({
        lastOperation: {
          id: "api-call",
          kind: "api",
          method: "conversations.history",
          profile: "slack-read",
          startedAt: 20,
          historical: true,
          outcome: "unknown",
        },
        terminal: { disposition: "failed", recordedAt: 30 },
      });
      expect((progress?.terminal as Record<string, unknown> | undefined)?.reason).toBeUndefined();
      expect(JSON.stringify(progress)).not.toContain("xoxb-secret");
      expect(JSON.stringify(progress)).not.toContain("raw response body");
    });
  });

  it("merges failed progress with provider metadata and clears it on manual resubmit", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue<
        { text: string },
        { provider: string; replay: { key: string } }
      >(stateDir);
      await queue.enqueue(
        "event-1",
        { text: "fail" },
        { metadata: { provider: "slack", replay: { key: "message-key" } }, receivedAt: 10 },
      );
      const claim = await queue.claim("event-1", { ownerId: "worker" });
      if (!claim) {
        throw new Error("Expected claim");
      }
      await queue.updateProgress?.(claim, {
        stage: "dedupe_wait",
        blocker: "dedupe_owner",
        observedAt: 30,
        progressAt: 30,
      });

      await expect(
        queue.fail(claim, { reason: "poison", message: "bad", failedAt: 40 }),
      ).resolves.toBe(true);
      await expect(queue.listFailed?.()).resolves.toMatchObject([
        {
          id: "event-1",
          metadata: {
            provider: "slack",
            replay: { key: "message-key" },
            [CHANNEL_INGRESS_OBSERVABILITY_METADATA_KEY]: {
              stage: "dedupe_wait",
              blocker: "dedupe_owner",
              terminal: { disposition: "failed", recordedAt: 40 },
            },
          },
        },
      ]);
      await expect(queue.getDiagnosticSnapshot?.(50)).resolves.toMatchObject({ failedCount: 1 });

      const resubmitted = await queue.resubmit?.("event-1", { resubmittedAt: 100 });
      expect(resubmitted?.kind).toBe("resubmitted");
      const pending = await queue.listPending();
      expect(pending).toMatchObject([
        {
          id: "event-1",
          receivedAt: 100,
          attempts: 0,
          metadata: { provider: "slack", replay: { key: "message-key" } },
        },
      ]);
      expect(JSON.stringify(pending[0]?.metadata)).not.toContain(
        CHANNEL_INGRESS_OBSERVABILITY_METADATA_KEY,
      );
    });
  });
});
