import { randomUUID } from "node:crypto";
import { SqliteWorkerError, type SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import {
  createSqliteWorkerOperationAdmission,
  type SqliteWorkerAdmissionFactory,
  type SqliteWorkerOperationAdmission,
} from "../../infra/sqlite-worker-operation-admission.js";
import type { SqliteWorkerOperationSettlement } from "../../infra/sqlite-worker-operation-settlement.js";
import { withOpenClawStateLeasesWorkerAdmission } from "../../state/openclaw-state-lease-worker-owner.js";
import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";
import type { OpenClawStateWorkerOperations } from "../../state/openclaw-state-worker-contract.js";
import type { DomainScope } from "../../state/openclaw-state-worker-store.types.js";
import {
  readWorktreeRegistryWorkerReceipt,
  withWorktreeRegistryPublication,
} from "./registry-publication.js";
import type {
  WorktreeRemovalRowInput,
  WorktreeRemovalFinalization,
} from "./registry-run-end.worker.js";
import {
  captureWorktreeRunEndContext,
  captureWorktreeRegistryMutation,
  retainWorktreeRunEndFailure,
  withWorktreeRunEnd,
  type WorktreeRegistryChange,
  type WorktreeRegistryField,
  worktreeOwnerSelectionKey,
  WORKTREE_UNKNOWN_OWNER_SELECTION,
} from "./run-end-lifecycle.js";
import type { WorktreeRegistryPredicate, WorktreeWorkerAuthority } from "./types.js";

/** Delivery failure does not undo a committed write; native settlement owns its outcome. */
export async function runWorktreeRegistryCommand<T>(
  context: OpenClawStateWorkerContext,
  execute: (scope: DomainScope) => Promise<T>,
  options: {
    unknownMessage: string;
    signal?: AbortSignal;
    assertCurrent?: () => void;
    createAdmission?: SqliteWorkerAdmissionFactory;
    mutation: { observeTransaction(): void; settle(unknown: boolean): void };
    onSettlement?: (kind: SqliteWorkerOperationSettlement["kind"]) => void;
    recover: (
      receipt: NonNullable<ReturnType<typeof readWorktreeRegistryWorkerReceipt>>,
    ) => { value: T } | undefined;
  },
): Promise<T> {
  let settled: Promise<SqliteWorkerOperationSettlement> | undefined;
  let admission: SqliteWorkerOperationAdmission | undefined;
  let result: { value: T } | { error: unknown };
  try {
    const { runOpenClawStateWorkerOperation } =
      await import("../../state/openclaw-state-worker-store.js");
    result = {
      value: await runOpenClawStateWorkerOperation(context, execute, {
        signal: options.signal,
        assertCurrent: options.assertCurrent,
        createAdmission: withWorktreeRegistryPublication((operation) => {
          settled = operation.settled;
          const owner = options.createAdmission?.(operation) ?? {
            nativeLocations: [context.admission.databasePath],
            admission: createSqliteWorkerOperationAdmission((_request, grant) => {
              context.admission.assertCurrent();
              options.assertCurrent?.();
              grant();
            }),
          };
          admission = owner.admission;
          admission.observeRequests((request) => {
            if (request.stage === "transaction") {
              options.mutation.observeTransaction();
            }
          });
          return owner;
        }, context),
      }),
    };
  } catch (error) {
    result = { error };
  }
  const outcome = await settled;
  options.mutation.settle(outcome?.kind === "unknown");
  options.onSettlement?.(outcome?.kind ?? "not-entered");
  if (outcome?.kind === "unknown") {
    throw Object.assign(new SqliteWorkerError(options.unknownMessage, "outcome-unknown"), {
      cause: ("error" in result ? result.error : undefined) ?? outcome.error,
    });
  }
  if ("value" in result) {
    return result.value;
  }
  const receipt = readWorktreeRegistryWorkerReceipt(admission?.committed?.facts);
  const recovered = outcome?.kind === "completed" && receipt ? options.recover(receipt) : undefined;
  if (recovered) {
    return recovered.value;
  }
  throw result.error;
}

type RunEndCommands = Pick<
  OpenClawStateWorkerOperations,
  | "worktrees.writeProvisionedSnapshot"
  | "worktrees.claimRemoval"
  | "worktrees.finalizeRemoval"
  | "worktrees.abortRemoval"
  | "worktrees.insert"
  | "worktrees.update"
  | "worktrees.delete"
  | "worktrees.reservePending"
  | "worktrees.releasePending"
  | "worktrees.recoverPending"
>;
type LeaseSetAdmission = Parameters<
  Parameters<typeof withOpenClawStateLeasesWorkerAdmission>[2]
>[0];

function commandChanges(
  command: SqliteWorkerCommand<RunEndCommands>,
  predicates: readonly WorktreeRegistryPredicate[] = [],
): WorktreeRegistryChange[] {
  switch (command.type) {
    case "worktrees.reservePending":
    case "worktrees.releasePending":
    case "worktrees.recoverPending":
      // Pending slots do not publish registry rows.
      return [];
    case "worktrees.insert":
    case "worktrees.delete":
      return [
        {
          id:
            command.type === "worktrees.insert"
              ? command.input.value.record.id
              : command.input.value.id,
          fields: [
            "identity",
            "fingerprint",
            "activity",
            "removal",
            "snapshot",
            "provisioned",
            "cleanup",
            "leases",
          ],
        },
        { id: "*", fields: ["identity"] },
        ...(command.type === "worktrees.insert" && command.input.value.record.ownerId !== undefined
          ? [
              {
                id: worktreeOwnerSelectionKey(
                  command.input.value.record.ownerKind,
                  command.input.value.record.ownerId,
                ),
                fields: ["identity"] as const,
              },
            ]
          : []),
      ];
    case "worktrees.update": {
      const { id, patch } = command.input.value;
      const fields: WorktreeRegistryField[] = [];
      if (patch.repositoryIdentity) {
        const binding = predicates.flatMap((predicate) =>
          predicate.kind === "binding" && predicate.record.id === id ? [predicate.record] : [],
        )[0];
        // The transaction checks this exact binding before applying repository normalization.
        if (binding?.repoRoot !== patch.repositoryIdentity.repoRoot) {
          fields.push("identity");
        }
        if (binding?.repoFingerprint !== patch.repositoryIdentity.repoFingerprint) {
          fields.push("fingerprint");
        }
      }
      if ("lastActiveAt" in patch) {
        fields.push("activity");
      }
      if ("removedAt" in patch) {
        fields.push("removal");
      }
      if ("snapshotRef" in patch) {
        fields.push("snapshot");
      }
      if ("runEndCleanup" in patch) {
        fields.push("cleanup");
      }
      if ("provisionedPaths" in patch || "provisionedState" in patch) {
        fields.push("provisioned");
      }
      const owner = predicates.flatMap((predicate) =>
        "record" in predicate &&
        predicate.record.id === id &&
        predicate.record.ownerId !== undefined
          ? [predicate.record]
          : [],
      )[0];
      const selection =
        "removedAt" in patch && patch.removedAt === undefined
          ? [
              {
                id:
                  owner?.ownerId !== undefined
                    ? worktreeOwnerSelectionKey(owner.ownerKind, owner.ownerId)
                    : WORKTREE_UNKNOWN_OWNER_SELECTION,
                fields: ["identity"] as const,
              },
            ]
          : [];
      return [{ id, fields }, ...selection];
    }
    case "worktrees.writeProvisionedSnapshot":
      return [{ id: command.input.value.worktreeId, fields: ["provisioned"] }];
    case "worktrees.claimRemoval":
    case "worktrees.finalizeRemoval":
    case "worktrees.abortRemoval":
      return [{ id: command.input.value.worktreeId, fields: ["leases"] }];
  }
  throw new Error(`Unknown worktree command: ${String(command satisfies never)}`);
}

export function runWorktreeRunEndCommand(
  context: OpenClawStateWorkerContext,
  command: SqliteWorkerCommand<RunEndCommands>,
  authority: WorktreeWorkerAuthority = {},
): Promise<void> {
  const captured = structuredClone(command);
  const predicates = structuredClone(authority.predicates);
  const assertCaller = authority.assertCurrent;
  const leaseSet = authority.leaseSet;
  return withWorktreeRunEnd(context.environment, async () => {
    const mutation = captureWorktreeRegistryMutation(context, commandChanges(captured, predicates));
    const assertCurrent = () => mutation.assertAuthority(() => assertCaller?.());
    context.admission.assertCurrent();
    if (
      leaseSet &&
      leaseSet.context.admission.coordinationKey !== context.admission.coordinationKey
    ) {
      throw new Error("Worktree settlement lease set belongs to another database");
    }
    const execute = (leases?: LeaseSetAdmission) =>
      runWorktreeRegistryCommand(
        leaseSet?.context ?? context,
        (scope) =>
          scope.execute({
            type: captured.type,
            input: { ...captured.input, predicates, leases: leases?.identities },
          }),
        {
          signal: authority.signal,
          assertCurrent: leases?.assertCurrent ?? assertCurrent,
          createAdmission: leases?.createAdmission,
          mutation,
          unknownMessage: "Worktree settlement outcome is unknown; recovery custody retained",
          recover: (receipt) =>
            receipt.receipt === captured.input.receipt ? { value: undefined } : undefined,
        },
      );
    try {
      await (leaseSet
        ? withOpenClawStateLeasesWorkerAdmission(leaseSet.leases, leaseSet.context, execute, {
            assertCurrent: () => {
              context.admission.assertCurrent();
              assertCurrent?.();
            },
          })
        : execute());
    } catch (error) {
      retainWorktreeRunEndFailure(error);
      throw error;
    }
  });
}

export function claimWorktreeRemovalRow(
  env: NodeJS.ProcessEnv,
  params: WorktreeRemovalRowInput & {
    assertCurrent?: () => void;
    workerAuthority?: WorktreeWorkerAuthority;
  },
): Promise<void> {
  const { assertCurrent, workerAuthority, ...value } = params;
  assertCurrent?.();
  return runWorktreeRunEndCommand(
    captureWorktreeRunEndContext(env),
    { type: "worktrees.claimRemoval", input: { value, receipt: randomUUID() } },
    workerAuthority ?? { assertCurrent },
  );
}

export function finalizeWorktreeRemovalRows(
  env: NodeJS.ProcessEnv,
  value: WorktreeRemovalFinalization,
  authority?: WorktreeWorkerAuthority,
): Promise<void> {
  return runWorktreeRunEndCommand(
    captureWorktreeRunEndContext(env),
    { type: "worktrees.finalizeRemoval", input: { value, receipt: randomUUID() } },
    authority,
  );
}

export function abortWorktreeRemovalRow(
  env: NodeJS.ProcessEnv,
  worktreeId: string,
  token: string,
): Promise<void> {
  return runWorktreeRunEndCommand(captureWorktreeRunEndContext(env), {
    type: "worktrees.abortRemoval",
    input: { value: { worktreeId, token }, receipt: randomUUID() },
  });
}
