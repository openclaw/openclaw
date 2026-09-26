import path from "node:path";
import { getRuntimeConfig } from "../config/config.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { withSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import {
  assertExpectedExistingSession,
  ExpectedExistingSessionChangedError,
} from "../gateway/server-methods/agent-expected-session.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { parseCronRunScopeSuffix } from "../sessions/session-key-utils.js";
import { beginSessionWorkAdmission } from "../sessions/session-lifecycle-admission.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import { bindDeliveryQueueEntry } from "./delivery-queue-sqlite-bound.js";
import {
  prepareClaimedSessionDelivery,
  prepareSessionDelivery,
  SESSION_DELIVERY_QUEUE_NAME,
  SessionDeliveryAcknowledgementFinalizeError,
  SessionDeliveryAttemptStartError,
  SessionDeliveryDeadLetteredError,
  type QueuedSessionDelivery,
  type QueuedSessionDeliveryPayload,
  type SessionDeliverySettledOutcome,
} from "./session-delivery-queue.records.js";
import type {
  SessionDeliveryAgentRunUpdate,
  SessionDeliveryWorkerOperations,
} from "./session-delivery-queue.worker-contract.js";
import { createSqliteWorkerWriteAdmission } from "./sqlite-worker-store.js";

/** Queue publication and continuation deletion share the existing session lifecycle owner. */
export async function withSessionDeliveryEnqueueAdmission<T>(
  payload: QueuedSessionDeliveryPayload,
  context: OpenClawStateWorkerContext,
  run: (assertCurrent: () => void) => T | Promise<T>,
): Promise<T> {
  const binding =
    payload.kind === "agentTurn" && payload.requesterBinding
      ? { ...payload.requesterBinding }
      : undefined;
  const sessionKey = payload.sessionKey;
  const unavailable = "session delivery original requester is no longer available";
  const assertQueueCurrent = () => {
    context.admission.assertCurrent();
    if (
      binding &&
      path.resolve(binding.storePath) !==
        path.resolve(
          resolveSessionStorePathCore(getRuntimeConfig().session?.store, {
            agentId: binding.agentId,
            env: context.environment,
          }),
        )
    ) {
      throw new SessionDeliveryDeadLetteredError(unavailable);
    }
  };
  assertQueueCurrent();
  if (!binding && !parseCronRunScopeSuffix(sessionKey).runId) {
    return await run(assertQueueCurrent);
  }
  if (binding && binding.sessionKey !== sessionKey) {
    throw new SessionDeliveryDeadLetteredError(unavailable);
  }
  const agentId = binding?.agentId ?? resolveAgentIdFromSessionKey(sessionKey);
  const storePath =
    binding?.storePath ??
    resolveSessionStorePathCore(getRuntimeConfig().session?.store, {
      agentId,
      env: context.environment,
    });
  const scope = {
    agentId,
    storePath,
    sessionKey,
    env: context.environment,
    hydrateSkillPromptRefs: false,
  };
  const readEntry = () =>
    withSessionEntryReadOnlyInWorker(scope, assertQueueCurrent, async (read) => {
      if (!read.ok) {
        throw read.error;
      }
      if (!read.value) {
        throw new SessionDeliveryDeadLetteredError(unavailable);
      }
      return read.value;
    });
  const original = await readEntry();
  const constraint = binding ?? {
    sessionId: original.sessionId,
    lifecycleRevision: original.lifecycleRevision ?? null,
  };
  let interruption: Error | undefined;
  let lease: Awaited<ReturnType<typeof beginSessionWorkAdmission>> | undefined;
  try {
    lease = await beginSessionWorkAdmission({
      scope: storePath,
      identities: [sessionKey, constraint.sessionId],
      assertAllowed: async (signal) => {
        signal.throwIfAborted();
        assertExpectedExistingSession({
          constraint,
          entry: await readEntry(),
          message: unavailable,
        });
      },
      onInterrupt(reason) {
        interruption = reason ?? new Error("session delivery admission interrupted");
      },
    });
    const assertCurrent = () => {
      assertQueueCurrent();
      if (interruption) {
        throw interruption;
      }
      if (!lease?.isActive()) {
        throw new Error("session delivery admission closed");
      }
    };
    return await lease.run(async () => await run(assertCurrent));
  } catch (error) {
    if (error instanceof ExpectedExistingSessionChangedError) {
      throw new SessionDeliveryDeadLetteredError(unavailable);
    }
    throw error;
  } finally {
    lease?.release();
  }
}

function executeSessionDelivery<Key extends keyof SessionDeliveryWorkerOperations>(
  context: OpenClawStateWorkerContext,
  command: { type: Key; input: SessionDeliveryWorkerOperations[Key]["input"] },
): Promise<SessionDeliveryWorkerOperations[Key]["output"]> {
  // A settled write remains authoritative if its captured owner closes while returning the result.
  return runOpenClawStateWorkerOperation(context, (scope) => scope.execute(command));
}

function prepareEntry(
  entry: QueuedSessionDelivery,
  mode: "insert" | "update",
): ReturnType<typeof bindDeliveryQueueEntry> {
  // Preserve the JSON persistence boundary before the transport serializes its input.
  return bindDeliveryQueueEntry({
    queueName: SESSION_DELIVERY_QUEUE_NAME,
    entry,
    ...(mode === "insert" ? { insertOnly: true } : { updatePendingOnly: true }),
  });
}

export async function enqueueSessionDelivery(
  params: QueuedSessionDeliveryPayload,
  context: OpenClawStateWorkerContext,
): Promise<string> {
  const entry = prepareSessionDelivery(params);
  const input = prepareEntry(entry, "insert");
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

export async function enqueueClaimedSessionDelivery(
  params: QueuedSessionDeliveryPayload,
  initialAttemptLeaseMs: number,
  context: OpenClawStateWorkerContext,
): Promise<SessionDeliveryWorkerOperations["sessionDelivery.enqueueClaimed"]["output"]> {
  const entry = prepareClaimedSessionDelivery(params, initialAttemptLeaseMs);
  const input = prepareEntry(entry, "insert");
  return withSessionDeliveryEnqueueAdmission(entry, context, (assertCurrent) =>
    runOpenClawStateWorkerOperation(
      context,
      (scope) => scope.execute({ type: "sessionDelivery.enqueueClaimed", input }),
      {
        assertCurrent,
        createAdmission: createSqliteWorkerWriteAdmission(assertCurrent, [
          context.admission.databasePath,
        ]),
      },
    ),
  );
}

export async function releaseSessionDeliveryClaim(
  id: string,
  context: OpenClawStateWorkerContext,
): Promise<void> {
  return executeSessionDelivery(context, { type: "sessionDelivery.releaseClaim", input: { id } });
}

export async function deferSessionDelivery(
  id: string,
  delayMs: number,
  context: OpenClawStateWorkerContext,
): Promise<void> {
  return executeSessionDelivery(context, { type: "sessionDelivery.defer", input: { id, delayMs } });
}

export async function advanceSessionDeliveryAgentRun(
  id: string,
  updates: SessionDeliveryAgentRunUpdate | undefined,
  context: OpenClawStateWorkerContext,
): Promise<void> {
  return executeSessionDelivery(context, {
    type: "sessionDelivery.advanceAgentRun",
    input: { id, updates },
  });
}

export async function mergeSessionDeliveryPreparedMediaBlocks(
  id: string,
  mediaUrl: string,
  blocks: Array<Record<string, unknown>>,
  context: OpenClawStateWorkerContext,
): Promise<Array<Record<string, unknown>>> {
  const result = await executeSessionDelivery(context, {
    type: "sessionDelivery.mergePreparedMedia",
    input: { id, mediaUrl, blocksJson: JSON.stringify(blocks) },
  });
  return result.source === "input" ? blocks : result.blocks;
}

export async function markSessionDeliveryAttemptStarted(
  entry: QueuedSessionDelivery,
  context: OpenClawStateWorkerContext,
): Promise<void> {
  try {
    await executeSessionDelivery(context, {
      type: "sessionDelivery.markAttemptStarted",
      input: prepareEntry(
        { ...entry, deliveryStartedAt: entry.deliveryStartedAt ?? Date.now() },
        "update",
      ),
    });
  } catch (error) {
    throw new SessionDeliveryAttemptStartError(
      `Session delivery ${entry.id} could not persist attempt ownership`,
      { cause: error },
    );
  }
}

export async function markSessionDeliverySettlement(
  entry: QueuedSessionDelivery,
  outcome: SessionDeliverySettledOutcome,
  context: OpenClawStateWorkerContext,
): Promise<void> {
  try {
    await executeSessionDelivery(context, {
      type: "sessionDelivery.markSettlement",
      input: prepareEntry(
        {
          ...entry,
          settlementOutcome: outcome,
          ...(outcome === "recovered"
            ? { acknowledgedAt: entry.acknowledgedAt ?? Date.now() }
            : {}),
        },
        "update",
      ),
    });
  } catch (error) {
    throw new SessionDeliveryAcknowledgementFinalizeError(entry.id, { cause: error });
  }
}

export async function completeSessionDelivery(
  id: string,
  context: OpenClawStateWorkerContext,
): Promise<void> {
  try {
    await executeSessionDelivery(context, { type: "sessionDelivery.complete", input: { id } });
  } catch (error) {
    throw new SessionDeliveryAcknowledgementFinalizeError(id, { cause: error });
  }
}

export async function failSessionDelivery(
  id: string,
  error: string,
  context: OpenClawStateWorkerContext,
  options?: { releaseAttemptOwnership?: boolean },
): Promise<void> {
  return executeSessionDelivery(context, {
    type: "sessionDelivery.fail",
    input: { id, error, ...options },
  });
}

export async function loadPendingSessionDelivery(
  id: string,
  context: OpenClawStateWorkerContext,
): Promise<QueuedSessionDelivery | null> {
  const entry = await executeSessionDelivery(context, {
    type: "sessionDelivery.load",
    input: { id },
  });
  context.admission.assertCurrent();
  return entry;
}

export async function loadPendingSessionDeliveries(
  context: OpenClawStateWorkerContext,
): Promise<QueuedSessionDelivery[]> {
  const entries = await executeSessionDelivery(context, {
    type: "sessionDelivery.list",
    input: undefined,
  });
  context.admission.assertCurrent();
  return entries;
}

export async function moveSessionDeliveryToFailed(
  id: string,
  context: OpenClawStateWorkerContext,
): Promise<void> {
  return executeSessionDelivery(context, { type: "sessionDelivery.moveToFailed", input: { id } });
}
