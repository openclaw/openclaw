import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { sha256Hex } from "./crypto-digest.js";
import { bindDeliveryQueueEntry } from "./delivery-queue-sqlite-bound.js";
import { generateSecureUuid } from "./secure-random.js";
import { withSessionDeliveryEnqueueAdmission } from "./session-delivery-queue-storage.js";
import {
  SESSION_DELIVERY_QUEUE_NAME,
  type QueuedSessionDelivery,
  type QueuedSessionDeliveryPayload,
} from "./session-delivery-queue.records.js";
import { createSqliteWorkerWriteAdmission } from "./sqlite-worker-store.js";

function buildEntryId(idempotencyKey?: string): string {
  if (!idempotencyKey) {
    return generateSecureUuid();
  }
  return sha256Hex(idempotencyKey);
}

export async function enqueueUnclaimedSessionDeliveryFixture(
  params: QueuedSessionDeliveryPayload,
  context: OpenClawStateWorkerContext,
): Promise<string> {
  const entry: QueuedSessionDelivery = {
    ...params,
    ...(params.completionRetention === "permanent" ? { retainOnFailure: true as const } : {}),
    id: buildEntryId(params.idempotencyKey),
    enqueuedAt: Date.now(),
    retryCount: 0,
  };
  const input = bindDeliveryQueueEntry({
    queueName: SESSION_DELIVERY_QUEUE_NAME,
    entry,
    insertOnly: true,
  });
  await withSessionDeliveryEnqueueAdmission(entry, context, (assertCurrent) =>
    runOpenClawStateWorkerOperation(
      context,
      (scope) => scope.execute({ type: "sessionDelivery.enqueue", input }),
      {
        assertCurrent,
        createAdmission: createSqliteWorkerWriteAdmission(assertCurrent, [
          context.admission.databasePath,
        ]),
      },
    ),
  );
  return entry.id;
}

export async function observeSessionDeliveryPublications(): Promise<string[]> {
  const { sqliteWorkerOwnerProbe } = await import("./sqlite-worker-owner-probe.test-support.js");
  const stateWorker = await import("../state/openclaw-state-worker-store.js");
  const publications: string[] = [];
  sqliteWorkerOwnerProbe.command(stateWorker, (command, args, scope) => {
    if (
      command.type === "sessionDelivery.enqueue" ||
      command.type === "sessionDelivery.enqueueClaimed" ||
      command.type === "sessionDelivery.admitSubagentCompletion"
    ) {
      publications.push(command.type);
    }
    return scope.execute(command, args);
  });
  return publications;
}

export async function withSessionDeliveryQueue(
  run: (stateDir: string, queueContext: OpenClawStateWorkerContext) => Promise<void>,
): Promise<void> {
  await withTestDir({ prefix: "openclaw-session-delivery-" }, async (stateDir) => {
    const queueContext = captureOpenClawStateWorkerContext({
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    });
    try {
      await run(stateDir, queueContext);
    } finally {
      await closeOpenClawStateDatabaseByPathAsync(queueContext.admission.databasePath);
    }
  });
}
