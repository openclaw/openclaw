/**
 * Host-scoped delegated ownership for `before_dispatch` plugins.
 *
 * A trusted plugin that owns the current inbound dispatch may ask the Host to
 * establish delegated ownership for exactly that dispatch. The Host derives
 * every identity — owner kind/id, task scope, delegation/lineage refs — and the
 * plugin can only ask while its own `before_dispatch` handler is executing.
 *
 * This is a scoped capability, never a token or a constructor: the only way to
 * reach the Host operation is from inside the Host's own active
 * `before_dispatch` frame for the exact current handler. A retained reference,
 * a copy of the returned handles, a structurally identical object, or a call
 * from another plugin can never establish anything.
 *
 * Order is fixed and fail-closed: the Host durably acquires DELEGATED_LOCKED and
 * binds the delegated lineage BEFORE the operation resolves, so the delegated
 * owner can never run ahead of the lock. Once the operation succeeds for the
 * current dispatch, ordinary OpenClaw dispatch must not resume — even if the
 * handler later throws, times out, unloads, returns `handled=false`, or returns
 * no result.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { establishDelegatedExecutionOwnership } from "../delegation/delegated-execution-establishment.js";
import { createHostDelegationIntent } from "../delegation/host-delegation-intent.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";

/** The minimum correlation handles a plugin receives after the Host mints ownership. */
export type PluginDelegationEstablishment = Readonly<{
  delegationRef: string;
  lineageRef: string;
}>;

/** Host-owned outcome slot for one inbound dispatch. Authoritative for fail-closed dispatch. */
export type BeforeDispatchDelegationSlot = {
  established: boolean;
  ownerKind?: "plugin";
  ownerId?: string;
  taskScopeRef?: string;
  handles?: PluginDelegationEstablishment;
};

/** Host-created scope making the delegation capability available to one dispatch. */
export type BeforeDispatchDelegationScope = Readonly<{
  slot: BeforeDispatchDelegationSlot;
  taskScopeRef: string;
  /** Host execution context that carries the delegated lineage once established. */
  context: object;
  /** Re-checks that the Host hook admission/binding is still current. */
  assertCurrent?: () => void | Promise<void>;
  options?: OpenClawStateDatabaseOptions;
}>;

/** One active `before_dispatch` handler frame. Only Host code constructs one. */
export type BeforeDispatchDelegationFrame = {
  active: boolean;
  pluginId: string;
  registrationId?: string;
  ownerId: string;
  taskScopeRef: string;
  context: object;
  slot: BeforeDispatchDelegationSlot;
  assertCurrent?: () => void | Promise<void>;
  options?: OpenClawStateDatabaseOptions;
};

/** The plugin-facing delegated-ownership runtime surface (`api.runtime.delegation`). */
export type PluginDelegationRuntime = {
  /**
   * Establish Host-owned delegated ownership for the exact inbound dispatch the
   * current `before_dispatch` handler owns. Returned handles are correlation
   * only: possessing or copying them grants no establishment authority.
   */
  establishCurrent: (params?: {
    delegateGoalRef?: string | null;
  }) => Promise<PluginDelegationEstablishment>;
};

/** Raised (and therefore observable) refusal reasons for the capability. */
export class BeforeDispatchDelegationRefusedError extends Error {
  readonly code:
    | "outside-before-dispatch"
    | "stale-capability"
    | "already-established"
    | "invalid-delegate-goal-ref";

  constructor(code: BeforeDispatchDelegationRefusedError["code"], message: string) {
    super(message);
    this.name = "BeforeDispatchDelegationRefusedError";
    this.code = code;
  }
}

const BEFORE_DISPATCH_DELEGATION_FRAMES_KEY: unique symbol = Symbol.for(
  "openclaw.beforeDispatchDelegationFrames",
);

const beforeDispatchDelegationFrames = resolveGlobalSingleton<
  AsyncLocalStorage<BeforeDispatchDelegationFrame>
>(
  BEFORE_DISPATCH_DELEGATION_FRAMES_KEY,
  () => new AsyncLocalStorage<BeforeDispatchDelegationFrame>(),
);

/** Creates the Host-owned outcome slot consumed by the dispatch integration. */
export function createBeforeDispatchDelegationSlot(): BeforeDispatchDelegationSlot {
  return { established: false };
}

/** Host-derived plugin owner identity for a hook registration. Never plugin-supplied. */
export function deriveBeforeDispatchDelegationOwnerId(
  pluginId: string,
  registrationId?: string,
): string {
  return registrationId ? pluginId + "/" + registrationId : pluginId;
}

/**
 * Host-derived task scope for the current inbound dispatch. The plugin never
 * supplies or overrides these parts; the digest only makes the scope a stable,
 * bounded reference.
 */
export function deriveBeforeDispatchDelegationTaskScopeRef(
  parts: readonly (string | undefined)[],
): string {
  const digest = createHash("sha256")
    .update(parts.map((part) => part ?? "").join(String.fromCharCode(0)))
    .digest("hex");
  return "task:dispatch:" + digest;
}

/**
 * Runs one `before_dispatch` handler inside its delegation frame and closes the
 * frame when the handler settles, so any retained reference fails afterwards.
 */
export async function runWithBeforeDispatchDelegationFrame<T>(
  frame: BeforeDispatchDelegationFrame,
  run: () => Promise<T>,
): Promise<T> {
  return beforeDispatchDelegationFrames.run(frame, async () => {
    try {
      return await run();
    } finally {
      frame.active = false;
    }
  });
}

/** The active delegation frame, or undefined outside an active handler. */
export function readBeforeDispatchDelegationFrame(): BeforeDispatchDelegationFrame | undefined {
  const frame = beforeDispatchDelegationFrames.getStore();
  return frame && frame.active ? frame : undefined;
}

/**
 * Host operation behind `api.runtime.delegation.establishCurrent()`.
 *
 * Refuses outside an active handler, after the handler settles, and when the
 * Host hook admission is no longer current. Repeated calls from the same owner
 * for the same task return the same handles; a different owner is refused.
 */
export async function establishCurrentBeforeDispatchDelegation(
  params: { delegateGoalRef?: string | null } = {},
): Promise<PluginDelegationEstablishment> {
  const frame = readBeforeDispatchDelegationFrame();
  if (!frame) {
    throw new BeforeDispatchDelegationRefusedError(
      "outside-before-dispatch",
      "delegated ownership can only be established from the active before_dispatch handler for the current dispatch",
    );
  }
  // The Host hook admission/binding must still be current when the capability is used.
  await frame.assertCurrent?.();

  const ownerKind = "plugin" as const;
  const ownerId = frame.ownerId;
  const slot = frame.slot;
  if (slot.established) {
    if (slot.ownerId === ownerId && slot.taskScopeRef === frame.taskScopeRef && slot.handles) {
      return slot.handles;
    }
    throw new BeforeDispatchDelegationRefusedError(
      "already-established",
      "delegated ownership for the current dispatch was already established by another owner",
    );
  }

  const delegateGoalRef = params.delegateGoalRef ?? null;
  if (
    delegateGoalRef !== null &&
    (typeof delegateGoalRef !== "string" || delegateGoalRef.trim().length === 0)
  ) {
    throw new BeforeDispatchDelegationRefusedError(
      "invalid-delegate-goal-ref",
      "delegate goal reference must be a non-empty string when provided",
    );
  }

  const taskScopeRef = frame.taskScopeRef;
  const scopeDigest = createHash("sha256").update(taskScopeRef).digest("hex");
  const intent = createHostDelegationIntent({
    ownerKind,
    ownerId,
    taskScopeRef,
    delegationRef: "delegation:plugin:" + scopeDigest,
    lineageRef: "lineage:plugin:" + scopeDigest,
    ...(delegateGoalRef === null ? {} : { delegateGoalRef }),
  });

  const options = frame.options ?? {};
  const establishment = await establishDelegatedExecutionOwnership({
    intent,
    context: frame.context,
    // The plugin is the delegated owner and is available right now. The Host
    // lock and lineage binding above are already durable; the delegate's own
    // goal identity (if any) is attached without overloading delegation_ref.
    delegate: () => ({ kind: "owner-available", delegateGoalRef: intent.delegateGoalRef }),
    ...(Object.keys(options).length === 0 ? {} : { options }),
  });

  const handles: PluginDelegationEstablishment = Object.freeze({
    delegationRef: establishment.delegationRef,
    lineageRef: establishment.lineageRef,
  });
  slot.established = true;
  slot.ownerKind = ownerKind;
  slot.ownerId = ownerId;
  slot.taskScopeRef = taskScopeRef;
  slot.handles = handles;
  return handles;
}

/** Builds the runtime surface injected as `api.runtime.delegation`. */
export function createPluginDelegationRuntime(): PluginDelegationRuntime {
  return Object.freeze({
    establishCurrent: (params) => establishCurrentBeforeDispatchDelegation(params),
  });
}
