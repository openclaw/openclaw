import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import {
  movePendingDeliveryQueueEntryNamespaceInDatabase,
  commitStagedDeliveryQueueEntryOnceAcrossNamespacesInDatabase,
  upsertDeliveryQueueEntryOnceAcrossNamespacesInDatabase,
} from "../delivery-queue-sqlite-namespace.kernel.js";
import {
  deleteDeliveryQueueEntryInDatabase,
  prepareDeliveryQueueTerminalEntry as prepareTerminal,
  terminalizePendingDeliveryQueueEntryInDatabase as terminalize,
} from "../delivery-queue-sqlite.kernel.js";
import {
  getDeliveryQueueEntryStatus,
  seedDeliveryQueueEntry,
} from "../delivery-queue-sqlite.test-support.js";
import type { DeliveryQueueCompletionRetention } from "../delivery-queue-sqlite.types.js";
import { resolvePreferredOpenClawTmpDir } from "../tmp-openclaw-dir.js";
import {
  LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME as LEGACY_QUEUE,
  DELIVERY_QUEUE_MEDIA_STAGING_QUEUE_NAME as STAGING_QUEUE,
  OUTBOUND_DELIVERY_PREPARATION_QUEUE_NAME as PREPARATION_QUEUE,
  OUTBOUND_DELIVERY_QUEUE_NAME as PREPARED_QUEUE,
} from "./delivery-queue-media-staging.js";
import { findDeliveryIntentOwnersInDatabase } from "./delivery-queue-ownership.kernel.js";
import { enqueueDeliveryOnce, loadPendingDelivery } from "./delivery-queue-storage.js";

describe("outbound delivery namespace ownership", () => {
  let rootDir: string;
  let stateDir: string;

  const database = () =>
    openOpenClawStateDatabase({ env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } });
  const seed = (queueName: string, entry: Parameters<typeof seedDeliveryQueueEntry>[0]["entry"]) =>
    seedDeliveryQueueEntry({ queueName, entry, stateDir });
  const legacyOwner = (status: "pending" | "failed") => ({
    queueName: LEGACY_QUEUE,
    namespace: "legacy",
    retired: true,
    status,
  });
  const preparedOwner = {
    queueName: PREPARED_QUEUE,
    namespace: "prepared",
    retired: false,
    status: "pending",
  };

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(resolvePreferredOpenClawTmpDir(), "openclaw-dq-owner-"));
    stateDir = path.join(rootDir, "state");
  });

  afterEach(async () => {
    vi.useRealTimers();
    await closeOpenClawStateDatabaseAsync();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it.each([false, true])(
    "preserves first stable custody across executable formats (bound first: %s)",
    async (boundFirst) => {
      const generation = {
        agentId: "main",
        storePath: path.join(stateDir, "agent.sqlite"),
        sessionKey: "agent:main:test",
        sessionId: "test",
        lifecycleRevision: null,
      };
      const payload = {
        channel: "matrix" as const,
        to: "!first:example",
        payloads: [{ text: "original" }],
      };
      const id = "sessions-send:namespace-collision";
      expect(
        await enqueueDeliveryOnce(
          { ...payload, ...(boundFirst ? { sessionGeneration: generation } : {}) },
          id,
          stateDir,
        ),
      ).toEqual({ id, created: true });
      expect(
        await enqueueDeliveryOnce(
          {
            ...payload,
            to: "!second:example",
            ...(!boundFirst ? { sessionGeneration: generation } : {}),
          },
          id,
          stateDir,
        ),
      ).toEqual({ id, created: false });
      const stored = await loadPendingDelivery(id, stateDir);
      expect(stored).toMatchObject({ to: "!first:example" });
      expect(stored?.sessionGeneration).toEqual(boundFirst ? generation : undefined);
    },
  );

  function seedFailedOwner(
    id: string,
    completionRetention: DeliveryQueueCompletionRetention,
    terminalAt: number,
  ): void {
    vi.setSystemTime(terminalAt);
    const entry = { id, enqueuedAt: terminalAt - 1, retryCount: 0, completionRetention };
    seed(LEGACY_QUEUE, entry);
    expect(
      terminalize(database(), prepareTerminal({ queueName: LEGACY_QUEUE, id, entry })),
    ).toMatchObject({ status: "terminalized" });
  }

  function seedOwnerSet(prefix: string) {
    vi.useFakeTimers();
    const ids = {
      expired: `${prefix}-expired`,
      unexpired: `${prefix}-unexpired`,
      permanent: `${prefix}-permanent`,
    };
    seedFailedOwner(ids.expired, { idPrefix: ids.expired, maxAgeMs: 100, maxEntries: 2 }, 1_000);
    seedFailedOwner(
      ids.unexpired,
      { idPrefix: ids.unexpired, maxAgeMs: 100, maxEntries: 2 },
      2_000,
    );
    seedFailedOwner(ids.permanent, "permanent", 2_000);
    vi.setSystemTime(2_050);
    return ids;
  }

  it("resolves canonical ownership from one batched namespace snapshot", () => {
    const id = "shared-delivery-intent";
    for (const queueName of [LEGACY_QUEUE, PREPARED_QUEUE]) {
      seed(queueName, { id, enqueuedAt: 1, retryCount: 0 });
    }
    const db = database();
    const readOwner = () => {
      const reads = trackSqliteStatementExecutions(
        requireNativeSqliteDatabase(db.db),
        ["owners"],
        (sql) =>
          sql.startsWith("select ") && sql.includes('from "delivery_queue_entries"')
            ? "owners"
            : null,
      );
      try {
        const [owner, missing, duplicate] = findDeliveryIntentOwnersInDatabase(db, {
          ids: [id, "absent", id],
        });
        expect(missing).toBeNull();
        expect(duplicate).toEqual(owner);
        expect(reads.counts.owners).toBeLessThanOrEqual(1);
        expect(reads.rowCounts.owners).toBeGreaterThan(0);
        return owner;
      } finally {
        reads.restore();
      }
    };

    expect(readOwner()).toEqual(preparedOwner);
    deleteDeliveryQueueEntryInDatabase(database(), PREPARED_QUEUE, id);
    expect(readOwner()).toEqual(legacyOwner("pending"));
  });

  it("resolves ordered batches after receipt expiry without confusing namespace precedence", () => {
    const ids = seedOwnerSet("batch");
    seed(PREPARED_QUEUE, { id: ids.expired, enqueuedAt: Date.now(), retryCount: 0 });
    const owners = findDeliveryIntentOwnersInDatabase(database(), {
      ids: [ids.unexpired, ids.expired, "absent", ids.permanent, ids.unexpired],
    });
    expect(owners).toEqual([
      legacyOwner("failed"),
      preparedOwner,
      null,
      legacyOwner("failed"),
      legacyOwner("failed"),
    ]);
    expect(getDeliveryQueueEntryStatus(LEGACY_QUEUE, ids.expired, stateDir)).toBeUndefined();
  });

  it.each(["insert-once", "staged", "move"] as const)(
    "expires bounded failed ownership inside %s admission",
    (mode) => {
      const ids = seedOwnerSet(mode);
      for (const id of Object.values(ids)) {
        const expired = id === ids.expired;
        const entry = { id, enqueuedAt: 2_050, retryCount: 0 };
        const admission = { queueName: PREPARED_QUEUE, conflictQueueNames: [LEGACY_QUEUE], entry };
        if (mode === "insert-once") {
          expect(
            upsertDeliveryQueueEntryOnceAcrossNamespacesInDatabase(database(), admission),
          ).toBe(expired);
        } else if (mode === "staged") {
          const stagingId = `stage-${id}`;
          seed(STAGING_QUEUE, { ...entry, id: stagingId });
          expect(
            commitStagedDeliveryQueueEntryOnceAcrossNamespacesInDatabase(database(), {
              ...admission,
              stagingId,
              stagingQueueName: STAGING_QUEUE,
            }),
          ).toBe(expired ? "created" : "existing");
        } else {
          seed(PREPARATION_QUEUE, entry);
          expect(
            movePendingDeliveryQueueEntryNamespaceInDatabase(database(), {
              sourceQueueName: PREPARATION_QUEUE,
              destinationQueueName: PREPARED_QUEUE,
              conflictQueueNames: admission.conflictQueueNames,
              expectedSourceEntry: entry,
              destinationEntry: { ...entry, enqueuedAt: 2_051 },
            }),
          ).toBe(expired ? "moved" : "destination-exists");
        }
      }
      expect(getDeliveryQueueEntryStatus(LEGACY_QUEUE, ids.expired, stateDir)).toBeUndefined();
    },
  );
});
