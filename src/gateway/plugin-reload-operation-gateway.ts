import { listAgentIds } from "../agents/agent-roster.js";
import { prepareSessionStoreTargetInventory } from "../config/sessions/session-store-target-inventory.js";
import { prepareSessionStoreTargetInventoryRead } from "../config/sessions/session-store-target-runtime.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { PluginLifecycleRuntimeApply } from "../plugins/lifecycle.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  initializePluginReloadContinuations,
  pluginReloadContinuationSourceId,
  preparePluginReloadContinuations,
  resumePluginReloadContinuations,
} from "./plugin-reload-continuations.js";
import {
  listPluginReloadOperations,
  readPluginReloadOperation,
  savePluginReloadOperation,
} from "./plugin-reload-operation-store.js";
import { createPluginReloadOperationOwner } from "./plugin-reload-operation.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import type { RestartResumeClaim } from "./session-restart-resume.types.js";

const log = createSubsystemLogger("gateway/plugin-reload");
const owners = new WeakMap<
  PluginLifecycleRuntimeApply,
  Map<string, ReturnType<typeof createPluginReloadOperationOwner>>
>();

export function getPluginReloadOperationOwner(context: GatewayRequestContext) {
  const applyRuntime = context.applyPluginLifecycleChange;
  if (!applyRuntime) {
    throw new Error("Plugin reload requires a running Gateway.");
  }
  const storagePath = resolveOpenClawStateSqlitePath();
  let scoped = owners.get(applyRuntime);
  if (!scoped) {
    scoped = new Map();
    owners.set(applyRuntime, scoped);
  }
  let result = scoped.get(storagePath);
  if (!result) {
    result = createPluginReloadOperationOwner({
      warn: (message) => log.warn(message),
      prepare: (operation, targets, assertCurrent) =>
        preparePluginReloadContinuations(targets, context, assertCurrent, {
          id: operation.id,
          pluginIds: operation.pluginIds,
          requestKey: operation.requestKey,
        }),
      resume: (current, outcome) =>
        resumePluginReloadContinuations(
          current,
          context,
          !outcome.healthy
            ? { status: "failed", error: outcome.message }
            : current.state === "succeeded"
              ? { status: "committed" }
              : { status: "rolled-back", healthy: true },
        ),
    });
    scoped.set(storagePath, result);
  }
  return result;
}

/** Startup publishes a fresh generation; never replay an uncertain activation operation. */
export async function recoverPluginReloadOperations(
  context: GatewayRequestContext,
  signal: AbortSignal,
) {
  const operations = await listPluginReloadOperations();
  if (!operations.length) {
    return;
  }
  const owner = getPluginReloadOperationOwner(context);
  const registry = getActivePluginRegistry();
  for (const operation of operations) {
    signal.throwIfAborted();
    if (owner.isRunning(operation.id)) {
      continue;
    }
    const needsContinuation = operation.continuations.some(
      (item) => item.state === "pending" || item.state === "accepted",
    );
    const healthy = operation.pluginIds.every((id) =>
      registry?.plugins.some((plugin) => plugin.id === id && plugin.status === "loaded"),
    );
    if (operation.state !== "succeeded" && operation.state !== "failed") {
      operation.state = "failed";
      operation.error =
        "The Gateway restarted during plugin reload. Startup published a fresh runtime; the uncertain operation was not replayed.";
      operation.updatedAtMs = Date.now();
      await savePluginReloadOperation(operation);
    }
    if (!needsContinuation) {
      continue;
    }
    signal.throwIfAborted();
    await resumePluginReloadContinuations(
      operation,
      context,
      !healthy
        ? {
            status: "failed",
            error:
              "Startup did not publish every requested plugin; continuation remains blocked for operator recovery.",
          }
        : operation.state === "succeeded"
          ? { status: "committed" }
          : { status: "recovered", healthy: true },
    );
  }
}

/** The maintenance journal accepts FIFO custody before restart retires its own marker. */
export async function createPluginReloadRestartClaim(
  context: GatewayRequestContext,
  signal: AbortSignal,
): Promise<RestartResumeClaim> {
  const operations = await listPluginReloadOperations();
  if (
    operations.some((operation) =>
      operation.continuations.some((c) => c.state === "pending" || c.state === "accepted"),
    )
  ) {
    initializePluginReloadContinuations(context);
  }
  signal.throwIfAborted();
  const claim: RestartResumeClaim = async (target) => {
    signal.throwIfAborted();
    const currentOperations = await listPluginReloadOperations();
    signal.throwIfAborted();
    const candidates = currentOperations.flatMap((operation) =>
      operation.continuations
        .filter(
          (c) =>
            c.agentId === target.agentId &&
            c.sessionKey === target.sessionKey &&
            c.sessionId === target.sessionId &&
            c.state !== "complete" &&
            c.state !== "failed" &&
            (!target.sourceRunId ||
              c.sourceRunId === target.sourceRunId ||
              pluginReloadContinuationSourceId(operation.id, c) === target.sourceRunId),
        )
        .map((continuation) => ({ operationId: operation.id, continuation })),
    );
    const selected = candidates[0];
    if (!selected) {
      return false;
    }
    if (candidates.length !== 1) {
      throw new Error("Ambiguous maintenance restart custody; automatic recovery was withheld.");
    }
    const current = await readPluginReloadOperation(selected.operationId);
    signal.throwIfAborted();
    const continuation = current?.continuations.find(
      (c) =>
        c.sourceRunId === selected.continuation.sourceRunId &&
        c.sessionKey === target.sessionKey &&
        c.sessionId === target.sessionId,
    );
    if (!current || !continuation) {
      throw new Error("Maintenance restart custody disappeared before transfer.");
    }
    continuation.queuedInputIds = [
      ...new Set([...continuation.queuedInputIds, ...target.queuedInputIds]),
    ];
    current.updatedAtMs = Date.now();
    await savePluginReloadOperation(current);
    signal.throwIfAborted();
    return true;
  };
  return Object.assign(claim, {
    async queuedInputIds(
      target: Parameters<NonNullable<RestartResumeClaim["queuedInputIds"]>>[0],
    ): Promise<readonly string[]> {
      signal.throwIfAborted();
      const currentOperations = await listPluginReloadOperations();
      signal.throwIfAborted();
      const continuations = currentOperations
        .flatMap((operation) => operation.continuations)
        .filter(
          (continuation) => continuation.state === "pending" || continuation.state === "accepted",
        );
      const queuedInputIds = new Set<string>();
      const cfg = context.getRuntimeConfig();
      const configured = new Set(listAgentIds(cfg));
      // Inventory reads canonicalize aliases, so keep each original logical owner
      // attached to its physical placement rather than using the canonical agent ID.
      for (const agentId of new Set(continuations.map((continuation) => continuation.agentId))) {
        if (!configured.has(agentId)) {
          continue;
        }
        const owned = continuations.filter((continuation) => continuation.agentId === agentId);
        if (!owned.some((continuation) => continuation.queuedInputIds.length > 0)) {
          continue;
        }
        const inventory = prepareSessionStoreTargetInventoryRead(
          prepareSessionStoreTargetInventory(cfg, [agentId], target.env, "configured", "read"),
        );
        const matches = await inventory.withRead(
          async (snapshot) =>
            snapshot.agents.some(({ reads }) =>
              reads.some(
                ({ database }) =>
                  database.agentId === target.physicalAgentId && database.path === target.storePath,
              ),
            ),
          () => signal.throwIfAborted(),
          signal,
        );
        if (matches) {
          for (const continuation of owned) {
            for (const id of continuation.queuedInputIds) {
              queuedInputIds.add(id);
            }
          }
        }
      }
      return [...queuedInputIds];
    },
  });
}
