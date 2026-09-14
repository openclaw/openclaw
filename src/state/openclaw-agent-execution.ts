import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { runtimeProcessEntrypoints } from "../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import {
  createSqliteWorkerOperationAdmission,
  type SqliteWorkerAdmissionFactory,
} from "../infra/sqlite-worker-operation-admission.js";
import {
  closeUnclaimedSharedStateSqliteWorkers,
  isSqliteWorkerStoreAvailable,
  openAgentDatabaseSqliteWorkerStore,
  runSqliteWorkerStoreOperation,
  type SqliteWorkerStore,
} from "../infra/sqlite-worker-store.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { assertAgentDatabaseAdmitted } from "./agent-database-admission.js";
import { getAgentDeletionDatabaseCleanup } from "./agent-deletion-cleanup.js";
import type { OpenClawAgentDatabaseOptions } from "./openclaw-agent-db-contract.js";
import {
  hasAgentDatabaseMaintenanceAuthority,
  type OpenClawAgentDatabaseWorkerLeaseReceipt,
} from "./openclaw-agent-db-lease.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "./openclaw-agent-db-resources.js";
import {
  isIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "./openclaw-agent-db.paths.js";
import { cleanupRetiredAgentDatabaseLease } from "./openclaw-agent-execution-cleanup.js";
import type {
  AgentDatabaseExecutionIdentity,
  AgentDatabaseExecutionOpen,
  AgentDatabaseExecutionSource,
  AgentDatabaseOperations,
} from "./openclaw-agent-execution-contract.js";
import {
  publishOpenClawStateDatabaseWorkerAdmission,
  registerOpenClawStateDatabaseAsyncResource,
} from "./openclaw-state-db-cache.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";

type Store = SqliteWorkerStore<AgentDatabaseOperations>;
type AgentDatabaseExecutionScope = Pick<Store, "execute">;
export type OpenClawAgentDatabaseExecution = {
  readonly agentId: string;
  readonly path: string;
  assertCurrent(): void;
  run<T>(
    source: AgentDatabaseExecutionSource | undefined,
    operation: (scope: AgentDatabaseExecutionScope) => Promise<T>,
  ): Promise<T>;
  close(): Promise<void>;
};

// References are derived; the canonical agent and shared resource owners govern retirement.
const executions = new Map<string, OpenClawAgentDatabaseExecution>();

/** These native-only scopes still need their complete owning caller cutover. */
export function supportsOpenClawAgentDatabaseExecution(
  options: OpenClawAgentDatabaseOptions,
): boolean {
  return (
    !isIncognitoOpenClawAgentSqlitePath(resolveOpenClawAgentSqlitePath(options), options) &&
    !hasAgentDatabaseMaintenanceAuthority() &&
    !getAgentDeletionDatabaseCleanup(options)
  );
}

/** Capture the existing lifecycle before callers yield; native opening stays lazy. */
export function captureOpenClawAgentDatabaseExecution(
  options: OpenClawAgentDatabaseOptions,
): OpenClawAgentDatabaseExecution {
  const agentId = normalizeAgentId(options.agentId);
  const pathname = resolveOpenClawAgentSqlitePath(options);
  if (!supportsOpenClawAgentDatabaseExecution(options)) {
    throw new Error("This agent database scope still requires its existing native owner");
  }
  const existing = executions.get(pathname);
  if (existing) {
    if (existing.agentId !== agentId) {
      throw new Error(
        `OpenClaw agent database ${pathname} is already open for agent ${existing.agentId}; requested agent ${agentId}.`,
      );
    }
    existing.assertCurrent();
    return existing;
  }
  const context = captureOpenClawStateWorkerContext({ env: options.env });
  const input: AgentDatabaseExecutionOpen = {
    leaseId: randomUUID(),
    agentId,
    databasePath: pathname,
    stateDatabasePath: context.admission.databasePath,
    environment: context.environment,
  };
  const executionOptions = { agentId, path: pathname, env: input.environment };
  let retired = false;
  let opening: Promise<Store> | undefined;
  let openedStore: Store | undefined;
  let openingFailed = false;
  let closing: Promise<void> | undefined;
  let nativeIdentity: AgentDatabaseExecutionIdentity | undefined;
  let nativeStopped: Promise<void> | undefined;
  let lease: OpenClawAgentDatabaseWorkerLeaseReceipt | undefined;
  let unregisterShared: (() => void) | undefined;

  const assertCurrent = () => {
    if (
      retired ||
      executions.get(pathname) !== owner ||
      !supportsOpenClawAgentDatabaseExecution(executionOptions)
    ) {
      throw new Error("Agent database execution admission is closed");
    }
    context.admission.assertCurrent();
    if (openedStore && !isSqliteWorkerStoreAvailable(openedStore)) {
      throw new Error("Agent database execution lost its native owner");
    }
    assertAgentDatabaseAdmitted(input.agentId, { env: input.environment });
  };
  const admission =
    (source?: AgentDatabaseExecutionSource): SqliteWorkerAdmissionFactory =>
    (operation) => ({
      nativeLocations: [
        pathname,
        ...(nativeIdentity ? [nativeIdentity.nativeLocation] : []),
        context.admission.databasePath,
        context.admission.identity.canonicalPath,
      ],
      admission: createSqliteWorkerOperationAdmission((request, grant) => {
        assertCurrent();
        const facts = request.facts;
        if (request.stage === "prepare" && isRecord(facts) && facts.kind === "shared-owner") {
          source?.assertCurrent();
          publishOpenClawStateDatabaseWorkerAdmission(context.admission);
          const received = facts.lease;
          if (
            !isDeepStrictEqual(facts.identity, context.admission.identity) ||
            !isRecord(received) ||
            received.leaseId !== input.leaseId ||
            received.agentId !== input.agentId ||
            received.path !== pathname ||
            received.ownerPid !== process.pid ||
            (received.ownerStartTime !== null && typeof received.ownerStartTime !== "number") ||
            received.sharedStatePath !== context.admission.databasePath ||
            received.sharedStateIdentity !== context.admission.identity.key
          ) {
            throw new Error("Agent worker lease differs from its captured native owner");
          }
          lease = {
            leaseId: input.leaseId,
            agentId: input.agentId,
            path: pathname,
            ownerPid: process.pid,
            ownerStartTime: received.ownerStartTime,
            sharedStatePath: context.admission.databasePath,
            sharedStateIdentity: context.admission.identity.key,
          };
          grant();
          return;
        }
        if (request.stage === "open") {
          if (!isDeepStrictEqual(facts, input)) {
            throw new Error("Agent database open differs from its captured owner");
          }
        } else if (
          !isRecord(facts) ||
          (nativeIdentity && !isDeepStrictEqual(facts.identity, nativeIdentity))
        ) {
          throw new Error("Agent database operation belongs to another native owner");
        }
        const grantCurrent = () => {
          assertCurrent();
          return grant();
        };
        if (source && (request.stage === "transaction" || request.stage === "open")) {
          source.admitTransaction(operation, grantCurrent);
        } else {
          source?.assertCurrent();
          grantCurrent();
        }
      }),
    });
  const open = (source?: AgentDatabaseExecutionSource): Promise<Store> => {
    assertCurrent();
    source?.assertCurrent();
    opening ??= (async () => {
      const store = await openAgentDatabaseSqliteWorkerStore<AgentDatabaseOperations>(
        {
          moduleUrl: resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.agentDatabaseExecution),
          databasePath: pathname,
          input,
        },
        {
          stateContext: context,
          stateDatabasePath: context.admission.databasePath,
          assertCurrent,
          createAdmission: admission(source),
          onNativeStopped: (stopped) => {
            nativeStopped = stopped;
          },
        },
      );
      if (!store) {
        throw new Error("Agent database execution did not open its canonical owner");
      }
      openedStore = store;
      try {
        assertCurrent();
        nativeIdentity = await runSqliteWorkerStoreOperation(
          store,
          (scope) => scope.execute({ type: "database.identity", input: undefined }),
          context,
          assertCurrent,
          admission(source),
        );
        return store;
      } catch (error) {
        try {
          await store.close();
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], "Agent open and cleanup failed", {
            cause: cleanupError,
          });
        }
        throw error;
      }
    })().catch((error: unknown) => {
      openingFailed = true;
      throw error;
    });
    return opening;
  };
  const owner: OpenClawAgentDatabaseExecution = {
    agentId: input.agentId,
    path: pathname,
    assertCurrent,
    async run(source, operation) {
      try {
        const store = await open(source);
        assertCurrent();
        return await runSqliteWorkerStoreOperation(
          store,
          operation,
          context,
          assertCurrent,
          admission(source),
        );
      } catch (error) {
        if (openingFailed || (openedStore && !isSqliteWorkerStoreAvailable(openedStore))) {
          try {
            await owner.close();
          } catch (cleanupError) {
            throw new AggregateError([error, cleanupError], "Agent operation and cleanup failed", {
              cause: cleanupError,
            });
          }
        }
        throw error;
      }
    },
    close() {
      retired = true;
      closing ??= (async () => {
        const errors: unknown[] = [];
        if (opening) {
          try {
            await opening.then(
              (store) => store.close(),
              () => closeUnclaimedSharedStateSqliteWorkers(pathname),
            );
          } catch (error) {
            errors.push(error);
          }
        }
        if (nativeStopped && lease) {
          try {
            await cleanupRetiredAgentDatabaseLease({
              context,
              stopped: nativeStopped,
              assertOwned() {
                if (executions.get(pathname) !== owner || !retired) {
                  throw new Error("Agent cleanup no longer owns its original execution reference");
                }
              },
              lease,
            });
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length === 1) {
          throw errors[0];
        }
        if (errors.length > 1) {
          throw new AggregateError(errors, "Agent native close and lease cleanup failed", {
            cause: errors[0],
          });
        }
        if (executions.get(pathname) === owner) {
          executions.delete(pathname);
        }
        unregisterAgent?.();
        unregisterShared?.();
      })().catch((error: unknown) => {
        closing = undefined;
        throw error;
      });
      return closing;
    },
  };
  const unregisterAgent = registerOpenClawAgentDatabaseAsyncResource({
    agentId,
    path: pathname,
    revoke() {
      retired = true;
    },
    close: () => owner.close(),
  });
  try {
    unregisterShared = registerOpenClawStateDatabaseAsyncResource({
      close: async (identity) => {
        if (!identity || identity.key === context.admission.identity.key) {
          await owner.close();
        }
      },
    });
  } catch (error) {
    unregisterAgent();
    throw error;
  }
  executions.set(pathname, owner);
  return owner;
}
