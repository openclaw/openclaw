import { executeExistingOpenClawStateRead } from "../../state/openclaw-state-db-readonly.js";
import { captureOpenClawStateReadWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";
import {
  SessionWorktreeSourceChangedError,
  SessionWorktreeLifecycleError,
  WorktreeRemovalContentionError,
  WorktreeRemovalLockError,
} from "./errors.js";
import type { WorktreeRegistryListOptions } from "./registry-read.kernel.js";
import {
  captureWorktreeRegistryAuthority,
  captureWorktreeRunEndContext,
  type WorktreeRegistryChange,
  type WorktreeRegistryField,
  worktreeOwnerSelectionKey,
  WORKTREE_UNKNOWN_OWNER_SELECTION,
} from "./run-end-lifecycle.js";
import type {
  CreateManagedWorktreeParams,
  ManagedWorktreeOwnerKind,
  ManagedWorktreeRecord,
  ProvisionedFileState,
  WorktreeRegistryPredicate,
  WorktreeWorkerAuthority,
} from "./types.js";

type RowGuardKind = WorktreeRegistryPredicate["kind"] | "lifecycle" | "publication";

function registryAuthorityChanged(kind: RowGuardKind): Error {
  switch (kind) {
    case "publication":
      return new SessionWorktreeSourceChangedError("GitHub publication worktree authority changed");
    case "snapshot-retirement":
      return new Error("Worktree snapshot retirement identity changed");
    case "exact-snapshot":
      return new Error(
        "Exact-state recovery owner or lifecycle changed; source and snapshot preserved",
      );
    case "exact-owner":
      return new Error("Worktree exact-state owner or lifecycle changed; checkout preserved");
    case "activity":
      return new WorktreeRemovalLockError("busy", "worktree activity changed during cleanup");
    case "session-owner":
      return new SessionWorktreeLifecycleError(
        "Session worktree ownership changed; retry cleanup.",
        "owner-mismatch",
      );
    case "source-record":
      return new SessionWorktreeSourceChangedError(
        "Accepted managed source changed during preparation",
      );
    case "source-owner":
      return new SessionWorktreeSourceChangedError(
        "Spawn parent managed worktree changed; retry from its current session",
      );
    case "projection":
      return new Error("Managed projection owner changed during settlement");
    case "record":
      return new Error(
        "Worktree registry changed during recovery; remaining source and original snapshot preserved",
      );
    default:
      return new WorktreeRemovalContentionError(
        "busy",
        "Worktree owner or binding changed; checkout preserved",
      );
  }
}

function predicateFields(kind: RowGuardKind): readonly WorktreeRegistryField[] {
  switch (kind) {
    case "activity":
      return ["activity", "identity"];
    case "removal-claim":
    case "removal-claims":
      return ["leases"];
    case "session-owner":
    case "projection":
      return ["identity"];
    case "source-record":
      return ["identity", "fingerprint"];
    case "source-owner":
    case "lifecycle":
      return ["identity", "removal"];
    case "publication":
    case "live-binding":
      return ["identity", "fingerprint", "removal"];
    case "exact-owner":
      return ["identity", "activity", "removal"];
    case "binding":
      return ["identity", "fingerprint", "activity", "removal"];
    case "exact-snapshot":
      return ["identity", "fingerprint", "activity", "removal", "snapshot"];
    case "record":
      return ["identity", "fingerprint", "activity", "removal", "snapshot", "cleanup"];
    case "snapshot-retirement":
      return [
        "identity",
        "fingerprint",
        "activity",
        "removal",
        "snapshot",
        "cleanup",
        "provisioned",
        "leases",
      ];
  }
  throw new Error(`Unknown worktree predicate: ${String(kind satisfies never)}`);
}

function predicateRevisions(predicate: WorktreeRegistryPredicate): WorktreeRegistryChange[] {
  const fields = predicateFields(predicate.kind);
  const ids =
    predicate.kind === "removal-claims"
      ? predicate.ids
      : ["record" in predicate ? predicate.record.id : predicate.id];
  return [
    ...ids.map((id) => ({ id, fields })),
    ...(predicate.kind === "source-owner"
      ? [
          {
            id: worktreeOwnerSelectionKey("session", predicate.ownerId),
            fields: ["identity"] as const,
          },
          { id: WORKTREE_UNKNOWN_OWNER_SELECTION, fields: ["identity"] as const },
        ]
      : []),
  ];
}

/** Capture before a row read, then narrow the unchanged owner witness to its returned ID. */
export function captureWorktreeRegistryReadGuard(
  context: OpenClawStateWorkerContext,
  kind:
    | "publication"
    | "binding"
    | "record"
    | "exact-snapshot"
    | "exact-owner"
    | "session-owner"
    | "source-record"
    | "projection"
    | "source-owner"
    | "lifecycle",
): (record: Pick<ManagedWorktreeRecord, "id" | "ownerKind" | "ownerId"> | undefined) => () => void {
  const fields = predicateFields(kind);
  const assertRead = captureWorktreeRegistryAuthority(context, [{ id: "*", fields }]);
  const verify = (assertCurrent: () => void) => {
    try {
      assertCurrent();
    } catch {
      throw registryAuthorityChanged(kind);
    }
  };
  return (record) => {
    context.admission.assertCurrent();
    verify(assertRead);
    const assertRow = record
      ? captureWorktreeRegistryAuthority(context, [
          { id: record.id, fields },
          ...((kind === "source-owner" || kind === "publication") && record.ownerId !== undefined
            ? [
                {
                  id: worktreeOwnerSelectionKey(record.ownerKind, record.ownerId),
                  fields: ["identity"] as const,
                },
                { id: WORKTREE_UNKNOWN_OWNER_SELECTION, fields: ["identity"] as const },
              ]
            : []),
        ])
      : assertRead;
    return () => {
      context.admission.assertCurrent();
      verify(assertRow);
    };
  };
}

/** One exact-row read prepares a SQL-free guard retained through filesystem and Git waits. */
export async function prepareWorktreeRegistryGuard(
  context: OpenClawStateWorkerContext,
  authority: WorktreeWorkerAuthority,
): Promise<() => void> {
  const predicates = structuredClone(authority.predicates ?? []);
  const assertCaller = authority.assertCurrent;
  const generations = predicates.map((predicate) => ({
    kind: predicate.kind,
    assertCurrent: captureWorktreeRegistryAuthority(context, predicateRevisions(predicate)),
  }));
  const assertCurrent = () => {
    context.admission.assertCurrent();
    assertCaller?.();
    for (const generation of generations) {
      try {
        generation.assertCurrent();
      } catch {
        throw registryAuthorityChanged(generation.kind);
      }
    }
  };
  assertCurrent();
  if (predicates.length > 0) {
    const { executeOpenClawStateWorker } =
      await import("../../state/openclaw-state-worker-store.js");
    await executeOpenClawStateWorker(context, {
      type: "worktrees.assertPredicates",
      input: { predicates },
    });
    assertCurrent();
  }
  return assertCurrent;
}

export async function readLiveRegistryWorktreeByOwner(
  context: OpenClawStateWorkerContext,
  ownerKind: ManagedWorktreeOwnerKind,
  ownerId: string,
): Promise<ManagedWorktreeRecord | undefined> {
  const { executeOpenClawStateWorker } = await import("../../state/openclaw-state-worker-store.js");
  return await executeOpenClawStateWorker(context, {
    type: "worktrees.findLiveByOwner",
    input: { ownerKind, ownerId },
  });
}

export async function readRegistryWorktree(
  context: OpenClawStateWorkerContext,
  id: string,
): Promise<ManagedWorktreeRecord | undefined> {
  const { executeOpenClawStateWorker } = await import("../../state/openclaw-state-worker-store.js");
  return await executeOpenClawStateWorker(context, { type: "worktrees.get", input: { id } });
}

export async function readSessionWorktreeBinding(
  context: OpenClawStateWorkerContext,
  boundId: string | undefined,
  ownerId: string,
): Promise<ManagedWorktreeRecord | undefined> {
  const { executeOpenClawStateWorker } = await import("../../state/openclaw-state-worker-store.js");
  return await executeOpenClawStateWorker(context, {
    type: "worktrees.sessionBinding",
    input: { boundId, ownerId },
  });
}

export async function readLiveRegistryWorktreeByPath(
  context: OpenClawStateWorkerContext,
  path: string,
): Promise<ManagedWorktreeRecord | undefined> {
  const { executeOpenClawStateWorker } = await import("../../state/openclaw-state-worker-store.js");
  return await executeOpenClawStateWorker(context, {
    type: "worktrees.findLiveByPath",
    input: { path },
  });
}

/** Resolve the exact target before lock admission without borrowing Gateway-thread SQLite. */
export async function readRegistryWorktreeForMutation(
  params: { env: NodeJS.ProcessEnv; id: string } & Pick<
    CreateManagedWorktreeParams,
    "signal" | "commitGuard"
  >,
): Promise<ManagedWorktreeRecord | undefined> {
  const assertCurrent = () => {
    params.signal?.throwIfAborted();
    params.commitGuard?.();
  };
  assertCurrent();
  const record = await readRegistryWorktree(captureWorktreeRunEndContext(params.env), params.id);
  assertCurrent();
  return record;
}

export function requireActiveWorktreeRecord(
  id: string,
  record: ManagedWorktreeRecord | undefined,
): ManagedWorktreeRecord {
  if (!record || record.removedAt !== undefined) {
    throw new Error(`unknown active worktree: ${id}`);
  }
  return record;
}

export async function readRegistryWorktrees(
  env: NodeJS.ProcessEnv,
  options: WorktreeRegistryListOptions = {},
  context: OpenClawStateWorkerContext = captureWorktreeRunEndContext(env),
): Promise<ManagedWorktreeRecord[]> {
  const input = { liveOnly: options.liveOnly };
  const { executeOpenClawStateWorker } = await import("../../state/openclaw-state-worker-store.js");
  return await executeOpenClawStateWorker(context, { type: "worktrees.list", input });
}

export async function readLiveRegistryWorktreeIds(env: NodeJS.ProcessEnv): Promise<string[]> {
  const context = captureWorktreeRunEndContext(env);
  const { executeOpenClawStateWorker } = await import("../../state/openclaw-state-worker-store.js");
  return await executeOpenClawStateWorker(context, { type: "worktrees.liveIds", input: undefined });
}

export async function getRegistryWorktreeProvisionedPaths(
  env: NodeJS.ProcessEnv,
  id: string,
): Promise<string[] | undefined> {
  const context = captureWorktreeRunEndContext(env);
  const { executeOpenClawStateWorker } = await import("../../state/openclaw-state-worker-store.js");
  return await executeOpenClawStateWorker(context, {
    type: "worktrees.provisionedPaths",
    input: { id },
  });
}

export async function getRegistryWorktreeProvisionedState(
  env: NodeJS.ProcessEnv,
  id: string,
): Promise<ProvisionedFileState[] | undefined> {
  const context = captureWorktreeRunEndContext(env);
  const { executeOpenClawStateWorker } = await import("../../state/openclaw-state-worker-store.js");
  return await executeOpenClawStateWorker(context, {
    type: "worktrees.provisionedState",
    input: { id },
  });
}

export async function getRegistryWorktreeProvisionedChunk(
  env: NodeJS.ProcessEnv,
  params: { worktreeId: string; path: string; chunkIndex: number },
): Promise<Uint8Array | undefined> {
  const context = captureWorktreeRunEndContext(env);
  const input = { ...params };
  const { executeOpenClawStateWorker } = await import("../../state/openclaw-state-worker-store.js");
  return await executeOpenClawStateWorker(context, {
    type: "worktrees.provisionedChunk",
    input,
  });
}

export async function readWorktreeCleanupState(env: NodeJS.ProcessEnv) {
  const reply = await executeExistingOpenClawStateRead(
    { env },
    { type: "worktrees.cleanupState" },
    { current: true },
  );
  if (!reply) {
    return { records: [], leases: { liveScopes: [], staleScopes: [] } };
  }
  if (!reply.ok || reply.type !== "worktrees.cleanupState") {
    throw new Error("Worktree cleanup state read failed");
  }
  return reply;
}

/** Foreign CLI inspection never admits a writer or repairs lifecycle state. */
export async function readExistingRegistryWorktrees(env: NodeJS.ProcessEnv, signal?: AbortSignal) {
  const context = captureOpenClawStateReadWorkerContext({ env });
  const reply = await executeExistingOpenClawStateRead(
    { env, path: context.admission.databasePath },
    { type: "worktrees.list" },
    { context, current: true, signal },
  );
  context.admission.assertCurrent();
  if (!reply) {
    return [];
  }
  if (!reply.ok || reply.type !== "worktrees.list") {
    throw new Error("Worktree registry inspection failed");
  }
  return reply.records;
}
