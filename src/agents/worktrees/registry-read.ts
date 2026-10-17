import { executeExistingOpenClawStateRead } from "../../state/openclaw-state-db-readonly.js";
import type { RegisteredStateReadCommand } from "../../state/openclaw-state-read-operation-registry.js";
import { captureOpenClawStateReadWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";
import { registryAuthorityChanged } from "./errors.js";
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

async function readRegistry<
  Command extends Extract<RegisteredStateReadCommand, { type: `worktrees.${string}` }>,
>(
  context: OpenClawStateWorkerContext,
  command: Command,
  signal?: AbortSignal,
): ReturnType<typeof executeExistingOpenClawStateRead<Command>> {
  const reply = await executeExistingOpenClawStateRead<Command>(
    { env: context.environment, path: context.admission.databasePath },
    command,
    { context, current: true, signal },
  );
  context.admission.assertCurrent();
  return reply;
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
  const predicates = authority.predicates ?? [];
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
  return (
    await readRegistry(context, {
      type: "worktrees.findLiveByOwner",
      input: { ownerKind, ownerId },
    })
  )?.value;
}

export async function readRegistryWorktree(
  context: OpenClawStateWorkerContext,
  id: string,
): Promise<ManagedWorktreeRecord | undefined> {
  return (await readRegistry(context, { type: "worktrees.get", input: { id } }))?.value;
}

export async function readSessionWorktreeBinding(
  context: OpenClawStateWorkerContext,
  boundId: string | undefined,
  ownerId: string,
): Promise<ManagedWorktreeRecord | undefined> {
  return (
    await readRegistry(context, {
      type: "worktrees.sessionBinding",
      input: { boundId, ownerId },
    })
  )?.value;
}

export async function readLiveRegistryWorktreeByPath(
  context: OpenClawStateWorkerContext,
  path: string,
): Promise<ManagedWorktreeRecord | undefined> {
  return (
    await readRegistry(context, {
      type: "worktrees.findLiveByPath",
      input: { path },
    })
  )?.value;
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
  return (await readRegistry(context, { type: "worktrees.list", input: options }))?.value ?? [];
}

export async function readLiveRegistryWorktreeIds(env: NodeJS.ProcessEnv): Promise<string[]> {
  const context = captureWorktreeRunEndContext(env);
  return (
    (await readRegistry(context, { type: "worktrees.liveIds", input: undefined }))?.value ?? []
  );
}

export async function getRegistryWorktreeProvisionedPaths(
  env: NodeJS.ProcessEnv,
  id: string,
): Promise<string[] | undefined> {
  return (
    await readRegistry(captureWorktreeRunEndContext(env), {
      type: "worktrees.provisionedPaths",
      input: { id },
    })
  )?.value;
}

export async function getRegistryWorktreeProvisionedState(
  env: NodeJS.ProcessEnv,
  id: string,
): Promise<ProvisionedFileState[] | undefined> {
  return (
    await readRegistry(captureWorktreeRunEndContext(env), {
      type: "worktrees.provisionedState",
      input: { id },
    })
  )?.value;
}

export async function getRegistryWorktreeProvisionedChunk(
  env: NodeJS.ProcessEnv,
  params: { worktreeId: string; path: string; chunkIndex: number },
): Promise<Uint8Array | undefined> {
  return (
    await readRegistry(captureWorktreeRunEndContext(env), {
      type: "worktrees.provisionedChunk",
      input: params,
    })
  )?.value;
}

export async function readWorktreeCleanupState(env: NodeJS.ProcessEnv) {
  const reply = await executeExistingOpenClawStateRead(
    { env },
    { type: "worktrees.cleanupState" },
    { current: true },
  );
  return reply ?? { records: [], leases: { liveScopes: [], staleScopes: [] } };
}

/** Foreign CLI inspection never admits a writer or repairs lifecycle state. */
export async function readExistingRegistryWorktrees(env: NodeJS.ProcessEnv, signal?: AbortSignal) {
  const context = captureOpenClawStateReadWorkerContext({ env });
  return (await readRegistry(context, { type: "worktrees.list", input: {} }, signal))?.value ?? [];
}
