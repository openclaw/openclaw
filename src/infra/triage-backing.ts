import { realpathSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { resolveServiceManagerEnv } from "../daemon/service-process-env.js";
import {
  assertManagedUpdateLeaseDatabaseIdentity,
  type ManagedUpdateLeaseDatabaseIdentity,
} from "./update-managed-service-handoff-database.js";
import {
  createManagedHandoffLeaseStore,
  type ManagedHandoffLease,
} from "./update-managed-service-handoff-lease.js";
import {
  parseManagedHandoffLeasePayload,
  type HandoffProcessIdentity,
  type ManagedHandoffLeaseAction,
} from "./update-managed-service-handoff-schema.js";

type TriageAction = Extract<ManagedHandoffLeaseAction, { kind: "triage" }>;
export type TriageBackingReference = Readonly<{
  kind: "triage";
  installationRoot: string;
  leaseDatabase: ManagedUpdateLeaseDatabaseIdentity;
  generation: Readonly<{
    version: 2;
    owner: string;
    helper: Readonly<HandoffProcessIdentity>;
    executor: Readonly<HandoffProcessIdentity>;
    lifetime: TriageAction["lifetime"];
  }>;
}>;
export type TriageBackingObservation =
  | Readonly<{
      kind: "matched";
      phase: TriageAction["phase"];
      helper: "live" | "dead" | "unknown";
      executor: "live" | "dead" | "unknown";
      lifetime: "matched" | "mismatch" | "unavailable";
      control: "unavailable";
    }>
  | Readonly<{
      kind: "absent" | "different-generation" | "unavailable";
      reason:
        | "missing-row"
        | "generation-changed"
        | "invalid-reference"
        | "identity-unavailable"
        | "unreadable-row"
        | "observation-changed"
        | "probe-unavailable";
    }>;

const text = z.string().min(1).max(4096);
const referenceSchema = z.strictObject({
  kind: z.literal("triage"),
  installationRoot: text.refine(path.isAbsolute),
  leaseDatabase: z.strictObject({
    databasePath: text.refine(path.isAbsolute),
    databaseIdentity: z
      .string()
      .max(128)
      .regex(/^\d+:\d+$/),
    parentIdentity: z
      .string()
      .max(128)
      .regex(/^\d+:\d+$/),
  }),
  generation: z.strictObject({
    version: z.literal(2),
    owner: text,
    helper: z.unknown(),
    executor: z.unknown(),
    lifetime: z.unknown(),
  }),
});

function parseReference(value: unknown) {
  const parsed = referenceSchema.parse(value);
  // Reuse the existing lease payload validator; do not introduce another lifetime schema.
  const payload = parseManagedHandoffLeasePayload(
    JSON.stringify({
      version: 2,
      helper: parsed.generation.helper,
      executor: parsed.generation.executor,
      action: { kind: "triage", phase: "running", lifetime: parsed.generation.lifetime },
    }),
  );
  if (
    !payload ||
    payload.version !== 2 ||
    payload.action.kind !== "triage" ||
    payload.helper.pid === payload.executor.pid
  ) {
    throw new Error("invalid triage backing generation");
  }
  const lifetime = payload.action.lifetime;
  if (lifetime.kind === "foreground") {
    Object.freeze(lifetime.boot);
  } else {
    Object.freeze(lifetime.placement);
  }
  const reference: TriageBackingReference = Object.freeze({
    kind: "triage",
    installationRoot: parsed.installationRoot,
    leaseDatabase: Object.freeze(parsed.leaseDatabase),
    generation: Object.freeze({
      version: 2,
      owner: parsed.generation.owner,
      helper: Object.freeze(payload.helper),
      executor: Object.freeze(payload.executor),
      lifetime: Object.freeze(lifetime),
    }),
  });
  const lease: ManagedHandoffLease = {
    ...payload,
    key: reference.installationRoot,
    owner: reference.generation.owner,
    payload: JSON.stringify(payload),
    updatedAt: 0,
  };
  return { reference, lease };
}

/** Called inside successful admission, bracketed by the caller's live assertions. DATA, not a grant. */
export function captureTriageBackingReference(
  lease: ManagedHandoffLease,
  leaseDatabase: ManagedUpdateLeaseDatabaseIdentity,
): TriageBackingReference {
  if (lease.version !== 2 || lease.action.kind !== "triage" || lease.action.phase !== "running") {
    throw new Error("triage backing requires an admitted running generation");
  }
  const { reference } = parseReference({
    kind: "triage",
    installationRoot: lease.key,
    leaseDatabase,
    generation: {
      version: 2,
      owner: lease.owner,
      helper: lease.helper,
      executor: lease.executor,
      lifetime: lease.action.lifetime,
    },
  });
  assertManagedUpdateLeaseDatabaseIdentity(reference.leaseDatabase);
  if (realpathSync(reference.installationRoot) !== reference.installationRoot) {
    throw new Error("triage backing root changed");
  }
  const store = createManagedHandoffLeaseStore({
    databasePath: reference.leaseDatabase.databasePath,
    existingIdentity: reference.leaseDatabase,
    serviceManagerEnv: resolveServiceManagerEnv(),
  });
  if (!store.current(lease)) {
    throw new Error("triage backing generation changed during capture");
  }
  assertManagedUpdateLeaseDatabaseIdentity(reference.leaseDatabase);
  return reference;
}

/** Classifies readonly probes; generation and database stability are checked by the caller. */
function observeTriageRuntime(
  store: ReturnType<typeof createManagedHandoffLeaseStore>,
  lease: ManagedHandoffLease,
) {
  const helper = store.observeProcessState(lease.helper);
  const executor = store.observeProcessState(lease.executor);
  let lifetime: "matched" | "mismatch" | "unavailable" = "unavailable";
  if (lease.version === 2 && lease.action.kind === "triage") {
    const life = lease.action.lifetime;
    try {
      if (life.kind === "foreground") {
        lifetime = isDeepStrictEqual(store.observeBootIdentity(), life.boot)
          ? "matched"
          : "mismatch";
      } else if (life.placement.kind === "attached") {
        const scope = store.observeNativeScope(life);
        if (scope) {
          lifetime =
            scope.Id === life.scope &&
            scope.LoadState === "loaded" &&
            scope.InvocationID === life.placement.invocation &&
            Boolean(scope.ControlGroup)
              ? "matched"
              : "mismatch";
        }
      }
    } catch {
      // An unavailable boot/scope probe is not evidence of a retired owner.
    }
  }
  return { helper, executor, lifetime };
}

/** Bounded read-only observation. Never reclaims, signals, resumes or cancels a persisted owner. */
export function observeTriageBacking(value: unknown): TriageBackingObservation {
  let parsed: ReturnType<typeof parseReference>;
  try {
    parsed = parseReference(value);
  } catch {
    return { kind: "unavailable", reason: "invalid-reference" };
  }
  const { reference, lease } = parsed;
  const assertIdentity = () => {
    assertManagedUpdateLeaseDatabaseIdentity(reference.leaseDatabase);
    if (realpathSync(reference.installationRoot) !== reference.installationRoot) {
      throw new Error("triage backing root changed");
    }
  };
  try {
    assertIdentity();
  } catch {
    return { kind: "unavailable", reason: "identity-unavailable" };
  }
  const store = createManagedHandoffLeaseStore({
    databasePath: reference.leaseDatabase.databasePath,
    existingIdentity: reference.leaseDatabase,
    serviceManagerEnv: resolveServiceManagerEnv(),
  });
  const before = store.read(reference.installationRoot);
  if (before.kind === "unreadable") {
    return { kind: "unavailable", reason: "unreadable-row" };
  }
  // readGeneration owns the phase-tolerant generation comparison, not owns().
  const generation = store.readGeneration(lease);
  let runtime: ReturnType<typeof observeTriageRuntime> | undefined;
  try {
    if (generation) {
      runtime = observeTriageRuntime(store, generation);
    }
  } catch {
    return { kind: "unavailable", reason: "probe-unavailable" };
  }
  const after = store.read(reference.installationRoot);
  try {
    assertIdentity();
  } catch {
    return { kind: "unavailable", reason: "identity-unavailable" };
  }
  if (after.kind === "unreadable") {
    return { kind: "unavailable", reason: "unreadable-row" };
  }
  if (
    !isDeepStrictEqual(before, after) ||
    (generation && (before.kind !== "current" || !isDeepStrictEqual(generation, before.lease)))
  ) {
    return { kind: "unavailable", reason: "observation-changed" };
  }
  if (before.kind !== "current") {
    return { kind: "absent", reason: "missing-row" };
  }
  if (!generation || !runtime) {
    const active = before.lease;
    // A null readGeneration can mean an unavailable intermediate read, not a different owner.
    const matches =
      active.version === 2 &&
      active.action.kind === "triage" &&
      active.owner === lease.owner &&
      isDeepStrictEqual(active.helper, lease.helper) &&
      isDeepStrictEqual(active.executor, lease.executor) &&
      lease.action.kind === "triage" &&
      isDeepStrictEqual(active.action.lifetime, lease.action.lifetime);
    return matches
      ? { kind: "unavailable", reason: "observation-changed" }
      : { kind: "different-generation", reason: "generation-changed" };
  }
  return Object.freeze({
    kind: "matched",
    phase: generation.action.phase,
    ...runtime,
    control: "unavailable",
  });
}
