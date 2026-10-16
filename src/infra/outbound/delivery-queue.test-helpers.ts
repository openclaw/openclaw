import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, vi } from "vitest";
import type { ConversationDeliveryStoreScope } from "../../config/sessions/conversation-delivery-store.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import { deriveDeliveryQueueRetentionColumns } from "../delivery-queue-retention-columns.js";
import {
  claimDeliveryQueueEntryPlatformSendInDatabase,
  renewDeliveryQueueEntryPlatformSendLeaseInDatabase,
} from "../delivery-queue-sqlite-claim.kernel.js";
import { loadDeliveryQueueEntries } from "../delivery-queue-sqlite.js";
import { isPostgresSqlConnection } from "../sql-connection.js";
import { OUTBOUND_DELIVERY_QUEUE_NAME } from "./delivery-queue-media-staging.js";
import type { DeliverFn, RecoveryLogger } from "./delivery-queue-recovery.js";
import type { QueuedDelivery } from "./delivery-queue-types.js";

export function createPendingFinalFixture(
  storePath: string,
  deliveryId: string,
  sessionKey: string,
  options: {
    text?: string;
    now?: number;
    state?: "prepared" | "queued";
    context?: DeliveryContext;
    stale?: boolean;
  } = {},
) {
  const { text = "pending final", now = 1, state = "prepared", context, stale = false } = options;
  const intentId = `${deliveryId}-intent`,
    sessionId = `${deliveryId}-session`;
  const kind = "pending-final" as const;
  const completion = { kind, deliveryId, intentId, sessionId, sessionKey, storePath };
  const deliveries = stale ? [] : [{ id: deliveryId, state }];
  const replayable = "replayable" as const;
  const pending = { kind: replayable, text, context, createdAt: now, intentId, deliveries };
  return { completion, entry: { sessionId, updatedAt: now, pendingFinalDelivery: pending } };
}

export async function prepareConversationDelivery(
  scope: ConversationDeliveryStoreScope,
  operationId: string,
  message: string,
  routeFingerprint: string,
) {
  // Keep session/routing modules out of storage-only fixtures' module graphs.
  const { upsertSessionEntryCore } = await import("../../config/sessions/session-accessor.js");
  const { beginConversationDeliveryOperation } =
    await import("../../config/sessions/conversation-delivery-store.js");
  const { buildConversationRef } = await import("../../routing/conversation-ref.js");
  const { normalizeSessionDeliveryState } = await import("../../utils/delivery-context.shared.js");
  const channel = "reef",
    accountId = "default",
    peerId = "peer-agent";
  const conversationRef = buildConversationRef({ channel, accountId, kind: "direct", peerId });
  await upsertSessionEntryCore(
    { ...scope, sessionKey: "agent:main:reef:direct:peer-agent" },
    {
      sessionId: "reef-session",
      updatedAt: 100,
      chatType: "direct",
      delivery: normalizeSessionDeliveryState({
        context: { channel: "reef", accountId: "default", to: "reef:peer-agent" },
        origin: { provider: "reef", accountId: "default", nativeDirectUserId: "peer-agent" },
      }),
    },
  );
  await beginConversationDeliveryOperation(scope, {
    operationId,
    operationKind: "send",
    message,
    preparedMessageId: "reef-prepared",
    conversationRef,
  });
  return {
    channel,
    to: "reef:peer-agent",
    payloads: [{ text: message }],
    deliveryCompletion: {
      kind: "conversation" as const,
      agentId: scope.agentId,
      operationId,
      storePath: scope.storePath,
      routeFingerprint,
    },
  };
}

function queueDatabase(stateDir: string) {
  return openOpenClawStateDatabase({ env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } });
}

export function readQueueStatus(stateDir: string, id: string): string | undefined {
  const row = queueDatabase(stateDir)
    .db.prepare("SELECT status FROM delivery_queue_entries WHERE queue_name = ? AND id = ?")
    .get(OUTBOUND_DELIVERY_QUEUE_NAME, id) as { status?: string } | undefined;
  return row?.status;
}

export async function createQueueMedia(stateDir: string, suffix: string, content: string) {
  const artifact = path.join(
    stateDir,
    "delivery-queue-media",
    `00000000-0000-4000-8000-${suffix}.ogg`,
  );
  await fs.promises.mkdir(path.dirname(artifact), { recursive: true });
  await fs.promises.writeFile(artifact, content);
  return artifact;
}

// Clock-controlled kernel cases stay in one realm; facade tests exercise real worker leases.
export function claimDeliveryQueueEntryForTest(
  params: Parameters<typeof claimDeliveryQueueEntryPlatformSendInDatabase>[1] & {
    stateDir: string;
  },
) {
  return claimDeliveryQueueEntryPlatformSendInDatabase(queueDatabase(params.stateDir), params);
}

export function renewDeliveryQueueEntryLeaseForTest(
  params: Parameters<typeof renewDeliveryQueueEntryPlatformSendLeaseInDatabase>[1] & {
    stateDir: string;
  },
) {
  return renewDeliveryQueueEntryPlatformSendLeaseInDatabase(queueDatabase(params.stateDir), params);
}

export async function loadPendingDeliveries(stateDir?: string): Promise<QueuedDelivery[]> {
  return loadDeliveryQueueEntries(OUTBOUND_DELIVERY_QUEUE_NAME, stateDir) as QueuedDelivery[];
}

/** Installs Vitest hooks that provide a fresh delivery-queue state dir per case. */
export function installDeliveryQueueTmpDirHooks(): { readonly tmpDir: () => string } {
  let tmpDir = "";
  const dirs = useSessionStoreTempDirs(afterAll, "openclaw-dq-suite-");
  beforeEach(() => {
    tmpDir = dirs.make();
  });

  afterEach(async () => {
    await closeStateDatabaseForTest();
    tmpDir = "";
  });

  return { tmpDir: () => tmpDir };
}

export function readQueuedEntry(tmpDir: string, id: string): Record<string, unknown> {
  const { db } = queueDatabase(tmpDir);
  const row = db
    .prepare("SELECT entry_json FROM delivery_queue_entries WHERE queue_name = ? AND id = ?")
    .get(OUTBOUND_DELIVERY_QUEUE_NAME, id) as { entry_json?: string } | undefined;
  if (!row?.entry_json) {
    throw new Error(`Missing queued entry ${id}`);
  }
  return JSON.parse(row.entry_json) as Record<string, unknown>;
}

export function readQueuedEntries(tmpDir: string): Record<string, unknown>[] {
  const { db } = queueDatabase(tmpDir);
  const rows = db
    .prepare(
      `SELECT entry_json FROM delivery_queue_entries
       WHERE queue_name = ? AND status = 'pending' ORDER BY enqueued_at ASC, id ASC`,
    )
    .all(OUTBOUND_DELIVERY_QUEUE_NAME) as Array<{ entry_json: string }>;
  return rows.map((row) => JSON.parse(row.entry_json) as Record<string, unknown>);
}

export function setQueuedEntryState(
  tmpDir: string,
  id: string,
  state: {
    retryCount: number;
    lastAttemptAt?: number;
    lastError?: string;
    enqueuedAt?: number;
    platformSendStartedAt?: number;
    recoveryState?: "send_attempt_started" | "unknown_after_send";
    producerClaimId?: string;
    availableAt?: number;
  },
): void {
  const entry = readQueuedEntry(tmpDir, id);
  for (const key of [
    "retryCount",
    "lastAttemptAt",
    "lastError",
    "enqueuedAt",
    "platformSendStartedAt",
    "recoveryState",
    "producerClaimId",
    "availableAt",
  ] as const) {
    if (state[key] !== undefined) {
      entry[key] = state[key];
    } else if (key === "lastAttemptAt" || key === "lastError") {
      delete entry[key];
    }
  }
  const { db } = queueDatabase(tmpDir);
  const entryJson = JSON.stringify(entry);
  if (isPostgresSqlConnection(db)) {
    throw new Error("Delivery queue fixture mutation requires a SQLite database");
  }
  db.prepare(
    `UPDATE delivery_queue_entries
     SET retry_count = ?, enqueued_at = ?, last_attempt_at = ?, last_error = ?,
         platform_send_started_at = ?, recovery_state = ?, entry_json = ?,
         retention_id_prefix = @retention_id_prefix, retention_max_age_ms = @retention_max_age_ms,
         retention_max_entries = @retention_max_entries, updated_at = ?
     WHERE queue_name = ? AND id = ?`,
  ).run(
    deriveDeliveryQueueRetentionColumns(id, entryJson),
    state.retryCount,
    state.enqueuedAt ?? Number(entry.enqueuedAt ?? 0),
    state.lastAttemptAt ?? null,
    state.lastError ?? null,
    state.platformSendStartedAt ?? null,
    state.recoveryState ?? null,
    entryJson,
    Date.now(),
    OUTBOUND_DELIVERY_QUEUE_NAME,
    id,
  );
}

export function createRecoveryLog() {
  return {
    info: vi.fn<(msg: string) => void>(),
    warn: vi.fn<(msg: string) => void>(),
    error: vi.fn<(msg: string) => void>(),
  } satisfies RecoveryLogger;
}

export function asDeliverFn(deliver: ReturnType<typeof vi.fn>): DeliverFn {
  return deliver as DeliverFn;
}

export const RECOVERY_SUMMARY = {
  empty: { recovered: 0, failed: 0, skippedMaxRetries: 0, deferredBackoff: 0 },
  failed: { recovered: 0, failed: 1, skippedMaxRetries: 0, deferredBackoff: 0 },
  recovered: { recovered: 1, failed: 0, skippedMaxRetries: 0, deferredBackoff: 0 },
  recoveredWithDeferred: { recovered: 1, failed: 0, skippedMaxRetries: 0, deferredBackoff: 1 },
} as const;

export function installDeliveryCompletionHooks(registerMatrix = false) {
  const fixtures = installDeliveryQueueTmpDirHooks();
  let deliver: typeof import("./deliver.js").deliverOutboundPayloads;
  beforeAll(async () => {
    ({ deliverOutboundPayloads: deliver } = await import("./deliver.js"));
  });
  beforeEach(async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", fixtures.tmpDir());
    if (registerMatrix) {
      const { setActivePluginRegistry } = await import("../../plugins/runtime.js");
      const { createOutboundTestPlugin, createTestRegistry } =
        await import("../../test-utils/channel-plugins.js");
      const { matrixOutboundForQueueTest } =
        await import("./deliver.queue-integration.test-support.js");
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "matrix",
            source: "test",
            plugin: createOutboundTestPlugin({
              id: "matrix",
              outbound: matrixOutboundForQueueTest,
            }),
          },
        ]),
      );
    }
  });
  afterEach(async () => {
    const { resetPluginRuntimeStateForTest, setActivePluginRegistry } =
      await import("../../plugins/runtime.js");
    const { createEmptyPluginRegistry } = await import("../../plugins/registry.js");
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
    vi.unstubAllEnvs();
  });
  return { ...fixtures, deliver: (...args: Parameters<typeof deliver>) => deliver(...args) };
}
