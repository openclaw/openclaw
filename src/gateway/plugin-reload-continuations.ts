import { createHash, randomUUID } from "node:crypto";
import type { PluginReloadRunTarget } from "../agents/plugin-reload-runs.js";
import {
  AGENT_RUN_PLUGIN_RELOAD_STOP_REASON,
  isAgentRunPluginReloadAbortReason,
  resolveAgentRunAbortLifecycleFields,
} from "../agents/run-termination.js";
import { withGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import {
  captureSessionEventTargetForHost,
  enqueueSessionEventForHost,
} from "../auto-reply/reply/session-event-handoff.js";
import { captureSessionQueuedInputsForRestart } from "../config/sessions/session-pending-input-history.js";
import { preparePendingInputStore } from "../config/sessions/session-pending-input-store.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import { runWithGatewayDetachedWorkContinuation } from "../process/gateway-work-admission.js";
import { isAcpSessionKey, isCronSessionKey, isSubagentSessionKey } from "../routing/session-key.js";
import type { ReplyOperation } from "../sessions/session-controller.contracts.js";
import { matchingEntries } from "../sessions/session-controller.lifecycle-projections.js";
import { captureSessionTarget } from "../sessions/session-controller.target.js";
import {
  registerSessionRunStopInvalidator,
  type SessionRunStopIntent,
} from "../sessions/session-run-stopped.js";
import { createDeferredCore } from "../shared/deferred.js";
import { runInDetachedAsyncContext } from "../shared/detached-async-context.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { captureQueuedOperatorRecoverySource } from "./operator-run-recovery-source.js";
import { restoreGatewayQueuedOperatorRecovery } from "./operator-run-recovery.js";
import {
  listPluginReloadOperations,
  readPluginReloadOperation,
  savePluginReloadOperation,
  type PluginReloadContinuation,
  type PluginReloadOperation,
} from "./plugin-reload-operation-store.js";
import { pluginReloadContinuationIdentity } from "./plugin-reload-operation-store.types.js";
import { continueSessionQueuedInputs } from "./queued-chat-inputs.js";
import { createScheduledGatewayRunner } from "./scheduled-run-gateway-context.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { loadGatewaySessionEntryReadOnlyAsync } from "./session-utils-store.js";

// Stop and reload share one durable writer; a retired native run is not the intent owner.
const owners = new WeakMap<GatewayRequestContext, Map<string, ReturnType<typeof createOwner>>>();
function createOwner(storagePath: string) {
  let tail = Promise.resolve();
  const cancelled = new Set<string>();
  const stopIntents = new Set<SessionRunStopIntent>();
  const receipts = new Map<string, () => boolean>();
  const running = new Map<string, Promise<void>>();
  const sourceOperations = new Map<string, ReplyOperation>();
  const matchesStop = (intent: SessionRunStopIntent, c: PluginReloadContinuation, id: string) =>
    intent.sessions.some(
      (session) =>
        session.sessionKey === c.sessionKey &&
        (!session.agentId || session.agentId === c.agentId) &&
        (!session.sessionId || session.sessionId === c.sessionId),
    ) &&
    (intent.source !== "client-run" ||
      intent.runIds.length === 0 ||
      intent.runIds.includes(c.sourceRunId) ||
      intent.runIds.includes(pluginReloadContinuationSourceId(id, c)));
  const key = pluginReloadContinuationSourceId;
  const write = <T>(run: () => Promise<T>): Promise<T> => {
    const result = tail.then(run);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const cancel = (
    id: string,
    c: PluginReloadContinuation,
    assertCurrent: () => void = () => {},
  ) => {
    assertCurrent();
    return write(async () => {
      const current = await readPluginReloadOperation(id);
      assertCurrent();
      if (!current) {
        cancelled.add(key(id, c));
        return;
      }
      const selected = current.continuations.find((candidate) => key(id, candidate) === key(id, c));
      if (selected?.state === "complete") {
        return;
      }
      if (selected && selected.state !== "cancelled") {
        selected.state = "cancelled";
        current.updatedAtMs = Date.now();
        await savePluginReloadOperation(current);
      }
      cancelled.add(key(id, c));
      assertCurrent();
      receipts.get(key(id, c))?.();
      sourceOperations.delete(key(id, c));
      receipts.delete(key(id, c));
    });
  };
  const complete = (id: string, c: PluginReloadContinuation, assertCurrent: () => void) =>
    write(async () => {
      const current = await readPluginReloadOperation(id);
      assertCurrent();
      const selected = current?.continuations.find(
        (candidate) => key(id, candidate) === key(id, c),
      );
      if (current && selected && (selected.state === "pending" || selected.state === "accepted")) {
        selected.state = "complete";
        current.updatedAtMs = Date.now();
        await savePluginReloadOperation(current);
      }
    });
  registerSessionRunStopInvalidator(async (intent: SessionRunStopIntent, assertCurrent) => {
    if (resolveOpenClawStateSqlitePath() !== storagePath) {
      return;
    }
    stopIntents.add(intent);
    try {
      const operations = await write(() => listPluginReloadOperations());
      for (const operation of operations) {
        for (const continuation of operation.continuations) {
          if (
            (continuation.state === "pending" || continuation.state === "accepted") &&
            matchesStop(intent, continuation, operation.id)
          ) {
            await cancel(operation.id, continuation, assertCurrent);
          }
        }
      }
    } finally {
      stopIntents.delete(intent);
    }
  });
  return {
    write,
    cancel,
    complete,
    sourceOperations,
    receipts,
    running,
    key,
    assertPending(id: string, c: PluginReloadContinuation) {
      if (
        cancelled.has(key(id, c)) ||
        [...stopIntents].some((intent) => matchesStop(intent, c, id))
      ) {
        throw new Error("Plugin reload continuation was stopped.");
      }
    },
  };
}
function owner(context: GatewayRequestContext) {
  const storagePath = resolveOpenClawStateSqlitePath();
  let scoped = owners.get(context);
  if (!scoped) {
    scoped = new Map();
    owners.set(context, scoped);
  }
  let result = scoped.get(storagePath);
  if (!result) {
    result = createOwner(storagePath);
    scoped.set(storagePath, result);
  }
  return result;
}

/** Install before accepting Stop requests, including while startup reload recovery is pending. */
export function initializePluginReloadContinuations(context: GatewayRequestContext): void {
  owner(context);
}

/** Stable, scoped producer identity. This correlation key never grants authority. */
export function pluginReloadContinuationSourceId(
  operationId: string,
  source: Pick<
    PluginReloadContinuation,
    "agentId" | "sessionKey" | "sessionId" | "lifecycleRevision" | "sourceRunId"
  >,
): string {
  const scope = pluginReloadContinuationIdentity(source);
  return "plugin-reload:" + operationId + ":" + createHash("sha256").update(scope).digest("hex");
}

class PluginReloadRestartClaimPendingError extends Error {}

async function originalInputsFinished(
  continuation: PluginReloadContinuation,
  scope: Parameters<typeof preparePendingInputStore>[0] & { sessionKey: string },
  assertCurrent: () => void,
): Promise<boolean> {
  if (!continuation.sourceInputKeys?.length) {
    throw new Error("Reload continuation has no durable source input identity.");
  }
  const store = await preparePendingInputStore(scope, assertCurrent);
  try {
    for (const idempotencyKey of continuation.sourceInputKeys) {
      const snapshot = await store.read({
        kind: "stage",
        sessionId: scope.sessionId,
        sessionKey: scope.sessionKey,
        idempotencyKey,
        trackCompletion: true,
      });
      assertCurrent();
      if (snapshot.kind !== "stage") {
        throw new Error("Unexpected pending input completion snapshot.");
      }
      if (snapshot.existing?.state === "cancelled") {
        continue;
      }
      const outcome = snapshot.previous?.outcome;
      if (
        !outcome ||
        outcome.stopReason === AGENT_RUN_PLUGIN_RELOAD_STOP_REASON ||
        outcome.stopReason === "restart"
      ) {
        return false;
      }
    }
    return true;
  } finally {
    await store.release();
  }
}

function unsupported(reason: string): never {
  throw new Error(
    "Forced plugin reload cannot safely continue this run: " +
      reason +
      " Let that run finish before reloading its plugins.",
  );
}

/** Capture and persist every supported conversation before the caller interrupts any run. */
export async function preparePluginReloadContinuations(
  targets: readonly PluginReloadRunTarget[],
  context: GatewayRequestContext,
  assertCurrent: () => void,
  identity: { id?: string; pluginIds: readonly string[]; requestKey?: string },
): Promise<PluginReloadOperation> {
  const journal = owner(context);
  const operation: PluginReloadOperation = {
    id: identity.id ?? randomUUID(),
    pluginIds: [...identity.pluginIds],
    ...(identity.requestKey ? { requestKey: identity.requestKey } : {}),
    createdAtMs: Date.now(),
    updatedAtMs: Date.now(),
    state: "accepted",
    continuations: [],
  };
  const captures: Array<{
    continuation: PluginReloadContinuation;
    preserve: () => void;
    assertSourceCurrent: () => void;
    reply: ReplyOperation;
  }> = [];
  for (const target of targets) {
    assertCurrent();
    if (!target.isBlocking()) {
      continue;
    }
    const sessionKey = target.sessionKey;
    if (
      !sessionKey ||
      isCronSessionKey(sessionKey) ||
      isAcpSessionKey(sessionKey) ||
      isSubagentSessionKey(sessionKey)
    ) {
      unsupported("only normal native conversations are supported (not cron, ACP, or subagents).");
    }
    if (!target.sourceInputKeys.length) {
      unsupported("the run has no durable input completion custody.");
    }
    const loaded = await loadGatewaySessionEntryReadOnlyAsync(sessionKey, {
      agentId: target.agentId,
    });
    assertCurrent();
    const entry = loaded.entry;
    if (!entry || entry.sessionId !== target.sessionId || entry.incognito || entry.archivedAt) {
      unsupported("the session is missing, replaced, incognito, or archived.");
    }
    const reply = target.operation;
    // Native cleanup can retain a physical generation after the reply has already settled.
    if (reply?.result || reply?.abortSignal.aborted) {
      continue;
    }
    if (!reply || !target.runId) {
      unsupported("the native run has no live conversation owner.");
    }
    const physicalTarget = captureSessionTarget({
      storeScope: loaded.storePath,
      sessionKey,
      agentId: target.agentId,
      incarnation: target.sessionId,
    });
    const inputs = matchingEntries(physicalTarget).flatMap(
      (candidate) => candidate.mailbox?.entries ?? [],
    );
    const input = inputs.find((candidate) => candidate.claim?.operation === reply);
    const authority = input?.source?.operatorAuthority;
    if (!authority) {
      unsupported("the conversation has no recoverable initiating operator.");
    }
    authority.assertCurrent();
    const recoverySource = captureQueuedOperatorRecoverySource(authority);
    if (!recoverySource || recoverySource.kind === "unavailable") {
      unsupported("the initiating operator cannot be recovered durably.");
    }
    const queued = await captureSessionQueuedInputsForRestart({
      storePath: loaded.storePath,
      agentId: target.agentId,
      sessionKey,
      sessionId: target.sessionId,
    });
    assertCurrent();
    authority.assertCurrent();
    if (!target.isBlocking() || reply.result || reply.abortSignal.aborted) {
      continue;
    }
    const continuation: PluginReloadContinuation = {
      agentId: target.agentId,
      sessionKey,
      sessionId: target.sessionId,
      lifecycleRevision: entry.lifecycleRevision,
      sourceRunId: target.runId,
      sourceInputKeys: target.sourceInputKeys,
      recoverySource,
      queuedInputIds: queued.queuedInputIds,
      state: "pending",
    };
    operation.continuations.push(continuation);
    captures.push({
      continuation,
      preserve: queued.preserve,
      assertSourceCurrent: () => authority.assertCurrent(),
      reply,
    });
  }
  assertCurrent();
  await journal.write(() => savePluginReloadOperation(operation));
  try {
    for (const capture of captures) {
      assertCurrent();
      const c = capture.continuation;
      if (
        capture.reply.abortSignal.aborted &&
        resolveAgentRunAbortLifecycleFields(capture.reply.abortSignal).stopReason !== "restart"
      ) {
        await journal.cancel(operation.id, c);
        continue;
      }
      if (capture.reply.result && !capture.reply.abortSignal.aborted) {
        await journal.complete(operation.id, c, assertCurrent);
        continue;
      }
      journal.sourceOperations.set(journal.key(operation.id, c), capture.reply);
      assertCurrent();
      journal.assertPending(operation.id, c);
      capture.assertSourceCurrent();
      // The marker is durable before old-run cancellation can withdraw mailbox ownership.
      capture.preserve();
    }
  } catch (error) {
    await Promise.all(operation.continuations.map((c) => journal.cancel(operation.id, c)));
    throw error;
  }
  return operation;
}

export type PluginReloadContinuationOutcome =
  | { status: "committed" }
  | { status: "rolled-back"; healthy: true }
  | { status: "recovered"; healthy: true }
  | { status: "failed"; error: string };

/** Replay only an interrupted conversation, under its original destination's current authority. */
export async function resumePluginReloadContinuations(
  operation: PluginReloadOperation,
  context: GatewayRequestContext,
  outcome: PluginReloadContinuationOutcome,
): Promise<void> {
  const journal = owner(context);
  const stored = await readPluginReloadOperation(operation.id);
  if (!stored) {
    throw new Error("Plugin reload continuation journal is missing.");
  }
  if (outcome.status === "failed") {
    // Lack of healthy-generation proof is not an explicit Stop. Keep custody
    // recoverable across startup, while refusing to run against an unsafe runtime.
    for (const continuation of stored.continuations) {
      if (continuation.state === "pending" || continuation.state === "accepted") {
        continuation.error = outcome.error;
      }
    }
    stored.updatedAtMs = Date.now();
    await journal.write(() => savePluginReloadOperation(stored));
    context.logGateway.warn("Plugin reload continuation blocked: " + outcome.error);
    return;
  }
  // Capture canonical host bindings before dropping the interrupted request context.
  const runScheduled = createScheduledGatewayRunner(
    context.resolveGatewayContext ?? (() => context),
    () => getActivePluginRegistry() ?? undefined,
  );
  const adoptions: Promise<void>[] = [];
  for (const captured of stored.continuations) {
    if (captured.state !== "pending" && captured.state !== "accepted") {
      continue;
    }
    const key = journal.key(stored.id, captured);
    const existing = journal.running.get(key);
    if (existing) {
      adoptions.push(existing);
      continue;
    }
    const adopted = createDeferredCore();
    journal.running.set(key, adopted.promise);
    const task = runInDetachedAsyncContext(() =>
      runScheduled(() =>
        runWithGatewayDetachedWorkContinuation(async () => {
          const sourceOperation = journal.sourceOperations.get(journal.key(stored.id, captured));
          if (
            sourceOperation &&
            !isAgentRunPluginReloadAbortReason(sourceOperation.abortSignal.reason)
          ) {
            await journal.complete(stored.id, captured, () => {});
            return;
          }
          let admitted: Awaited<ReturnType<typeof restoreGatewayQueuedOperatorRecovery>>;
          try {
            admitted = await restoreGatewayQueuedOperatorRecovery({
              source: captured.recoverySource,
              context,
              assertCurrent: () => journal.assertPending(stored.id, captured),
            });
          } catch (error) {
            await journal.cancel(stored.id, captured);
            context.logGateway.warn(
              "Plugin reload continuation authority could not be restored: " + String(error),
            );
            return;
          }
          const assertCurrent = () => {
            journal.assertPending(stored.id, captured);
            admitted.authority.assertCurrent();
          };
          try {
            assertCurrent();
            const loaded = await loadGatewaySessionEntryReadOnlyAsync(captured.sessionKey, {
              agentId: captured.agentId,
            });
            assertCurrent();
            const entry = loaded.entry;
            if (
              !entry ||
              entry.sessionId !== captured.sessionId ||
              entry.lifecycleRevision !== captured.lifecycleRevision ||
              entry.incognito ||
              entry.archivedAt
            ) {
              await journal.cancel(stored.id, captured);
              return;
            }
            if (
              !sourceOperation &&
              (entry.lifecycleRunId === captured.sourceRunId ||
                entry.lifecycleRunId === pluginReloadContinuationSourceId(stored.id, captured) ||
                entry.resumeAfterRestart?.sourceRunId === captured.sourceRunId ||
                entry.resumeAfterRestart?.sourceRunId ===
                  pluginReloadContinuationSourceId(stored.id, captured))
            ) {
              throw new PluginReloadRestartClaimPendingError(
                "Restart recovery still owns this source; automatic reload continuation was withheld.",
              );
            }
            const sourceFinished = await originalInputsFinished(
              captured,
              {
                agentId: captured.agentId,
                storePath: loaded.storePath,
                sessionKey: captured.sessionKey,
                sessionId: captured.sessionId,
              },
              assertCurrent,
            );
            await withGatewayToolCallerIdentity(
              {
                agentId: captured.agentId,
                sessionKey: captured.sessionKey,
                operatorAuthority: admitted.authority,
              },
              async () => {
                const target = await captureSessionEventTargetForHost(
                  captured.agentId,
                  captured.sessionKey,
                  { operatorAuthority: admitted.authority, assertCurrent },
                );
                assertCurrent();
                if (
                  target.sessionId !== captured.sessionId ||
                  target.lifecycleRevision !== captured.lifecycleRevision
                ) {
                  throw new Error("Plugin reload continuation session changed.");
                }
                // Existing queued user inputs are adopted oldest-first before the continuation event.
                // Deferred recovery may transfer custody while this destination becomes ready.
                const custodySnapshot = await readPluginReloadOperation(stored.id);
                assertCurrent();
                const current = custodySnapshot?.continuations.find(
                  (candidate) =>
                    journal.key(stored.id, candidate) === journal.key(stored.id, captured),
                );
                if (!current || (current.state !== "pending" && current.state !== "accepted")) {
                  return;
                }
                await continueSessionQueuedInputs(
                  context,
                  {
                    storePath: loaded.storePath,
                    agentId: captured.agentId,
                    sessionKey: captured.sessionKey,
                    sessionId: captured.sessionId,
                  },
                  {
                    assertCurrent,
                    queuedInputIds: current.queuedInputIds,
                    signal: admitted.authority.signal ?? new AbortController().signal,
                  },
                );
                assertCurrent();
                if (sourceFinished) {
                  await journal.complete(stored.id, captured, assertCurrent);
                  return;
                }
                const receipt = enqueueSessionEventForHost(
                  "Forced plugin reload " +
                    stored.id +
                    " finished with status " +
                    stored.state +
                    ". " +
                    (stored.error ? "Reload error: " + stored.error.slice(0, 2000) + ". " : "") +
                    "A healthy plugin runtime is now available. Tell the user the reload outcome and continue only unfinished work from the existing transcript. Preserve tool results and do not repeat completed external effects.",
                  {
                    agentId: captured.agentId,
                    sessionKey: captured.sessionKey,
                    expectedTarget: target,
                    sourceTurnId: pluginReloadContinuationSourceId(stored.id, captured),
                    sourceRunId: captured.sourceRunId,
                    contextKey: pluginReloadContinuationSourceId(stored.id, captured),
                    source: "plugin",
                    assertCurrent,
                    onAdopted: async () => {
                      await journal.write(async () => {
                        assertCurrent();
                        const latest = await readPluginReloadOperation(stored.id);
                        const c = latest?.continuations.find(
                          (candidate) =>
                            journal.key(stored.id, candidate) === journal.key(stored.id, captured),
                        );
                        if (!latest || !c || (c.state !== "pending" && c.state !== "accepted")) {
                          throw new Error("Plugin reload continuation is no longer pending.");
                        }
                        c.state = "accepted";
                        latest.updatedAtMs = Date.now();
                        await savePluginReloadOperation(latest);
                      });
                    },
                  },
                );
                journal.receipts.set(journal.key(stored.id, captured), receipt.cancel);
                const accepted = await receipt.accepted;
                if (!accepted.ok) {
                  throw new Error(accepted.error);
                }
                // The durable input owns the future turn now. No actor work
                // hold may keep the old source in this session lane.
                journal.sourceOperations.delete(journal.key(stored.id, captured));
                adopted.resolve();
                const result = await receipt.settled;
                if (result.status === "failed") {
                  await journal.write(async () => {
                    const latest = await readPluginReloadOperation(stored.id);
                    const continuation = latest?.continuations.find(
                      (candidate) =>
                        journal.key(stored.id, candidate) === journal.key(stored.id, captured),
                    );
                    if (latest && continuation && continuation.state !== "cancelled") {
                      continuation.error = result.error ?? "Continuation failed";
                      latest.updatedAtMs = Date.now();
                      await savePluginReloadOperation(latest);
                    }
                  });
                }
                await journal.complete(stored.id, captured, () => {});
              },
            );
          } catch (error) {
            if (error instanceof PluginReloadRestartClaimPendingError) {
              await journal.write(async () => {
                const current = await readPluginReloadOperation(stored.id);
                const continuation = current?.continuations.find(
                  (c) => journal.key(stored.id, c) === journal.key(stored.id, captured),
                );
                if (
                  current &&
                  continuation &&
                  (continuation.state === "pending" || continuation.state === "accepted")
                ) {
                  continuation.error = error.message;
                  current.updatedAtMs = Date.now();
                  await savePluginReloadOperation(current);
                }
              });
            } else {
              await journal.cancel(stored.id, captured);
            }
            context.logGateway.warn("Plugin reload continuation was not resumed: " + String(error));
          } finally {
            journal.sourceOperations.delete(journal.key(stored.id, captured));
            journal.receipts.delete(journal.key(stored.id, captured));
            admitted.release();
          }
        }, "plugin-reload:continue:" + stored.id),
      ),
    );
    void task.then(
      () => {
        journal.running.delete(key);
        adopted.resolve();
      },
      (error: unknown) => {
        journal.running.delete(key);
        adopted.reject(error);
        context.logGateway.warn("Plugin reload continuation owner failed: " + String(error));
      },
    );
    adoptions.push(adopted.promise);
  }
  await Promise.all(adoptions);
}
