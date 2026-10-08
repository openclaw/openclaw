import { randomUUID } from "node:crypto";
import {
  createPluginExecutionFrame,
  getPluginExecutionFrame,
  runWithPluginExecutionFrame,
} from "./plugin-instance-invocation.js";
import type {
  PluginRetainedReference,
  PluginRetentionSnapshot,
  PluginRetentionOwner,
  PluginRetentionReason,
  PluginWorkRelease,
} from "./plugin-instance.types.js";
import type { PluginRegistry } from "./registry-types.js";
import { getPluginRegistryVersion } from "./runtime-state.js";

// Copy only host IDs, never request objects or arbitrary caller properties.
function copyOwner(owner: PluginRetentionOwner | undefined): PluginRetentionOwner | undefined {
  if (!owner) {
    return undefined;
  }
  const result = {
    agentId: owner.agentId?.slice(0, 256),
    sessionKey: owner.sessionKey?.slice(0, 256),
    runId: owner.runId?.slice(0, 256),
    serviceId: owner.serviceId?.slice(0, 256),
  };
  return Object.values(result).some(Boolean) ? Object.freeze(result) : undefined;
}

/** Bind scalar acquisition facts through the existing execution frame. */
export function withPluginRetentionOwner<T>(owner: PluginRetentionOwner, run: () => T): T {
  const current = getPluginExecutionFrame();
  return runWithPluginExecutionFrame(
    createPluginExecutionFrame({ ...current, retentionOwner: copyOwner(owner) }, current),
    run,
  );
}

/** Observations never own tokens; the instance's live sets determine retention. */
export class PluginReferenceDiagnostics {
  private readonly instanceId = randomUUID();
  private sequence = 0;
  private readonly references = new WeakMap<object, PluginRetainedReference>();

  /** Capture acquisition facts without retaining its parent token. */
  record(
    token: object,
    parentToken: object | undefined,
    kind: PluginRetainedReference["kind"],
    reason: PluginRetentionReason,
    owner = getPluginExecutionFrame()?.retentionOwner,
  ): PluginRetainedReference {
    const parent = parentToken && this.references.get(parentToken);
    const reference: PluginRetainedReference = {
      referenceId: `${this.instanceId}:${++this.sequence}`,
      kind,
      reason,
      acquiredAtMs: Date.now(),
      owner: copyOwner(owner) ?? parent?.owner ?? "unknown",
      ...(parent ? { parentReferenceId: parent.referenceId } : {}),
      cleanupState: kind === "cleanup" ? "pending" : "active",
    };
    this.references.set(token, reference);
    return reference;
  }

  /** Decorate the owner's existing release without changing settlement. */
  workRelease(
    token: object,
    parentToken: object | undefined,
    reason: PluginRetentionReason,
    release: () => void,
  ): PluginWorkRelease {
    const reference = this.record(token, parentToken, "work", reason);
    return Object.assign(release, {
      setCleanupState: (state: PluginRetainedReference["cleanupState"]) => {
        reference.cleanupState = state;
      },
    });
  }

  /** Copy bounded live facts, including calls whose physical settlement timed out. */
  snapshot(
    instance: Pick<
      PluginRetentionSnapshot,
      "pluginId" | "acceptingCalls" | "replacementPending" | "disposing"
    >,
    registry: PluginRegistry | undefined,
    tokenSets: Iterable<object>[],
    options: { limit?: number; includeOwners?: boolean },
  ): PluginRetentionSnapshot {
    const tokens = new Set(tokenSets.flatMap((set) => [...set]));
    const rows: PluginRetentionSnapshot["references"] = [];
    const requested = options.limit ?? 64;
    const limit = Number.isFinite(requested)
      ? Math.max(0, Math.min(64, Math.floor(requested)))
      : 64;
    const now = Date.now();
    let total = 0;
    for (const token of tokens) {
      const reference = this.references.get(token);
      if (!reference) {
        continue;
      }
      total++;
      if (rows.length < limit) {
        rows.push({
          ...reference,
          owner: options.includeOwners === false ? "unknown" : reference.owner,
          ageMs: Math.max(0, now - reference.acquiredAtMs),
        });
      }
    }
    return {
      instanceId: this.instanceId,
      pluginId: instance.pluginId,
      generation: getPluginRegistryVersion(registry ?? null),
      acceptingCalls: instance.acceptingCalls,
      replacementPending: instance.replacementPending,
      disposing: instance.disposing,
      references: rows,
      total,
      omitted: total - rows.length,
    };
  }
}
