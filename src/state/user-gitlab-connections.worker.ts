import { randomUUID } from "node:crypto";
import { runSqliteReadSnapshotSync } from "../infra/sqlite-transaction.js";
import {
  deferSqliteWorkerCommitReceipt,
  requestSqliteWorkerOperationAdmission,
} from "../infra/sqlite-worker-operation-admission.js";
import {
  disconnectedUserGitLabConnection,
  isPersonalGitLabOwnerInDatabase,
  readUserGitLabConnectionInDatabase,
  writeUserGitLabConnectionInDatabase,
} from "./user-gitlab-connections.kernel.js";
import {
  userGitLabConnectionSchema,
  type UserGitLabConnection,
  type UserGitLabConnectionCommit,
  type UserGitLabPending,
  type UserGitLabTokens,
} from "./user-gitlab-connections.types.js";
import type {
  WorkerOperationHandlers,
  WorkerOperations,
  WorkerWriteOperationContext,
} from "./worker-operation-registry.js";

type Key = { owner: string; issuer: string };
type Replace = Key & { expectedGeneration?: string; next: UserGitLabConnection };
type Claim = Key & { generation: string; requestId: string; state: string; nowMs: number };
type BeginRefresh = Key & { generation: string; operationId: string };
type SettleRefresh = Key & {
  operationId: string;
  result:
    | { kind: "rotated"; tokens: UserGitLabTokens }
    | { kind: "failed"; failure: "failed" | "expired" };
};
export const userGitLabConnectionReadOperations = {
  "userGitLabConnections.read": ({ owner, issuer }: Key, db) => ({
    type: "userGitLabConnections.read" as const,
    connection: runSqliteReadSnapshotSync(db, () =>
      readUserGitLabConnectionInDatabase(db, owner, issuer),
    ),
  }),
} satisfies WorkerOperationHandlers<import("../infra/sql-connection.js").EngineConnection>;

function mutate<T>(
  context: WorkerWriteOperationContext,
  action: (
    db: ReturnType<WorkerWriteOperationContext["open"]>["db"],
    capture: (receipt: UserGitLabConnectionCommit) => void,
  ) => T,
): T {
  return context.write(
    ({ db }) => {
      requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
      const receipt: UserGitLabConnectionCommit = { kind: "user-gitlab-connection", changed: [] };
      const result = action(db, (published) => receipt.changed.push(...published.changed));
      requestSqliteWorkerOperationAdmission({ stage: "commit", facts: receipt });
      deferSqliteWorkerCommitReceipt(db, receipt);
      return result;
    },
    { operationLabel: "users.gitlab.mutate" },
  );
}

function requireGeneration(
  current: UserGitLabConnection | undefined,
  expected: string | undefined,
) {
  if (current?.generation !== expected) {
    throw new Error("My GitLab connection changed; reload its status.");
  }
}

export const userGitLabConnectionOperations = {
  "userGitLabConnections.replace": (input: Replace, context) =>
    mutate(context, (db, capture) => {
      const current = readUserGitLabConnectionInDatabase(db, input.owner, input.issuer);
      requireGeneration(current, input.expectedGeneration);
      if (input.next.generation === current?.generation || input.next.issuer !== input.issuer) {
        throw new Error("My GitLab connection requires a fresh generation and matching issuer.");
      }
      const next = userGitLabConnectionSchema.parse(input.next);
      return writeUserGitLabConnectionInDatabase(db, input.owner, input.issuer, next, capture);
    }),
  "userGitLabConnections.claimPending": (input: Claim, context): UserGitLabPending =>
    mutate(context, (db, capture) => {
      const current = readUserGitLabConnectionInDatabase(db, input.owner, input.issuer);
      const pending = current?.pending;
      if (
        !current ||
        current.generation !== input.generation ||
        !pending ||
        pending.requestId !== input.requestId ||
        pending.state !== input.state ||
        pending.createdAtMs > input.nowMs ||
        pending.expiresAtMs <= input.nowMs
      ) {
        throw new Error("My GitLab authorization changed or expired; start again.");
      }
      writeUserGitLabConnectionInDatabase(
        db,
        input.owner,
        input.issuer,
        { ...current, generation: randomUUID(), pending: undefined },
        capture,
      );
      return pending;
    }),
  "userGitLabConnections.beginRefresh": (input: BeginRefresh, context): UserGitLabConnection =>
    mutate(context, (db, capture) => {
      const current = readUserGitLabConnectionInDatabase(db, input.owner, input.issuer);
      if (
        !current ||
        current.generation !== input.generation ||
        current.selection.kind !== "connected" ||
        current.selection.refresh ||
        current.selection.refreshFailure
      ) {
        throw new Error("My GitLab selection changed or refresh is already pending.");
      }
      return writeUserGitLabConnectionInDatabase(
        db,
        input.owner,
        input.issuer,
        {
          ...current,
          selection: { ...current.selection, refresh: { operationId: input.operationId } },
        },
        capture,
      );
    }),
  "userGitLabConnections.settleRefresh": (input: SettleRefresh, context): boolean =>
    mutate(context, (db, capture) => {
      // Exact operation settlement is allowed after caller authority revocation; another
      // operation or disconnect cannot be overwritten because the marker must still match.
      if (!isPersonalGitLabOwnerInDatabase(db, input.owner)) {
        return false;
      }
      const current = readUserGitLabConnectionInDatabase(db, input.owner, input.issuer);
      const selected = current?.selection;
      if (
        !current ||
        selected?.kind !== "connected" ||
        selected.refresh?.operationId !== input.operationId
      ) {
        return false;
      }
      const nextSelection =
        input.result.kind === "rotated"
          ? {
              ...selected,
              tokens: input.result.tokens,
              refresh: undefined,
              refreshFailure: undefined,
            }
          : { ...selected, refreshFailure: input.result.failure };
      writeUserGitLabConnectionInDatabase(
        db,
        input.owner,
        input.issuer,
        { ...current, selection: nextSelection },
        capture,
      );
      return true;
    }),
  "userGitLabConnections.disconnect": (
    input: Key & { expectedGeneration?: string },
    context,
  ): UserGitLabConnection =>
    mutate(context, (db, capture) => {
      const current = readUserGitLabConnectionInDatabase(db, input.owner, input.issuer);
      requireGeneration(current, input.expectedGeneration);
      return writeUserGitLabConnectionInDatabase(
        db,
        input.owner,
        input.issuer,
        disconnectedUserGitLabConnection(input.issuer),
        capture,
      );
    }),
} satisfies WorkerOperationHandlers<WorkerWriteOperationContext>;

export type UserGitLabConnectionWorkerOperations = WorkerOperations<
  typeof userGitLabConnectionOperations
>;
