import { randomUUID } from "node:crypto";
import {
  deferSqliteWorkerCommitReceipt,
  requestSqliteWorkerOperationAdmission,
} from "../infra/sqlite-worker-operation-admission.js";
import {
  cancelUserGitHubAuthorizationInDatabase,
  disconnectedUserGitHubConnection,
  disconnectUserGitHubConnectionInDatabase,
  listUserGitHubConnectionsInDatabase,
  readUserGitHubConnectionInDatabase,
  readCanonicalUserGitHubConnectionInDatabase,
  writeUserGitHubConnectionInDatabase,
} from "./user-github-connections.kernel.js";
import type {
  UserGitHubConnection,
  UserGitHubConnectionCommit,
  UserGitHubConnectionMutation,
  UserGitHubRefreshMutation,
} from "./user-github-connections.types.js";
import type {
  WorkerOperationHandlers,
  WorkerOperations,
  WorkerWriteOperationContext,
} from "./worker-operation-registry.js";

function requirePending(
  current: UserGitHubConnection | undefined,
  generation: string,
  requestId: string,
) {
  if (
    !current?.pending ||
    current.generation !== generation ||
    current.pending.requestId !== requestId ||
    current.pending.expiresAtMs <= Date.now()
  ) {
    throw new Error("My GitHub authorization changed or expired; start again.");
  }
  return { ...current, pending: current.pending };
}

function applyMutation(
  current: UserGitHubConnection | undefined,
  mutation: Exclude<UserGitHubConnectionMutation, { kind: "disconnect" | "cancel" }>,
): UserGitHubConnection | undefined {
  switch (mutation.kind) {
    case "start":
      return {
        ...(current ?? disconnectedUserGitHubConnection()),
        pending: {
          kind: "starting",
          requestId: mutation.requestId,
          createdAtMs: mutation.createdAtMs,
          expiresAtMs: mutation.expiresAtMs,
        },
      };
    case "device":
      return {
        ...requirePending(current, mutation.generation, mutation.requestId),
        pending: mutation.device,
      };
    case "poll": {
      const owned = requirePending(current, mutation.generation, mutation.requestId);
      if (owned.pending.kind !== "device" || owned.pending.deviceCode !== mutation.deviceCode) {
        throw new Error("My GitHub authorization changed.");
      }
      const result = mutation.result;
      return {
        ...owned,
        pending:
          result.kind === "terminal"
            ? undefined
            : {
                ...owned.pending,
                ...(result.kind === "candidate"
                  ? { candidate: result.candidate }
                  : { pollIntervalMs: result.pollIntervalMs, nextPollAtMs: result.nextPollAtMs }),
              },
      };
    }
    case "connect": {
      const owned = requirePending(current, mutation.generation, mutation.requestId);
      const candidate = owned.pending.kind === "device" ? owned.pending.candidate : undefined;
      if (!candidate || candidate.profileId !== mutation.profileId) {
        throw new Error("My GitHub authorization changed.");
      }
      return {
        ...owned,
        generation: randomUUID(),
        pending: undefined,
        selection: {
          kind: "connected",
          profileId: candidate.profileId,
          accountId: mutation.accountId,
          login: mutation.login,
          refreshToken: candidate.tokens.refreshToken,
          scopes: candidate.tokens.scopes,
          accessExpiresAtMs: candidate.receivedAtMs + candidate.tokens.expiresInSeconds * 1000,
          refreshExpiresAtMs:
            candidate.receivedAtMs + candidate.tokens.refreshTokenExpiresInSeconds * 1000,
        },
      };
    }
    case "expire":
      return current?.pending && current.pending.expiresAtMs <= mutation.nowMs
        ? { ...current, pending: undefined }
        : undefined;
    case "beginRefresh":
      if (
        current?.generation !== mutation.generation ||
        current.selection.kind !== "connected" ||
        current.selection.profileId !== mutation.profileId
      ) {
        throw new Error("My GitHub selection changed.");
      }
      return {
        ...current,
        selection: { ...current.selection, refresh: { operationId: mutation.operationId } },
      };
  }
  throw new Error("Unknown personal GitHub connection mutation.");
}

function mutate<T>(
  context: WorkerWriteOperationContext,
  operation: (
    db: ReturnType<WorkerWriteOperationContext["open"]>["db"],
    retire: (ids: string[]) => void,
  ) => T,
): T {
  return context.write(
    ({ db }) => {
      requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
      const retiredProfileIds: string[] = [];
      const result = operation(db, (ids) => retiredProfileIds.push(...ids));
      requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
      const receipt: UserGitHubConnectionCommit = {
        kind: "user-github-connection",
        retiredProfileIds,
      };
      deferSqliteWorkerCommitReceipt(db, receipt);
      return result;
    },
    { operationLabel: "users.github.mutate" },
  );
}

export const userGitHubConnectionOperations = {
  "userGitHubConnections.read": ({ owner }: { owner: string }, { open }) =>
    readUserGitHubConnectionInDatabase(open().db, owner),
  "userGitHubConnections.list": (_input: undefined, { open }) =>
    listUserGitHubConnectionsInDatabase(open().db),
  "userGitHubConnections.mutate": (
    input: { owner: string; mutation: UserGitHubConnectionMutation },
    context,
  ) => {
    // A matching request is still reread under the write transaction.
    if (
      input.mutation.kind === "cancel" &&
      readUserGitHubConnectionInDatabase(context.open().db, input.owner)?.pending?.requestId !==
        input.mutation.requestId
    ) {
      return undefined;
    }
    return mutate(context, (db, retire) => {
      const { owner, mutation } = input;
      if (mutation.kind === "disconnect") {
        return disconnectUserGitHubConnectionInDatabase(db, owner, retire);
      }
      if (mutation.kind === "cancel") {
        return cancelUserGitHubAuthorizationInDatabase(db, owner, mutation.requestId, retire);
      }
      const current = readUserGitHubConnectionInDatabase(db, owner);
      const next = applyMutation(current, mutation);
      return next
        ? writeUserGitHubConnectionInDatabase(db, owner, next, current, retire)
        : undefined;
    });
  },
  "userGitHubConnections.refresh": (input: UserGitHubRefreshMutation, context) =>
    mutate(context, (db, retire) => {
      const resolved = readCanonicalUserGitHubConnectionInDatabase(db, input.owner);
      if (!resolved) {
        return false;
      }
      const { owner, connection: current } = resolved;
      const selection = current?.selection;
      if (
        !current ||
        selection?.kind !== "connected" ||
        selection.profileId !== input.profileId ||
        selection.refresh?.operationId !== input.operationId
      ) {
        return false;
      }
      const result = input.result;
      const next =
        result.kind === "rotated"
          ? {
              ...selection,
              refreshToken: result.tokens.refreshToken,
              scopes: result.tokens.scopes,
              accessExpiresAtMs: result.receivedAtMs + result.tokens.expiresInSeconds * 1000,
              refreshExpiresAtMs:
                result.receivedAtMs + result.tokens.refreshTokenExpiresInSeconds * 1000,
              refreshFailure: undefined,
              refresh: {
                operationId: input.operationId,
                tokens: result.tokens,
                receivedAtMs: result.receivedAtMs,
              },
            }
          : {
              ...selection,
              refresh: undefined,
              ...(result.kind === "materialized"
                ? { login: result.login, refreshFailure: undefined }
                : { refreshFailure: result.failure }),
            };
      writeUserGitHubConnectionInDatabase(
        db,
        owner,
        { ...current, selection: next },
        current,
        retire,
      );
      return true;
    }),
} satisfies WorkerOperationHandlers<WorkerWriteOperationContext>;

export type UserGitHubConnectionWorkerOperations = WorkerOperations<
  typeof userGitHubConnectionOperations
>;
